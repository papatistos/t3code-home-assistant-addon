"""Move provider HOME to the shared HA config mount before any provider starts."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid


MARKER = '.t3code-storage-migration.json'


def exists(path):
    return os.path.lexists(path)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    with path.open('x') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(path.parent)


def protect_git(config):
    def git(*args):
        return subprocess.run(['git', '-c', f'safe.directory={config}', '-C', str(config), *args], capture_output=True, text=True)
    root = git('rev-parse', '--show-toplevel')
    if root.returncode:
        if 'not a git repository' in root.stderr:
            return
        raise RuntimeError('Cannot inspect HA configuration Git repository')
    if Path(root.stdout.strip()).resolve() != config.resolve():
        raise RuntimeError('HA config is inside another Git repository; refusing migration')
    tracked = git('ls-files', '--', '.t3code')
    if tracked.returncode or tracked.stdout:
        raise RuntimeError('Cannot exclude provider data: .t3code is tracked or Git inspection failed')
    result = git('rev-parse', '--git-path', 'info/exclude')
    if result.returncode:
        raise RuntimeError('Cannot locate Git exclusions')
    exclude = Path(result.stdout.strip())
    if not exclude.is_absolute():
        exclude = config / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    if not exclude.exists() or '/.t3code/' not in exclude.read_text().splitlines():
        with exclude.open('a') as stream:
            stream.write('\n# Private provider state\n/.t3code/\n')
    if git('check-ignore', '-q', '.t3code/provider-home/.credential-check').returncode:
        raise RuntimeError('Git rules override the private provider storage exclusion')


def migrate(data, config):
    home = data / 'home'
    backup = data / 'home.before-shared-storage'
    parent = config / '.t3code'
    target = parent / 'provider-home'
    journal = data / 'provider-home-migration.json'
    if not config.is_dir() or config.is_symlink():
        raise RuntimeError('HA config mount is missing or is a symlink')
    if parent.is_symlink() or target.is_symlink():
        raise RuntimeError('Shared provider storage must not be a symlink')
    protect_git(config)
    if home.is_symlink():
        if home.resolve() != target or not target.is_dir():
            raise RuntimeError('Provider HOME has an unexpected or broken symlink')
        if not journal.is_file() or json.loads(journal.read_text()) != json.loads((target / MARKER).read_text()):
            raise RuntimeError('Provider storage migration identity does not match')
        return
    if exists(home) and not home.is_dir():
        raise RuntimeError('Provider HOME is not a directory')
    if exists(backup) and exists(home):
        raise RuntimeError('Both original HOME and migration backup exist; refusing to choose')
    if not journal.exists():
        if exists(target) or exists(backup):
            raise RuntimeError('Shared provider storage or backup already exists; refusing to overwrite')
        write_json(journal, {'version': 1, 'id': str(uuid.uuid4())})
    identity = json.loads(journal.read_text())
    if identity.get('version') != 1 or not identity.get('id'):
        raise RuntimeError('Invalid migration journal')
    parent.mkdir(mode=0o700, exist_ok=True)
    if exists(target):
        if not target.is_dir() or json.loads((target / MARKER).read_text()) != identity:
            raise RuntimeError('Existing destination does not belong to this migration')
    else:
        if exists(backup):
            raise RuntimeError('Published provider storage is missing; refusing stale backup restore')
        stage = Path(tempfile.mkdtemp(prefix='.provider-home-copy-', dir=parent))
        if home.exists():
            if exists(home / MARKER):
                raise RuntimeError('Original HOME contains a reserved migration marker')
            # Relative links leaving HOME would change meaning after relocation.
            for directory, dirs, files in os.walk(home, followlinks=False):
                for name in dirs + files:
                    entry = Path(directory) / name
                    if entry.is_symlink() and not os.path.isabs(os.readlink(entry)):
                        if not entry.resolve().is_relative_to(home.resolve()):
                            raise RuntimeError(f'Cannot relocate external relative symlink: {entry}')
            shutil.copytree(home, stage, symlinks=True, dirs_exist_ok=True)
        stage.chmod(0o700)
        for directory, dirs, files in os.walk(stage, followlinks=False):
            for name in files:
                entry = Path(directory) / name
                if not entry.is_symlink():
                    with entry.open('rb') as stream:
                        os.fsync(stream.fileno())
            sync_dir(directory)
        write_json(stage / MARKER, identity)
        stage.rename(target)
        sync_dir(parent)
    if home.exists():
        home.rename(backup)
        sync_dir(data)
    home.symlink_to(target, target_is_directory=True)
    sync_dir(data)
    print('Provider HOME is now in /config/.t3code/provider-home; original data retained in /data/home.before-shared-storage')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=Path('/data'))
    parser.add_argument('--config', type=Path, default=Path('/config'))
    args = parser.parse_args()
    os.umask(0o077)
    # Supervisor supplies /data. Never invent a missing mount.
    with (args.data / 'provider-storage.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        migrate(args.data.absolute(), args.config.absolute())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'Provider storage migration refused; providers were not started: {error}')
