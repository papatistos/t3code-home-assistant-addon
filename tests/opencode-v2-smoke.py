#!/usr/bin/env python3
"""Exercise the real v2 CLI with disposable HOME and fictional credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

binary = str(Path(sys.argv[1]).resolve()) if len(sys.argv) > 1 else '/usr/local/bin/opencode'
with tempfile.TemporaryDirectory(prefix='opencode-v2-smoke-') as home:
    env = {'PATH': os.environ['PATH'], 'HOME': home}
    for kind in ['CONFIG', 'DATA', 'STATE', 'CACHE']:
        env[f'XDG_{kind}_HOME'] = f'{home}/{kind.lower()}'

    def run(*args):
        result = subprocess.run([binary, *args], cwd=home, env=env,
                                text=True, capture_output=True, timeout=90)
        assert result.returncode == 0, (args, result.stderr[-2000:])
        return result.stdout

    auth = Path(home) / 'data/opencode/auth.json'
    auth.parent.mkdir(parents=True)
    auth.write_text(json.dumps({
        'openai': {'type': 'oauth', 'access': 'fictional-access',
                   'refresh': 'fictional-refresh', 'expires': 4102444800000},
        'anthropic': {'type': 'api', 'key': 'fictional-key'},
    }))
    config = Path(home) / 'config/opencode/opencode.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'mcp': {'home-assistant': {
        'type': 'local', 'command': ['/usr/local/bin/ha-mcp-server'], 'enabled': True,
    }}}))
    assert run('--version').strip() == 'opencode v2.3.0'
    sources = json.loads(run('debug', 'config', '--standalone'))
    document = next(item for item in sources if item.get('path') == str(config))
    server = document['info']['mcp']['servers']['home-assistant']
    assert server['command'] == ['/usr/local/bin/ha-mcp-server']
    assert server['disabled'] is False
    args = ('auth', 'list', '--format', 'json', '--standalone')
    raw = run(*args)
    assert 'fictional-' not in raw
    accounts = json.loads(raw)
    openai = next(item for item in accounts if item['id'] == 'openai')
    credential = openai['connections'][0]
    assert credential['type'] == 'credential' and credential['method'] == 'oauth'
    assert credential['id'].startswith('cred_')
    run('auth', 'logout', 'openai', credential['id'], '--standalone')
    remaining = json.loads(run(*args))
    assert not any(item['id'] == 'openai' for item in remaining)
    assert any(item['id'] == 'anthropic' for item in remaining)
    print('PASS: OpenCode 2.3.0 imports legacy auth, reports safe metadata, and logs out only the selected account')
