import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../t3code/rootfs/opt/t3code/provider-storage.py', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-storage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  const home = path.join(data, 'home');
  const target = path.join(config, '.t3code/provider-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config);
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/AGENTS.md'), 'Preserve åäö instructions');
  fs.writeFileSync(path.join(home, '.codex/session.jsonl'), '{"turn":1}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.claude.json'), '{"credential":"fictional"}');
  return { root, data, config, home, target,
    run: () => spawnSync('python3', [script, '--data', data, '--config', config], { encoding: 'utf8' }) };
}
function success(f) {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
}

test('migrates instructions, sessions, credentials and modes; preserves original and stable paths', t => {
  const f = fixture(t);
  fs.symlinkSync('.codex/AGENTS.md', path.join(f.home, 'instructions'));
  success(f);
  assert.equal(fs.readlinkSync(f.home), f.target);
  assert.equal(fs.readFileSync(path.join(f.target, '.codex/AGENTS.md'), 'utf8'), 'Preserve åäö instructions');
  assert.equal(fs.readFileSync(path.join(f.home, 'instructions'), 'utf8'), 'Preserve åäö instructions');
  assert.equal(fs.statSync(path.join(f.target, '.codex/session.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(f.data, 'home.before-shared-storage/.claude.json'), 'utf8'), '{"credential":"fictional"}');
  fs.writeFileSync(path.join(f.home, '.codex/session.jsonl'), 'new session');
  success(f);
  assert.equal(fs.readFileSync(path.join(f.target, '.codex/session.jsonl'), 'utf8'), 'new session');
});

test('initializes a fresh install with no previous HOME', t => {
  const f = fixture(t);
  fs.rmSync(f.home, { recursive: true });
  success(f);
  assert.ok(fs.statSync(f.home).isDirectory());
});

test('refuses a pre-existing destination without changing either copy', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, 'keep'), 'existing');
  assert.notEqual(f.run().status, 0);
  assert.ok(!fs.lstatSync(f.home).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'existing');
});

test('refuses symlinked shared storage', t => {
  const f = fixture(t);
  fs.symlinkSync(f.data, path.join(f.config, '.t3code'));
  assert.notEqual(f.run().status, 0);
  assert.ok(!fs.lstatSync(f.home).isSymbolicLink());
});

test('refuses a missing config mount', t => {
  const f = fixture(t);
  fs.rmdirSync(f.config);
  assert.notEqual(f.run().status, 0);
  assert.ok(fs.existsSync(path.join(f.home, '.claude.json')));
});

test('refuses external relative links whose meaning would change', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, 'outside'), 'keep');
  fs.symlinkSync('../outside', path.join(f.home, 'outside'));
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.home, 'outside'), 'utf8'), 'keep');
});

test('resumes after destination publication but before original HOME rename', t => {
  const f = fixture(t);
  success(f);
  fs.unlinkSync(f.home);
  fs.renameSync(path.join(f.data, 'home.before-shared-storage'), f.home);
  success(f);
  assert.equal(fs.readlinkSync(f.home), f.target);
});

test('resumes after original HOME rename but before symlink creation', t => {
  const f = fixture(t);
  success(f);
  fs.unlinkSync(f.home);
  success(f);
  assert.equal(fs.readlinkSync(f.home), f.target);
});

test('does not silently restore a stale backup if shared storage is lost', t => {
  const f = fixture(t);
  success(f);
  fs.rmSync(f.target, { recursive: true });
  assert.notEqual(f.run().status, 0);
  fs.unlinkSync(f.home);
  assert.notEqual(f.run().status, 0);
  assert.ok(fs.existsSync(path.join(f.data, 'home.before-shared-storage/.claude.json')));
});

test('excludes provider secrets before copying into a Git project', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['init', '-q', f.config]).status, 0);
  success(f);
  const check = spawnSync('git', ['-C', f.config, 'check-ignore', '.t3code/provider-home/.claude.json']);
  assert.equal(check.status, 0);
});

test('refuses migration into tracked storage, including files outside provider-home', t => {
  const f = fixture(t);
  spawnSync('git', ['init', '-q', f.config]);
  fs.mkdirSync(path.join(f.config, '.t3code'));
  fs.writeFileSync(path.join(f.config, '.t3code/existing'), 'tracked');
  assert.equal(spawnSync('git', ['-C', f.config, 'add', '.t3code/existing']).status, 0);
  assert.notEqual(f.run().status, 0);
  assert.ok(!fs.lstatSync(f.home).isSymbolicLink());
});

test('a failed copy preserves the source and retries without publishing partial data', t => {
  const f = fixture(t);
  const fifo = path.join(f.home, 'unsupported-fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /named pipe/);
  assert.ok(!fs.existsSync(f.target));
  assert.equal(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8'), '{"credential":"fictional"}');
  fs.unlinkSync(fifo);
  success(f);
  assert.equal(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8'), '{"credential":"fictional"}');
});

test('a destination with a different migration identity is never adopted', t => {
  const f = fixture(t);
  success(f);
  fs.writeFileSync(path.join(f.target, '.t3code-storage-migration.json'), '{"version":1,"id":"different"}');
  assert.match(f.run().stderr, /identity does not match/);
});

test('refuses Git rules that override the private storage exclusion', t => {
  const f = fixture(t);
  spawnSync('git', ['init', '-q', f.config]);
  fs.writeFileSync(path.join(f.config, '.gitignore'), '!.t3code/\n!.t3code/**\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /override the private provider storage exclusion/);
  assert.ok(!fs.existsSync(f.target));
});
