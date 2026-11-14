import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Pi is pinned in the runtime manifest and lockfile', () => {
  const manifest = JSON.parse(read('t3code/package.json'));
  const lock = JSON.parse(read('t3code/package-lock.json'));
  const name = '@earendil-works/pi-coding-agent';
  const version = manifest.dependencies[name];
  assert.equal(version, '1.5.2');
  assert.equal(lock.packages[''].dependencies[name], version);
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/);
});

test('Pi is exposed and checked in the image and startup diagnostics', () => {
  assert.match(read('t3code/Dockerfile'), /for cli in claude codex opencode pi; do/);
  assert.match(read('t3code/Dockerfile'), /&& pi --version/);
  assert.match(read('t3code/rootfs/run.sh'), /for cli in claude codex opencode pi cloudflared ha ha-mcp; do/);
  assert.match(read('tests/container-smoke.py'), /docker\("exec", name, "pi", "--version"/);
});
