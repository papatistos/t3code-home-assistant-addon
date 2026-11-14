import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('the runtime bundles only OpenCode v2 with pinned Linux platform packages', () => {
  const manifest = JSON.parse(read('t3code/package.json'));
  const lock = JSON.parse(read('t3code/package-lock.json'));
  assert.equal(manifest.dependencies['@opencode/cli'], '2.3.0');
  assert.equal(manifest.dependencies['opencode-ai'], undefined);
  assert.equal(lock.packages['node_modules/opencode-ai'], undefined);
  assert.equal(lock.packages[''].dependencies['@opencode/cli'], '2.3.0');
  for (const name of ['@opencode/cli', '@opencode/cli-linux-x64', '@opencode/cli-linux-x64-baseline', '@opencode/cli-linux-arm64']) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, '2.3.0');
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.match(read('t3code/Dockerfile'), /&& opencode --version/);
});
