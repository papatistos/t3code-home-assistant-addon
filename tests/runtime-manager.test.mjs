import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RuntimeManager, command, newer, parseVersionOutput } from '../t3code/rootfs/opt/t3code/runtime-manager.mjs';

const modulePath = new URL('../t3code/rootfs/opt/t3code/runtime-manager.mjs', import.meta.url).href;
async function fixture(t, { behavior = 'ready', arch = 'x64' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-update-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'data');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'state'), 'original');
  const bundled = path.join(dir, 'bundled');
  await fs.writeFile(bundled, `#!${process.execPath}\nconsole.log('t3 v0.1.6');\n`, { mode: 0o700 });
  const source = path.join(dir, 't3-0.1.7-linux-' + arch);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 't3'), `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[2] === '--version') console.log('t3 v0.1.7');
else if (process.argv[2] === '__service-preflight') console.log(JSON.stringify({status:'ready',version:'0.1.7',launcherProtocol:3}));
else {
  fs.writeFileSync(process.env.T3CODE_HOME + '/state', 'migrated');
  const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT || '{}');
  if (${JSON.stringify(behavior)} === 'exit') process.exit(1);
  if (${JSON.stringify(behavior)} === 'ready' && context.update) process.send({type:'prepared',updateId:context.update.id});
  process.on('message', m => { if(m.type === 'committed') fs.writeFileSync(process.env.T3CODE_HOME + '/activated', 'yes'); });
  setInterval(()=>{},1000);
}
`, { mode: 0o700 });
  const archive = path.join(dir, 'release.tar.gz');
  await command('tar', ['-czf', archive, '-C', dir, path.basename(source)]);
  const hash = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const logs = [], downloads = [];
  const options = {
    root: path.join(dir, 'updates'), home, bundled, selection: path.join(dir, 'selected'),
    platform: 'linux', arch, trialTimeout: behavior === 'ready' ? 2000 : 200, log: s => logs.push(s),
  };
  const manager = new RuntimeManager(options);
  manager.fetch = async (url, destination) => {
    downloads.push(url);
    if (url === manager.latestURL) await fs.writeFile(destination, JSON.stringify({ tag_name: 'v0.1.7' }));
    else if (url.endsWith('/SHA256SUMS')) await fs.writeFile(destination, `${hash}  t3-0.1.7-linux-${arch}.tar.gz\n`);
    else await fs.copyFile(archive, destination);
  };
  return { dir, manager, home, logs, downloads, options };
}

for (const arch of ['x64', 'arm64']) test(`stages and validates the ${arch} release; commits only on prepared`, async t => {
  const f = await fixture(t, { arch });
  const s = await f.manager.prepare(true);
  assert.equal(s.active, 'bundled'); assert.equal(s.pending.version, '0.1.7');
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
  const child = f.manager.start('0.1.7', ['serve'], { ...s.pending, fromVersion: '0.1.6' });
  t.after(() => f.manager.stop(child));
  await f.manager.trial(child, s);
  assert.equal((await f.manager.load()).active, '0.1.7');
  assert.equal((await f.manager.load()).previous, undefined);
  await assert.rejects(fs.access(f.manager.snapshot(s.pending)), { code: 'ENOENT' });
  await f.manager.stop(child);
});

test('no update available makes no archive requests and never downgrades', async t => {
  const f = await fixture(t);
  await f.manager.prepare(true);
  const s = await f.manager.load(); await f.manager.commit(s);
  const before = f.downloads.length;
  await f.manager.prepare(true);
  assert.equal(f.downloads.length, before + 1);
  assert.match(f.logs.at(-1), /No newer stable release/);
  assert.equal(newer('0.1.6', '0.1.7'), false);
  assert.equal(newer('0.10.0', '0.9.9'), true);
});

test('disabled updates retain persistent selection after container replacement without network', async t => {
  const f = await fixture(t);
  await f.manager.commit(await f.manager.prepare(true));
  await fs.rm(f.manager.selection);
  const replacement = new RuntimeManager(f.options);
  replacement.fetch = () => assert.fail('network used while disabled');
  await replacement.prepare(false);
  assert.equal((await fs.readFile(f.manager.selection, 'utf8')).trim(), replacement.executable('0.1.7'));
});

for (const failure of ['offline', 'installation', 'checksum', 'digest', 'preflight', 'protocol', 'snapshot']) test(`${failure} failure retains bundled executable and existing data`, async t => {
  const f = await fixture(t);
  const fetch = f.manager.fetch.bind(f.manager);
  f.manager.fetch = async (url, dest, timeout) => {
    if (failure === 'offline' || (failure === 'installation' && url.endsWith('.tar.gz'))) throw new Error('secret credential must not be logged');
    await fetch(url, dest, timeout);
    if (failure === 'digest' && url.endsWith('/SHA256SUMS')) await fs.writeFile(dest, `${'0'.repeat(64)}  t3-0.1.7-linux-x64.tar.gz\n`);
    if (failure === 'checksum' && url.endsWith('/SHA256SUMS')) await fs.writeFile(dest, `{"secret":"value"}`);
  };
  if (failure === 'preflight' || failure === 'protocol') {
    const run = f.manager.run;
    f.manager.run = async (exe, args, timeout) => args[0] === '__service-preflight' ? JSON.stringify({status: failure === 'protocol' ? 'ready' : 'blocked', version:'0.1.7', launcherProtocol:4}) : run(exe, args, timeout);
  }
  if (failure === 'snapshot') f.manager.copyData = async () => { throw new Error('disk full'); };
  await f.manager.prepare(true);
  assert.equal((await f.manager.load()).active, 'bundled');
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
  assert.equal((await fs.readFile(f.manager.selection, 'utf8')).trim(), f.manager.bundled);
  assert.doesNotMatch(f.logs.join('\n'), /secret|credential/);
});

test('network subprocess deadline kills a stalled request promptly', async () => {
  const start = Date.now();
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 80));
  assert.ok(Date.now() - start < 2000);
});

for (const behavior of ['exit', 'hang']) test(`initial startup ${behavior} restores data and suppresses the failed version`, async t => {
  const f = await fixture(t, { behavior });
  const s = await f.manager.prepare(true);
  const child = f.manager.start('0.1.7', ['serve'], { ...s.pending, fromVersion: '0.1.6' });
  await assert.rejects(f.manager.trial(child, s));
  await f.manager.stop(child);
  await f.manager.rollback(await f.manager.load());
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
  assert.equal((await f.manager.load()).active, 'bundled');
  await f.manager.prepare(true);
  assert.equal((await f.manager.load()).pending, undefined);
  assert.match(f.logs.at(-1), /Skipping failed trial/);
});

test('interrupted migration restores snapshot before any next invocation, even with updates disabled', async t => {
  const f = await fixture(t);
  await f.manager.prepare(true);
  await fs.writeFile(path.join(f.home, 'state'), 'half-migrated');
  const replacement = new RuntimeManager(f.options);
  await replacement.prepare(false);
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
  assert.equal((await replacement.load()).active, 'bundled');
});

test('interrupted restore with missing live directory is recoverable', async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  await fs.rename(f.home, `${f.manager.snapshot(s.pending)}.failed`);
  await f.manager.prepare(false);
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
});

test('missing snapshot refuses executable rollback instead of opening migrated data', async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  await fs.rm(f.manager.snapshot(s.pending), { recursive: true });
  await assert.rejects(f.manager.prepare(false), /snapshot missing/);
});

test('prerelease does not become active', async t => {
  const f = await fixture(t);
  f.manager.fetch = async (_, dest) => fs.writeFile(dest, JSON.stringify({tag_name:'v0.2.0-nightly.1',prerelease:true}));
  await f.manager.prepare(true);
  assert.equal((await f.manager.load()).active, 'bundled');
});

test('corrupt persistent state refuses to guess an older executable', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.manager.root);
  await fs.writeFile(f.manager.statePath, '{"active":"../../evil"}');
  await assert.rejects(f.manager.prepare(false), /invalid update state/);
});

test('server relaunch uses committed selection and never checks for updates', async t => {
  const f = await fixture(t, { behavior: 'exit' });
  await f.manager.commit(await f.manager.prepare(true));
  const script = path.join(f.dir, 'supervisor.mjs');
  await fs.writeFile(script, `import { RuntimeManager } from ${JSON.stringify(modulePath)};
const manager = new RuntimeManager(${JSON.stringify(f.options)});
manager.fetch = () => { throw new Error('must not check'); };
await manager.serve(['serve'], { status:false, restartDelay:10 });`);
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => proc.kill('SIGTERM'));
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no relaunch')), 5000);
    proc.stdout.on('data', chunk => { output += chunk; if ((output.match(/Starting: t3 serve/g) || []).length >= 2) { clearTimeout(timer); resolve(); } });
    proc.once('error', reject);
  });
  proc.kill('SIGTERM'); await once(proc, 'exit');
  assert.match(output, /restarting selected runtime without an update check/);
  assert.equal((await f.manager.load()).active, '0.1.7');
});

test('the shared wrapper selects the same executable for version, project, and Connect commands', async t => {
  const f = await fixture(t);
  await f.manager.commit(await f.manager.prepare(true));
  const called = path.join(f.dir, 'calls');
  await fs.writeFile(f.manager.executable('0.1.7'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${called}'\n`, {mode:0o700});
  const wrapper = path.join(f.dir, 't3');
  const original = await fs.readFile(new URL('../t3code/rootfs/usr/local/bin/t3', import.meta.url), 'utf8');
  await fs.writeFile(wrapper, original.replaceAll('/run/t3-executable', f.manager.selection).replace('/opt/t3code-bundled/runtime/versions/0.1.6/t3', f.manager.bundled), {mode:0o700});
  for (const args of [['--version'], ['project','add','/config'], ['connect','status','--json'], ['connect','link','--headless'], ['connect','logout']]) await command(wrapper, args);
  assert.equal((await fs.readFile(called,'utf8')).split('\n').filter(Boolean).length, 5);
});

test('a crash after commit never restores the old database snapshot', async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  await f.manager.commit(s);
  await fs.writeFile(path.join(f.home,'state'), 'new user history');
  await f.manager.prepare(false);
  assert.equal(await fs.readFile(path.join(f.home,'state'),'utf8'), 'new user history');
  assert.equal((await f.manager.load()).active,'0.1.7');
});

test('a data symlink refuses an update before any selected-data mutation', async t => {
  const f = await fixture(t);
  const external = path.join(f.dir, 'external');
  await fs.writeFile(external,'untouched');
  await fs.symlink(external,path.join(f.home,'link'));
  await f.manager.prepare(true);
  assert.equal((await f.manager.load()).active,'bundled');
  assert.equal(await fs.readFile(external,'utf8'),'untouched');
});

test('the server supervisor automatically restores and launches the previous runtime after a failed trial', async t => {
  const f = await fixture(t, { behavior: 'exit' });
  await f.manager.prepare(true);
  const script = path.join(f.dir, 'fallback-supervisor.mjs');
  await fs.writeFile(script, `import { RuntimeManager } from ${JSON.stringify(modulePath)};
const manager = new RuntimeManager(${JSON.stringify(f.options)});
await manager.serve(['serve'], {status:false,restartDelay:10});`);
  const proc = spawn(process.execPath, [script], {stdio:['ignore','pipe','pipe']});
  t.after(() => proc.kill('SIGTERM'));
  t.after(() => proc.kill('SIGTERM'));
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fallback not launched')),5000);
    proc.stdout.on('data', chunk => {
      output += chunk;
      if(output.includes('Starting: t3 serve (bundled)')) { clearTimeout(timer); resolve(); }
    });
    proc.once('error',reject);
  });
  proc.kill('SIGTERM'); await once(proc,'exit');
  assert.equal((await f.manager.load()).active,'bundled');
  assert.equal((await f.manager.load()).rejected,'0.1.7');
  assert.equal(await fs.readFile(path.join(f.home,'state'),'utf8'),'original');
});

test('offline startup keeps an established persistent version and bounds the release request', async t => {
  const f = await fixture(t);
  await f.manager.commit(await f.manager.prepare(true));
  f.manager.fetch = async (_url, _dest, timeout) => {
    assert.equal(timeout, 8000);
    throw new Error('offline');
  };
  const s = await f.manager.prepare(true);
  assert.equal(s.active, '0.1.7');
  assert.equal((await fs.readFile(f.manager.selection, 'utf8')).trim(), f.manager.executable('0.1.7'));
  assert.match(f.logs.at(-1), /Release check failed or timed out/);
});

test('a failed later update drops obsolete recovery references', async t => {
  const f = await fixture(t);
  await f.manager.prepare(true);
  const trial = await f.manager.load();
  trial.previous = '0.1.5'; trial.snapshot = 'earlier-snapshot-id';
  await f.manager.save(trial);
  const restored = await f.manager.rollback(trial);
  assert.equal(restored.previous, undefined);
  assert.equal(restored.snapshot, undefined);
  assert.equal(restored.pending, undefined);
});

test('manual download leaves running selection and data untouched and creates no snapshot', async t => {
  const f = await fixture(t);
  await f.manager.prepare(false);
  const selected = await fs.readFile(f.manager.selection, 'utf8');
  f.manager.copyData = () => assert.fail('manual download must not copy live data');
  f.manager.start = () => assert.fail('manual download must not start or restart T3');
  const result = await f.manager.downloadUpdate();
  assert.equal(result.version, '0.1.7');
  assert.match(result.message, /Installing and restarting T3 now/);
  assert.equal(await fs.readFile(f.manager.selection,'utf8'), selected);
  assert.equal(await fs.readFile(path.join(f.home,'state'),'utf8'),'original');
  const s = await f.manager.load();
  assert.equal(s.active,'bundled'); assert.equal(s.requested,'0.1.7');
  assert.equal(s.pending, undefined);
  await assert.rejects(fs.access(path.join(f.manager.root,'snapshots')));
});

test('a manually downloaded update is applied after container replacement with auto updates disabled and no network', async t => {
  const f = await fixture(t);
  await f.manager.prepare(false);
  await f.manager.downloadUpdate();
  const replacement = new RuntimeManager(f.options);
  replacement.fetch = () => assert.fail('downloaded update must start offline');
  const s = await replacement.prepare(false);
  assert.equal(s.pending.version,'0.1.7');
  assert.equal(s.requested,undefined);
  assert.equal(s.active,'bundled');
  await replacement.rollback(s);
  await replacement.prepare(false);
  assert.equal((await replacement.load()).pending,undefined,'failed manual trial must not retry itself');
});

test('a failed manual download keeps the running version and does not queue an installation', async t => {
  const f = await fixture(t);
  await f.manager.prepare(false);
  f.manager.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(f.manager.downloadUpdate());
  assert.equal((await f.manager.load()).requested,undefined);
  assert.equal((await fs.readFile(f.manager.selection,'utf8')).trim(),f.manager.bundled);
});

test('manual check reports no newer release without changing the selection', async t => {
  const f = await fixture(t);
  await f.manager.commit(await f.manager.prepare(true));
  const result = await f.manager.downloadUpdate();
  assert.match(result.message,/0.1.7 is up to date/);
  assert.equal((await f.manager.load()).requested,undefined);
  assert.equal((await f.manager.load()).active,'0.1.7');
});

for (const behavior of ['ready','exit']) test(`manual update supervisor stops T3, snapshots stopped data, and ${behavior === 'ready' ? 'activates immediately' : 'restores after failed startup'}`, async t => {
  const f=await fixture(t,{behavior});
  await f.manager.prepare(false);
  await f.manager.downloadUpdate();
  // Record a final write during graceful shutdown. The backup must contain it.
  await fs.writeFile(f.manager.bundled, `#!${process.execPath}
import fs from 'node:fs';
if(process.argv[2] === '--version') console.log('t3 v0.1.6');
else {
  process.on('SIGTERM',()=>{fs.writeFileSync(process.env.T3CODE_HOME+'/state','shutdown flushed');process.exit(0);});
  setInterval(()=>{},1000);
}
`, {mode:0o700});
  const panel=path.join(f.dir,'manual-panel.mjs');
  await fs.writeFile(panel, `
process.on('message',m=>{if(m.type === 't3-update-result') console.log('MANUAL_RESULT '+JSON.stringify(m));});
setTimeout(()=>process.send({type:'apply-t3-update',id:'manual-test',version:'0.1.7'}),250);
setInterval(()=>{},1000);
`);
  const supervisor=path.join(f.dir,'manual-supervisor.mjs');
  await fs.writeFile(supervisor, `import { readFileSync } from 'node:fs';
import { RuntimeManager } from ${JSON.stringify(modulePath)};
const manager=new RuntimeManager(${JSON.stringify(f.options)});
const copyData=manager.copyData.bind(manager);
manager.copyData=async (source,destination)=>{
  if(destination.endsWith('.stage') && fsState(source)!=='shutdown flushed') throw new Error('shutdown write not in snapshot');
  await copyData(source,destination);
};
function fsState(source){return readFileSync(source+'/state','utf8');}
manager.fetch=()=>{throw new Error('download already installed; no network allowed');};
await manager.serve(['serve'],{restartDelay:10,panelCommand:[process.execPath,${JSON.stringify(panel)}]});`);
  const proc=spawn(process.execPath,[supervisor],{stdio:['ignore','pipe','pipe']});
  t.after(()=>proc.kill('SIGTERM'));
  let output='';
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('manual update did not finish: '+output)),7000);
    proc.stdout.on('data',chunk=>{
      output+=chunk;
      const match=/MANUAL_RESULT (\{[^\n]+\})/.exec(output);
      if(match){clearTimeout(timer);resolve(JSON.parse(match[1]));}
    });
    proc.once('error',reject);
  });
  const s=await f.manager.load();
  assert.equal(result.ok,behavior==='ready');
  assert.equal(s.active,behavior==='ready'?'0.1.7':'bundled');
  assert.deepEqual(await fs.readdir(path.join(f.manager.root,'snapshots')), []);
  if(behavior==='exit') assert.equal(await fs.readFile(path.join(f.home,'state'),'utf8'),'shutdown flushed');
  proc.kill('SIGTERM');await once(proc,'exit');
});


async function put(p, value = 'leftover') {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, value);
}
async function gone(p) {
  await assert.rejects(fs.access(p), { code: 'ENOENT' });
}

test('activation saves the new selection before removing snapshot and old runtimes', async t => {
  const f = await fixture(t);
  await put(path.join(f.manager.root, 'versions', '0.1.5', 't3'));
  await f.manager.save({ active: '0.1.5', rejected: '0.1.4' });
  const s = await f.manager.prepare(true);
  const remove = f.manager.removeUnused.bind(f.manager);
  f.manager.removeUnused = async p => {
    assert.deepEqual(await f.manager.load(), { active: '0.1.7', rejected: '0.1.4' });
    await remove(p);
  };
  await f.manager.commit(s);
  await gone(f.manager.snapshot(s.pending));
  assert.deepEqual(await fs.readdir(path.join(f.manager.root, 'versions')), ['0.1.7']);
  assert.equal(await fs.readFile(f.manager.bundled, 'utf8'), `#!${process.execPath}\nconsole.log('t3 v0.1.6');\n`);
});

test('rollback saves restored state before removing trial snapshot and restore and failed copies', async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  await fs.writeFile(path.join(f.home, 'state'), 'broken');
  const snapshot = f.manager.snapshot(s.pending);
  const remove = f.manager.removeUnused.bind(f.manager);
  f.manager.removeUnused = async p => {
    assert.equal((await f.manager.load()).pending, undefined);
    assert.equal((await f.manager.load()).rejected, '0.1.7');
    assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
    await remove(p);
  };
  await f.manager.rollback(s);
  for (const p of [snapshot, `${snapshot}.restore`, `${snapshot}.failed`, path.dirname(f.manager.executable('0.1.7'))]) await gone(p);
});

test('startup sweeps interrupted copies and obsolete references while preserving active data', async t => {
  const f = await fixture(t);
  await f.manager.commit(await f.manager.prepare(true));
  await f.manager.save({ active: '0.1.7', previous: 'bundled', snapshot: 'old', rejected: '0.1.8' });
  const leftovers = [
    'snapshots/old/state', 'snapshots/partial.stage/state', 'snapshots/old.restore/state',
    'snapshots/old.failed/state', 'versions/.stage-abandoned/archive', 'versions/0.1.5/t3',
    'versions/0.1.8/t3', 'versions/partial.stage/archive', 'latest.json',
    '.stage-interrupted/archive', 'old.stage/state', 'old.restore/state', 'old.failed/state',
  ];
  for (const name of leftovers) await put(path.join(f.manager.root, name));
  await f.manager.prepare(false);
  for (const name of leftovers) await gone(path.join(f.manager.root, name));
  assert.deepEqual(await f.manager.load(), { active: '0.1.7', rejected: '0.1.8' });
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(path.join(f.manager.root, 'versions')), ['0.1.7']);
});

test('cleanup leaves every file intact while a trial is pending', async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  const snapshot = f.manager.snapshot(s.pending);
  await put(`${snapshot}.restore/state`);
  await put(`${snapshot}.failed/state`);
  await f.manager.cleanup(s);
  assert.equal(await fs.readFile(path.join(snapshot, 'state'), 'utf8'), 'original');
  for (const p of [`${snapshot}.restore/state`, `${snapshot}.failed/state`, f.manager.executable(s.pending.version), f.manager.bundled]) await fs.access(p);
  assert.deepEqual(await f.manager.load(), s);
});

for (const action of ['commit', 'rollback']) test(`startup finishes cleanup after a crash following ${action} state save`, async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  await fs.writeFile(path.join(f.home, 'state'), 'new history');
  f.manager.cleanup = async () => { throw new Error('simulated power cut before deletion'); };
  await assert.rejects(f.manager[action](s), /simulated power cut/);
  await fs.access(f.manager.snapshot(s.pending));
  const replacement = new RuntimeManager(f.options);
  await replacement.prepare(false);
  assert.equal((await replacement.load()).active, action === 'commit' ? '0.1.7' : 'bundled');
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), action === 'commit' ? 'new history' : 'original');
  await gone(f.manager.snapshot(s.pending));
  await fs.access(replacement.executable((await replacement.load()).active));
});

for (const action of ['commit', 'rollback']) test(`${action} keeps recovery files if durable state save fails`, async t => {
  const f = await fixture(t);
  const s = await f.manager.prepare(true);
  f.manager.save = async () => { throw new Error('state write failed'); };
  await assert.rejects(f.manager[action](s), /state write failed/);
  assert.deepEqual(await f.manager.load(), s);
  await fs.access(f.manager.snapshot(s.pending));
  await fs.access(f.manager.executable(s.pending.version));
  const replacement = new RuntimeManager(f.options);
  await replacement.prepare(false);
  assert.equal(await fs.readFile(path.join(f.home, 'state'), 'utf8'), 'original');
});

test('cleanup deletion failure is logged, does not block startup, and is retried', async t => {
  const f = await fixture(t);
  const blocked = path.join(f.manager.root, 'snapshots', 'old');
  await put(path.join(blocked, 'state'));
  await put(path.join(f.manager.root, 'versions', '0.1.5', 't3'));
  const remove = f.manager.removeUnused.bind(f.manager);
  f.manager.removeUnused = async p => { if (p === blocked) throw new Error('permission denied: secret'); await remove(p); };
  await f.manager.prepare(false);
  await fs.access(blocked);
  await gone(path.join(f.manager.root, 'versions', '0.1.5'));
  assert.match(f.logs.join('\n'), /Cleanup failed/);
  assert.doesNotMatch(f.logs.join('\n'), /secret|permission denied/);
  assert.equal((await fs.readFile(f.manager.selection, 'utf8')).trim(), f.manager.bundled);
  await new RuntimeManager(f.options).prepare(false);
  await gone(blocked);
});

test('cleanup listing failure does not block startup or other cleanup', async t => {
  const f = await fixture(t);
  await put(path.join(f.manager.root, 'snapshots'));
  await put(path.join(f.manager.root, 'latest.json'));
  await f.manager.prepare(false);
  await gone(path.join(f.manager.root, 'latest.json'));
  assert.match(f.logs.join('\n'), /Cleanup failed/);
});


test('failure to save obsolete recovery references does not block startup or delete copies', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.manager.root);
  const state = { active: 'bundled', previous: '0.1.5', snapshot: 'old' };
  await f.manager.save(state);
  await put(path.join(f.manager.root, 'snapshots', 'old', 'state'));
  f.manager.save = async () => { throw new Error('disk full'); };
  await f.manager.prepare(false);
  assert.deepEqual(await f.manager.load(), state);
  await fs.access(path.join(f.manager.root, 'snapshots', 'old', 'state'));
  assert.equal((await fs.readFile(f.manager.selection, 'utf8')).trim(), f.manager.bundled);
  assert.match(f.logs.join('\n'), /Cleanup state could not be saved/);
});


test('legacy home runtime stays in snapshots and survives startup cleanup', async t => {
  const f = await fixture(t);
  await put(path.join(f.home, 'runtime', 'versions', '0.1.6', 't3'), 'legacy runtime');
  const s = await f.manager.prepare(true);
  assert.equal(await fs.readFile(path.join(f.manager.snapshot(s.pending), 'runtime', 'versions', '0.1.6', 't3'), 'utf8'), 'legacy runtime');
  await f.manager.commit(s);
  await f.manager.prepare(false);
  assert.equal(await fs.readFile(path.join(f.home, 'runtime', 'versions', '0.1.6', 't3'), 'utf8'), 'legacy runtime');
});

test('version output from real T3 executables is parsed, and anything else is refused', () => {
  assert.equal(parseVersionOutput('t3 v0.1.7\n'), '0.1.7');
  assert.equal(parseVersionOutput('0.1.6'), '0.1.6');
  assert.equal(parseVersionOutput('v0.1.6'), '0.1.6');
  for (const bad of ['', 't3 v0.1', 'warning: x\nt3 v0.1.7', 't3 v0.1.7-beta.1', 'node v22.1.0'])
    assert.throws(() => parseVersionOutput(bad));
});
