// Automatic checks run only at container startup. Manual requests explicitly trigger an update.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const stable = v => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export function newer(a, b) {
  if (!stable(a) || !stable(b)) throw new Error('invalid version');
  const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const exists = async p => fs.access(p).then(() => true, () => false);
async function syncDir(p) {
  const h = await fs.open(p, 'r');
  try { await h.sync(); } finally { await h.close(); }
}
async function syncTree(p) {
  const stat = await fs.lstat(p);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(p)) await syncTree(path.join(p, name));
    await syncDir(p);
  } else if (stat.isFile()) {
    const h = await fs.open(p, 'r+');
    try { await h.sync(); } finally { await h.close(); }
  }
}
async function atomic(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${randomUUID()}`;
  const h = await fs.open(tmp, 'wx', 0o600);
  try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, p);
  await syncDir(path.dirname(p));
}
// Errors deliberately omit command output, URLs, and environment variables.
export async function command(exe, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { if (output.length < 1024 * 1024) output += b; });
    child.stderr.resume();
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeout);
    child.on('error', () => { clearTimeout(timer); reject(new Error('command unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error('command failed or timed out'));
    });
  });
}

export class RuntimeManager {
  constructor(options = {}) {
    Object.assign(this, {
      root: '/data/t3-updates', home: '/data/t3code',
      bundled: '/opt/t3code-bundled/runtime/versions/0.1.6/t3',
      selection: '/run/t3-executable',
      latestURL: 'https://api.github.com/repos/pingdotgg/t3code/releases/latest',
      releaseURL: 'https://github.com/pingdotgg/t3code/releases/download',
      platform: process.platform, arch: process.arch,
      checkTimeout: 8000, installTimeout: 120000, trialTimeout: 30 * 60 * 1000,
      log: message => console.log(`[t3-update] ${message}`), run: command,
    }, options);
    this.statePath = path.join(this.root, 'state.json');
  }
  executable(version) { return version === 'bundled' ? this.bundled : path.join(this.root, 'versions', version, 't3'); }
  async load() {
    if (!(await exists(this.statePath))) return { active: 'bundled' };
    const s = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    const valid = v => v === 'bundled' || stable(v);
    if (!valid(s.active) || (s.previous && !valid(s.previous)) ||
        (s.requested !== undefined && !stable(s.requested)) ||
        (s.pending && (!stable(s.pending.version) || !/^[0-9a-f-]{36}$/.test(s.pending.id)))) {
      throw new Error('invalid update state; manual recovery required');
    }
    return s;
  }
  async save(s) { await atomic(this.statePath, JSON.stringify(s) + '\n'); }
  async select(version) {
    if (!(await exists(this.executable(version)))) throw new Error('selected runtime missing; manual recovery required');
    await atomic(this.selection, this.executable(version) + '\n');
    this.log(`Selected ${version === 'bundled' ? 'bundled (pinned 0.1.6)' : version}`);
  }
  async fetch(url, destination, timeout) {
    await this.run('curl', ['--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5',
      '--max-time', String(Math.max(1, Math.ceil(timeout / 1000))),
      '--output', destination, url], timeout + 1000);
  }
  async preflight(version) {
    const result = JSON.parse(await this.run(this.executable(version), ['__service-preflight',
      '--database-path', path.join(this.home, 'userdata', 'statev2.sqlite'), '--launcher-protocol', '3']));
    if (result.status !== 'ready' || result.version !== version || result.launcherProtocol !== 3) {
      throw new Error('runtime or database incompatible with launcher protocol 3');
    }
  }
  async install(version) {
    if (this.platform !== 'linux' || !['arm64', 'x64'].includes(this.arch)) throw new Error('unsupported architecture');
    const versions = path.join(this.root, 'versions');
    await fs.mkdir(versions, { recursive: true, mode: 0o700 });
    const final = path.dirname(this.executable(version));
    if (await exists(final)) { await this.preflight(version); return; }
    const stage = await fs.mkdtemp(path.join(versions, '.stage-'));
    const deadline = Date.now() + this.installTimeout;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('installation timed out');
      return ms;
    };
    try {
      const name = `t3-${version}-linux-${this.arch}.tar.gz`;
      const sums = path.join(stage, 'SHA256SUMS'), archive = path.join(stage, 'archive');
      await this.fetch(`${this.releaseURL}/v${version}/SHA256SUMS`, sums, remaining());
      const matches = (await fs.readFile(sums, 'utf8')).split(/\r?\n/)
        .map(line => /^([a-fA-F0-9]{64})\s+\*?(\S+)$/.exec(line.trim()))
        .filter(m => m?.[2] === name);
      if (matches.length !== 1) throw new Error('missing or ambiguous checksum');
      await this.fetch(`${this.releaseURL}/v${version}/${name}`, archive, remaining());
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      if (hash.digest('hex') !== matches[0][1].toLowerCase()) throw new Error('checksum mismatch');
      await this.run('tar', ['-xf', archive, '-C', stage, '--strip-components=1'], remaining());
      await fs.rm(archive); await fs.rm(sums);
      const exe = path.join(stage, 't3');
      if ((await this.run(exe, ['--version'], Math.min(15000, remaining()))) !== version) throw new Error('version mismatch');
      const result = JSON.parse(await this.run(exe, ['__service-preflight', '--database-path',
        path.join(this.home, 'userdata', 'statev2.sqlite'), '--launcher-protocol', '3'], Math.min(15000, remaining())));
      if (result.status !== 'ready' || result.version !== version || result.launcherProtocol !== 3) throw new Error('preflight blocked');
      await syncTree(stage);
      await fs.rename(stage, final);
      await syncDir(versions);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  snapshot(pending) { return path.join(this.root, 'snapshots', pending.id); }
  async copyData(source, destination) {
    await fs.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
      filter: async p => {
        if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('T3 data symlink prevents safe snapshot');
        return true;
      } });
  }
  async rollback(s) {
    const p = s.pending;
    if (!p) return s;
    this.log(`Trial ${p.version} failed or was interrupted; restoring data and ${s.active}`);
    const snapshot = this.snapshot(p), restored = `${snapshot}.restore`, failed = `${snapshot}.failed`;
    if (!(await exists(snapshot))) throw new Error('rollback snapshot missing; refusing unsafe downgrade');
    await fs.rm(restored, { recursive: true, force: true });
    await this.copyData(snapshot, restored);
    // The immutable snapshot and pending journal survive interruption of either rename.
    if (await exists(this.home)) {
      if (await exists(failed)) await fs.rm(this.home, { recursive: true });
      else await fs.rename(this.home, failed);
    }
    await syncTree(restored);
    await fs.rename(restored, this.home);
    await syncDir(path.dirname(this.home));
    const next = { ...s, rejected: p.version };
    delete next.pending;
    delete next.previous;
    delete next.snapshot;
    await this.save(next);
    await this.cleanup(next);
    await this.select(next.active);
    return next;
  }
  async removeUnused(p) {
    await fs.rm(p, { recursive: true, force: true });
  }
  async cleanup(s) {
    // A pending journal owns its snapshot and both runtimes until rollback or
    // commit has durably replaced it. Never infer completion from directory names.
    if (s.pending) return;
    const attempt = async action => {
      try { await action(); }
      catch { this.log('Cleanup failed; unused update files will be retried at next startup'); }
    };
    const sweep = async (dir, unused) => attempt(async () => {
      let names;
      try { names = await fs.readdir(dir); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names) {
        if (unused(name)) await attempt(() => this.removeUnused(path.join(dir, name)));
      }
    });
    await sweep(path.join(this.root, 'snapshots'), () => true);
    await sweep(path.join(this.root, 'versions'), name =>
      name.startsWith('.stage-') || /\.(stage|restore|failed)$/.test(name) || (stable(name) && name !== s.active && name !== s.requested));
    await sweep(this.root, name => name === 'latest.json' || name.startsWith('.stage-') ||
      /\.(stage|restore|failed)$/.test(name));
  }
  async latestVersion() {
    const meta = path.join(this.root, 'latest.json');
    try {
      await this.fetch(this.latestURL, meta, this.checkTimeout);
      const release = JSON.parse(await fs.readFile(meta, 'utf8'));
      const version = release.tag_name?.replace(/^v/, '');
      if (!stable(version) || release.draft || release.prerelease) throw new Error('invalid stable release');
      return version;
    } finally { await fs.rm(meta, { force: true }); }
  }
  async downloadUpdate() {
    // The management panel may download while sessions run. It must never select
    // a runtime, snapshot a live database, or restart a server here.
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await this.load();
    if (s.pending) throw new Error('startup trial still pending');
    const version = await this.latestVersion();
    const current = s.active === 'bundled' ? await this.run(this.bundled, ['--version']) : s.active;
    if (!newer(version, current)) return { message: `T3 ${current} is up to date.` };
    await this.install(version);
    const latest = await this.load();
    if (latest.pending || latest.active !== s.active) throw new Error('selection changed during download');
    await this.save({ ...latest, requested: version });
    this.log(`Manual update ${version} downloaded; ready to stop T3 and install`);
    return { version, message: `T3 ${version} is downloaded. Installing and restarting T3 now.` };
  }
  async prepare(enabled) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    let s = await this.load();
    s = await this.rollback(s);
    await this.select(s.active);
    if ('previous' in s || 'snapshot' in s) {
      const next = { ...s };
      delete next.previous; delete next.snapshot;
      try { await this.save(next); }
      catch {
        this.log('Cleanup state could not be saved; retaining update files and selected runtime');
        return s;
      }
      s = next;
    }
    await this.cleanup(s);
    const manual = s.requested !== undefined;
    if (!enabled && !manual) { this.log('Automatic updates disabled; retaining selected runtime'); return s; }
    let version, phase = 'Release check';
    try {
      version = manual ? s.requested : await this.latestVersion();
      const current = s.active === 'bundled' ? await this.run(this.bundled, ['--version']) : s.active;
      if (!newer(version, current)) {
        if (manual) { delete s.requested; await this.save(s); }
        await this.cleanup(s);
        this.log(`No newer stable release; retaining ${current}`); return s;
      }
      if (!manual && s.rejected === version) { this.log(`Skipping failed trial ${version}; retaining ${current}`); return s; }
      this.log(`${manual ? 'Preparing manually downloaded' : 'Staging stable'} ${version}`);
      phase = 'Installation or compatibility validation';
      await this.install(version);
      phase = 'Data snapshot (requires sufficient space and no data symlinks)';
      const pending = { version, id: randomUUID() };
      const snapshot = this.snapshot(pending);
      await fs.mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      await this.copyData(this.home, `${snapshot}.stage`);
      // Flush the complete snapshot before publishing a journal that authorizes data writes.
      await syncTree(`${snapshot}.stage`);
      await fs.rename(`${snapshot}.stage`, snapshot);
      await syncDir(path.dirname(snapshot));
      s = { ...s, pending };
      delete s.requested;
      await this.save(s);
      await this.select(version);
      return s;
    } catch {
      // Never swallow journal/selection failure after a trial was recorded.
      if (s.pending) return this.rollback(s);
      await this.cleanup(s);
      this.log(`${phase} failed or timed out; retaining selected runtime`);
      return s;
    }
  }
  async commit(s) {
    const next = { active: s.pending.version, ...(s.rejected ? { rejected: s.rejected } : {}) };
    await this.save(next);
    await this.cleanup(next);
    this.log(`Activated ${next.active}; trial recovery no longer needed`);
    return next;
  }
  start(version, args, pending) {
    const env = { ...process.env, T3CODE_HOME: this.home };
    delete env.T3_SERVICE_LAUNCHER_CONTEXT;
    if (version !== 'bundled') env.T3_SERVICE_LAUNCHER_CONTEXT = JSON.stringify({
      protocol: 3, childVersion: version,
      ...(pending ? { update: { id: pending.id, fromVersion: pending.fromVersion,
        targetVersion: version, dbPath: path.join(this.home, 'userdata', 'statev2.sqlite'), status: 'pending' } } : {}),
    });
    return spawn(this.executable(version), args, { env, detached: true,
      stdio: ['ignore', 'inherit', 'inherit', ...(version === 'bundled' ? [] : ['ipc'])] });
  }
  async stop(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    try { await done; } finally {
      clearTimeout(timer);
      // A child may exit before its descendants. Stop the whole trial group before restoring data.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
  async trial(child, s) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('initial startup timed out')), this.trialTimeout);
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.off('message', message); child.off('exit', exited); child.off('error', failed);
        if (error) reject(error); else resolve();
      };
      const exited = () => finish(new Error('initial startup exited'));
      const failed = () => finish(new Error('initial startup failed'));
      const message = async m => {
        if (m?.type !== 'prepared' || m.updateId !== s.pending.id || settled) return;
        try {
          await this.commit(s);
          // Commit precedes activation. A later crash must never restore old data automatically.
          child.send({ type: 'committed', updateId: s.pending.id });
          finish();
        } catch { finish(new Error('activation failed')); }
      };
      child.on('message', message); child.once('exit', exited); child.once('error', failed);
    });
  }
  async serve(args, { status = true, restartDelay = 5000, panelCommand = [process.execPath, '/opt/t3code/status-server.mjs'] } = {}) {
    let s = await this.load(), child, panel, manualRequest, applying, manualStop;
    const reply = (request, ok) => {
      if (panel?.connected) panel.send({ type: 't3-update-result', id: request.id, ok,
        message: ok ? `T3 ${request.version} is installed and restarted.` : 'The update failed. The previous T3 version has been retained or restored.' }, () => {});
    };
    let stopping = false;
    const shutdown = () => { stopping = true; void (child && this.stop(child)); if (panel) panel.kill('SIGTERM'); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    try {
      while (!stopping) {
        if (manualRequest) {
          applying = manualRequest; manualRequest = null;
          await manualStop;
          if (stopping) break;
          // The click authorizes an immediate restart. Snapshot only after the old
          // server and its descendants have stopped; never infer session activity.
          s = await this.prepare(false);
          if (!s.pending) { reply(applying, false); applying = null; }
        }
        const version = s.pending?.version ?? s.active;
        const pending = s.pending && { ...s.pending, fromVersion: s.active === 'bundled' ? await this.run(this.bundled, ['--version']) : s.active };
        this.log(`Starting: t3 ${args[0]} (${version})`);
        child = this.start(version, args, pending);
        // Always attach before awaiting IPC; failed execs emit error, not exit.
        const ended = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
        child.on('message', m => {
          if (m?.type === 'request-update' && child.connected) child.send({
            type: 'update-rejected', reason: 'Use Update T3 now in the Home Assistant add-on panel.' });
        });
        if (s.pending) {
          try { await this.trial(child, s); s = await this.load(); }
          catch {
            await this.stop(child);
            // Re-read durable state: commit may have succeeded before IPC failed.
            s = await this.load();
            if (s.pending) s = await this.rollback(s);
            if (applying) { reply(applying, s.active === applying.version); applying = null; }
            if (stopping) break;
            continue;
          }
        }
        if (applying) { reply(applying, s.active === applying.version); applying = null; }
        if (status && !panel && !stopping) {
          panel = spawn(panelCommand[0], panelCommand.slice(1), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
          panel.on('message', m => {
            if (m?.type !== 'apply-t3-update' || !stable(m.version) || typeof m.id !== 'string' || m.id.length > 100 || stopping) return;
            if (manualRequest || applying) { reply(m, false); return; }
            manualRequest = m;
            manualStop = this.stop(child);
          });
        }
        await ended;
        if (stopping) break;
        if (manualRequest) continue;
        await fs.rm('/tmp/t3-restart-requested', { force: true });
        this.log('Server exited; restarting selected runtime without an update check');
        await new Promise(resolve => setTimeout(resolve, restartDelay));
      }
    } finally { process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown); if (panel) panel.kill('SIGTERM'); if (child) await this.stop(child); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manager = new RuntimeManager();
  try {
    if (process.argv[2] === 'prepare') await manager.prepare(process.argv[3] === 'true');
    else if (process.argv[2] === 'serve') await manager.serve(process.argv.slice(2));
    else throw new Error('invalid manager command');
  } catch { console.error('[t3-update] Startup refused; inspect update state and recovery documentation'); process.exitCode = 1; }
}
