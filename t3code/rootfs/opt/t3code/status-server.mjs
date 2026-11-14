// Minimal ingress status page for the T3 Code add-on.
// - Shows T3 Connect state and drives the headless (out-of-band OAuth) login.
// - Shows provider (Claude Code, Codex, OpenCode) login state and drives their headless
//   logins with either browser-entered device codes or terminal-entered OAuth codes.
// No T3 Code UI is served here; remote clients connect through T3 Connect.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RuntimeManager } from "./runtime-manager.mjs";

const PORT = 8099;
const MODE = process.env.T3CODE_REMOTE_MODE || "t3_connect";
const LAN_PORT = process.env.T3CODE_LAN_PORT || "3773";

// ---- command helpers ------------------------------------------------------

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: process.env, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && typeof err.code === "number" ? err.code : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function stripAnsi(s) {
  // CSI sequences, OSC sequences (including OSC 8 hyperlinks), and stray BEL bytes.
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x07/g, "\n");
}

async function connectStatus(runCommand = run) {
  const r = await runCommand("t3", ["connect", "status", "--json"]);
  const raw = r.stdout + r.stderr;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  console.log("[status] could not parse t3 connect status output:\n" + raw);
  return { error: raw.trim() || "t3 connect status failed" };
}

// ---- login flows ----------------------------------------------------------
// Each flow runs a CLI that prints a URL and (usually) waits for a code on a
// TTY. `script` gives it a pty so prompts behave; we feed stdin ourselves.

const FLOWS = {
  t3: {
    label: "T3 Connect",
    command: "t3 connect link --headless",
    done: /Authorized|Signed in/i,
    envSignedIn: () => false,
  },
  claude: {
    label: "Claude Code",
    command: "claude auth login",
    done: /Login successful|Logged in|Successfully|success/i,
    envSignedIn: () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
  },
  codex: {
    label: "Codex",
    command: "codex login --device-auth",
    codeEntry: "browser",
    done: /Logged in|Successfully|success/i,
    envSignedIn: () => Boolean(process.env.OPENAI_API_KEY),
  },
  opencode: {
    label: "OpenCode (ChatGPT subscription)",
    command: 'opencode auth login openai --method chatgpt-headless --standalone',
    codeEntry: "browser",
    done: /Connected to OpenAI/,
    envSignedIn: () => false,
  },
};

const sessions = {}; // name -> { proc, output, url, code, state, error, startedAt }

function active(s) {
  return s && (s.state === "starting" || s.state === "waiting_for_code" || s.state === "waiting_for_browser" || s.state === "submitted");
}

// Codex 0.166.0 prints its code on the line after the one-time-code label.
// Parse the complete accumulated output so chunk boundaries cannot lose the code.
export function parseLoginOutput(output) {
  const clean = stripAnsi(output);
  const link = clean.match(/https?:\/\/[^\s'"<>]+(?=[\s'"<>])/);
  const lines = clean.split(/\r?\n/);
  const codeToken = /^(?:[A-Z0-9]{4,5}-[A-Z0-9]{4,5}|[A-Z0-9]{8,9})$/;
  let code = null;
  for (let i = 0; i < lines.length - 2; i++) {
    if (!/(?:one[- ]time|device)\s+code/i.test(lines[i])) continue;
    const candidate = lines[i + 1].trim();
    if (codeToken.test(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    const inline = clean.match(/(?:code|enter)[^\n]{0,40}?\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5}|[A-Z0-9]{8,9})(?=\s)/);
    code = inline?.[1] || null;
  }
  return { url: link ? link[0].replace(/[),.]+$/, "") : null, code };
}

function startFlow(name, spawnProcess = spawn) {
  const flow = FLOWS[name];
  if (!flow) return null;
  if (active(sessions[name])) return sessions[name];
  const proc = spawnProcess("script", ["-qfec", flow.command, "/dev/null"], {
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1", BROWSER: "/bin/false" },
    cwd: "/config",
  });
  const s = { proc, output: "", url: null, code: null, state: "starting", error: null, startedAt: Date.now() };
  sessions[name] = s;
  const onData = (chunk) => {
    s.output += chunk.toString();
    const clean = stripAnsi(s.output);
    const parsed = parseLoginOutput(s.output);
    // OpenCode's device flow always uses this public URL. Never expose a
    // different URL or arbitrary output from its CLI or plugins.
    s.url ||= name === "opencode"
      ? (parsed.url === "https://auth.openai.com/codex/device" ? parsed.url : null)
      : parsed.url;
    s.code ||= parsed.code;
    if (s.url && s.state === "starting") {
      s.state = flow.codeEntry === "browser" ? "waiting_for_browser" : "waiting_for_code";
    }
    if (flow.done.test(clean)) s.state = "done";
    if (s.state === "submitted" && /invalid|rejected|expired|error|failed|denied/i.test(clean.slice(-400))) {
      s.state = "waiting_for_code";
      s.error = "The code was rejected. Open the link again and paste a fresh code.";
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", (code) => {
    if (s.state === "done") return;
    if (name !== "opencode" && code === 0 && s.state !== "starting") {
      s.state = "done";
      return;
    }
    s.state = "failed";
    s.error = s.error || `Login process exited with code ${code}. See the add-on log.`;
    if (name === "opencode") console.log("[status] OpenCode login failed; sign in again from the panel.");
    else console.log(`[status] ${name} login output:\n` + stripAnsi(s.output));
  });
  proc.on("error", () => {
    s.state = "failed";
    s.error = "Could not start the login process. Try signing in again.";
  });
  return s;
}

function submitCode(name, code) {
  if (FLOWS[name]?.codeEntry === "browser") {
    return { ok: false, error: `Enter the device code on the OpenAI sign-in page. ${FLOWS[name].label} completes sign-in automatically.` };
  }
  const s = sessions[name];
  if (!active(s)) return { ok: false, error: "No login in progress. Click 'Sign in' first." };
  s.error = null;
  s.state = "submitted";
  s.proc.stdin.write(code.trim() + "\n");
  return { ok: true };
}

function publicSession(name) {
  const s = sessions[name];
  if (!s) return null;
  return { state: s.state, url: s.url, code: s.code, codeEntry: FLOWS[name].codeEntry || "terminal", error: s.error, startedAt: s.startedAt };
}

// ---- provider status ------------------------------------------------------

// OpenCode 2 exposes credential metadata, not tokens, in auth list JSON.
// Return null on failure rather than claiming that malformed output means signed out.
function openCodeAccounts(result) {
  if (!result.ok) return null;
  try {
    const integrations = JSON.parse(result.stdout);
    if (!Array.isArray(integrations)) return null;
    return integrations.filter(item => item?.id === "openai")
      .flatMap(item => Array.isArray(item.connections) ? item.connections : [])
      .filter(connection => connection?.type === "credential" && connection.method === "oauth" &&
        typeof connection.id === "string" && /^cred_[A-Za-z0-9_-]+$/.test(connection.id));
  } catch { return null; }
}
const openCodeListArgs = ["auth", "list", "--format", "json", "--standalone"];

async function providerStatus(runCommand = run) {
  const out = {};
  const claude = await runCommand("claude", ["auth", "status"]);
  const cRaw = stripAnsi(claude.stdout + claude.stderr).trim();
  out.claude = {
    installed: !(claude.code === 127 || /ENOENT/.test(cRaw)),
    signedIn: FLOWS.claude.envSignedIn() || (claude.ok && !/not logged in|logged out|not authenticated/i.test(cRaw)),
    viaEnv: FLOWS.claude.envSignedIn(),
    detail: cRaw.split("\n")[0] || "",
    session: publicSession("claude"),
  };
  const codex = await runCommand("codex", ["login", "status"]);
  const xRaw = stripAnsi(codex.stdout + codex.stderr).trim();
  out.codex = {
    installed: !(codex.code === 127 || /ENOENT/.test(xRaw)),
    signedIn: FLOWS.codex.envSignedIn() || (codex.ok && !/not logged in/i.test(xRaw)),
    viaEnv: FLOWS.codex.envSignedIn(),
    detail: xRaw.split("\n")[0] || "",
    session: publicSession("codex"),
  };
  // An API key or OPENAI_API_KEY does not establish a subscription login.
  const opencode = await runCommand("opencode", openCodeListArgs);
  const oRaw = stripAnsi(opencode.stdout + opencode.stderr);
  const accounts = openCodeAccounts(opencode);
  const subscription = accounts?.some(account => account.status?.status !== "needs_auth") ?? false;
  out.opencode = {
    installed: !(opencode.code === 127 || /ENOENT/.test(oRaw)),
    signedIn: subscription,
    viaEnv: false,
    detail: accounts === null ? "Could not check OpenCode credentials" : subscription ? "ChatGPT subscription credential saved" : accounts.length ? "ChatGPT subscription needs sign-in again" : "No ChatGPT subscription credential found",
    session: publicSession("opencode"),
  };
  return out;
}

// ---- server restart -------------------------------------------------------

function restartServer() {
  fs.writeFileSync("/tmp/t3-restart-requested", "1");
  execFile("pkill", ["-f", "t3 serve"], () => {});
  return { ok: true };
}

function lanInfo() {
  const ifaces = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) ifaces.push(`${name}: ${a.address}`);
    }
  }
  return { port: LAN_PORT, ifaces };
}

// ---- HTTP -----------------------------------------------------------------

const MAX_BODY_BYTES = 8192;

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Check the TCP peer, never a caller-controlled forwarding header.
export function isIngressRequest(req) {
  return ["172.30.32.2", "::ffff:172.30.32.2"].includes(req.socket.remoteAddress);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new RequestError(400, "Expected a JSON object");
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

export function applyManualUpdate(version, host = process) {
  return new Promise((resolve, reject) => {
    if (!host.connected || !host.send) return reject(new Error("Update supervisor unavailable"));
    const id = randomUUID();
    const cleanup = () => { host.off("message", receive); host.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(new Error("Update supervisor disconnected")); };
    const receive = m => {
      if (m?.type !== "t3-update-result" || m.id !== id) return;
      cleanup(); resolve(m.message);
    };
    host.on("message", receive); host.once("disconnect", disconnected);
    host.send({type:"apply-t3-update", id, version}, error => { if (error) disconnected(); });
  });
}

export function createUpdateController(manager = new RuntimeManager(), applyUpdate = applyManualUpdate) {
  let job = null;
  let message = "Install the newest stable T3 version and restart T3 immediately.";
  return {
    isBusy() { return job !== null; },
    async status() {
      const s = await manager.load();
      return { current: s.active === "bundled" ? "0.1.6" : s.active,
        queued: s.pending?.version || s.requested || null, busy: job !== null, message };
    },
    start() {
      if (job) return;
      message = "Checking for a T3 update. If one is available, T3 will install it and restart now.";
      job = manager.downloadUpdate()
        .then(async result => {
          message = result.message;
          if (result.version) message = await applyUpdate(result.version);
        })
        .catch(() => { message = "The update could not be completed. Check the add-on log for the running version and recovery details."; })
        .finally(() => { job = null; });
    },
  };
}

export function createStatusServer({ runCommand = run, isTrustedRequest = isIngressRequest, spawnLogin = spawn, updates = createUpdateController() } = {}) {
  const server = http.createServer(async (req, res) => {
    if (!isTrustedRequest(req)) return json(res, 403, { error: "Ingress connections only" });
    if (req.method === "POST") {
      if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "Cross-site request denied" });
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return json(res, 415, { error: "Content-Type must be application/json" });
      }
    }
    try {
      const ingressPath = req.headers["x-ingress-path"] || "";
      if (ingressPath && !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(ingressPath)) {
        return json(res, 400, { error: "Invalid ingress path" });
      }
      const url = new URL(req.url, "http://localhost");
      let path = url.pathname;
      if (ingressPath && path.startsWith(ingressPath)) path = path.slice(ingressPath.length) || "/";

      if (req.method === "GET" && path === "/api/t3-update") {
        return json(res, 200, await updates.status());
      }
      if (req.method === "POST" && path === "/api/t3-update") {
        const body = await readBody(req);
        if (Object.keys(body).length) return json(res, 400, { error: "No update parameters are accepted" });
        updates.start();
        return json(res, 202, await updates.status());
      }
      if (path.startsWith("/api/") && updates.isBusy?.()) {
        return json(res, 409, { error: "T3 is updating. Management commands will be available when the update finishes." });
      }
      if (req.method === "GET" && path === "/api/status") {
        return json(res, 200, {
          mode: MODE,
          connect: await connectStatus(runCommand),
          session: publicSession("t3"),
          providers: await providerStatus(runCommand),
          lan: MODE === "lan" ? lanInfo() : null,
        });
      }
      const m = path.match(/^\/api\/login\/(t3|claude|codex|opencode)\/(start|code)$/);
      if (req.method === "POST" && m) {
        const [, name, action] = m;
        if (action === "start") {
          const s = startFlow(name, spawnLogin);
          for (let i = 0; i < 80 && !s.url && s.state === "starting"; i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          return json(res, 200, publicSession(name));
        }
        const body = await readBody(req);
        if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 4096 || /[\x00-\x1f\x7f]/.test(body.code)) {
          return json(res, 400, { ok: false, error: "Expected a single-line authorization code" });
        }
        return json(res, 200, submitCode(name, String(body.code)));
      }
      if (req.method === "POST" && path === "/api/unlink") {
        const r = await runCommand("t3", ["connect", "unlink"]);
        return json(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
      }
      if (req.method === "POST" && path === "/api/logout") {
        const r = await runCommand("t3", ["connect", "logout"]);
        delete sessions.t3;
        return json(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
      }
      if (req.method === "POST" && path === "/api/provider/claude/logout") {
        const r = await runCommand("claude", ["auth", "logout"]);
        delete sessions.claude;
        return json(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
      }
      if (req.method === "POST" && path === "/api/provider/codex/logout") {
        const r = await runCommand("codex", ["logout"]);
        delete sessions.codex;
        return json(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
      }
      if (req.method === "POST" && path === "/api/provider/opencode/logout") {
        const accounts = openCodeAccounts(await runCommand("opencode", openCodeListArgs));
        if (accounts === null) return json(res, 200, { ok: false });
        // V2 requires a credential ID. Remove only OpenAI OAuth accounts;
        // preserve API keys, other integrations, and Codex credentials.
        let ok = true;
        for (const account of accounts) {
          const r = await runCommand("opencode", ["auth", "logout", "openai", account.id, "--standalone"]);
          ok = r.ok && ok;
        }
        delete sessions.opencode;
        return json(res, 200, { ok });
      }
      if (req.method === "POST" && path === "/api/restart") {
        return json(res, 200, restartServer());
      }
      if (req.method === "GET" && (path === "/" || path === "")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(PAGE.replace("__BASE__", ingressPath));
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      if (!res.headersSent) json(res, err.statusCode || 500, { error: err.statusCode ? err.message : "Request failed" });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createStatusServer().listen(PORT, "0.0.0.0", () => console.log(`[status] listening on ${PORT} (mode=${MODE})`));
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T3 Code</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#111;color:#eee;max-width:720px}
 h1{font-size:20px;margin:0 0 16px} h2{font-size:13px;margin:0 0 12px;color:#aaa;text-transform:uppercase;letter-spacing:.05em}
 .card{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;padding:16px;margin-bottom:12px}
 .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #262626} .row:last-child{border:0}
 .ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
 button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}
 button.secondary{background:#333} button:disabled{opacity:.5;cursor:default}
 input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#eee;font-size:15px;margin:8px 0}
 a{color:#60a5fa;word-break:break-all} code{background:#000;padding:2px 5px;border-radius:4px}
 .muted{color:#888;font-size:13px} .big{font-size:22px;letter-spacing:.1em;font-family:monospace}
</style></head><body>
<h1>T3 Code add-on</h1>
<div id="connect" class="card">Loading…</div>
<div id="providers" class="card"></div>
<div id="updates" class="card"></div>
<div class="muted">This page only manages remote access and sign-ins. Use the T3 Code app on your phone or desktop to work with agents.</div>
<script>
const BASE = "__BASE__";
const api = (p, opt) => fetch(BASE + p, opt).then(r => r.json());
const post = (p, body) => api(p, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body||{})});
let st = null;
const pending = {};
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function row(l,v){ return '<div class="row"><span>'+l+'</span><span class="'+(v?"ok":"bad")+'">'+(v?"yes":"no")+'</span></div>'; }
function saveInputs(){ for (const n of ["t3","claude","codex","opencode"]) { const e=document.getElementById("code-"+n); if(e) pending[n]=e.value; } }
async function refresh(){ try { st = await api("/api/status"); if (st.error) { document.getElementById("connect").textContent = st.error; document.getElementById("providers").innerHTML = ""; } else { saveInputs(); renderConnect(); renderProviders(); } await refreshUpdate(); } catch (e) { document.getElementById("connect").textContent = "Status server unreachable: " + e; } }

function flowHtml(name, s){
  if (s.codeEntry === "browser") {
    const label = name === "opencode" ? "OpenCode" : "Codex";
    if (!s.code || !s.url) return '<p class="muted">Waiting for '+label+' to provide the device code and sign-in link…</p>';
    return '<p>Enter this device code on the OpenAI sign-in page:</p>' +
      '<p><span class="big">'+esc(s.code)+'</span></p>' +
      '<p><a href="'+esc(s.url)+'" target="_blank" rel="noopener">Open OpenAI sign-in</a></p>' +
      '<p class="muted">Complete sign-in in your browser. '+label+' will finish automatically; this page updates when sign-in completes.</p>' +
      (s.error ? '<p class="bad">'+esc(s.error)+'</p>' : '');
  }
  let h = '<p><b>Step 1.</b> Open this link on any device with a browser and sign in:</p>' +
    (s.url ? '<p><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.url)+'</a></p>' : '<p class="muted">Waiting for the login link…</p>');
  if (s.code) h += '<p>If asked for a code, enter: <span class="big">'+esc(s.code)+'</span></p>';
  h += '<p><b>Step 2.</b> If the browser shows a code to paste back, enter it here:</p>' +
    '<input id="code-'+name+'" placeholder="Authorization code" autocomplete="off" value="'+esc(pending[name]||"")+'">' +
    (s.error ? '<p class="bad">'+esc(s.error)+'</p>' : '') +
    '<button onclick="submit(\\''+name+'\\')" '+(s.state==="submitted"?"disabled":"")+'>'+(s.state==="submitted"?"Verifying…":"Submit code")+'</button>' +
    '<p class="muted">Waiting for the CLI to confirm the login… this page refreshes automatically.</p>';
  return h;
}

function renderConnect(){
  const c = st.connect || {}; const s = st.session; const el = document.getElementById("connect");
  if (st.mode === "lan") {
    el.innerHTML = '<h2>LAN pairing mode</h2>' +
      '<p>The server listens on port <code>'+esc(st.lan.port)+'</code>. The pairing URL and token are printed in the add-on <b>Log</b> tab at each start.</p>' +
      '<p class="muted">Replace the host in the pairing URL with your Home Assistant IP. Container interfaces: '+esc(st.lan.ifaces.join(", ")||"n/a")+'</p>';
    return;
  }
  if (c.error) { el.innerHTML = '<h2>T3 Connect</h2><p class="bad">Could not read T3 Connect status: '+esc(c.error)+'</p>'; return; }
  const ready = c.authenticated && c.desired;
  let h = '<h2>T3 Connect</h2>' +
    row("Signed in", c.authenticated) + row("Remote access enabled", c.desired) + row("Environment linked", c.linked) +
    '<div class="row"><span>Relay client</span><span>'+(c.relayClient? esc(c.relayClient.status)+" "+esc(c.relayClient.version||""):"—")+'</span></div>';
  if (ready && c.linked) {
    h += '<p class="ok">Ready. Open the T3 Code app on another device, sign in with the same account, and pick this environment.</p>';
  } else if (ready && !c.linked) {
    h += '<p class="warn">Authorized. The server links to T3 Connect on its next start.</p><button onclick="restart()">Restart server now</button>';
  } else if (!s || s.state === "failed" || s.state === "done") {
    h += '<p>Not signed in. Sign in to your T3 account to allow remote control of this server.</p>' +
      (s && s.state === "failed" ? '<p class="bad">'+esc(s.error)+'</p>' : '') +
      '<button onclick="start(\\'t3\\')">Start sign-in</button>' +
      '<p class="muted">The same instructions are printed in the add-on Log tab.</p>';
  } else {
    h += flowHtml("t3", s);
  }
  if (c.authenticated) h += '<p style="margin-top:20px"><button class="secondary" onclick="unlink()">Disable remote access</button><button class="secondary" onclick="logout()">Sign out</button></p>';
  el.innerHTML = h;
}

function renderProviders(){
  const p = st.providers || {}; const el = document.getElementById("providers");
  let h = '<h2>Providers on this server</h2><p class="muted">Provider logins are per machine. Sign in here if the T3 Code app does not offer it for this environment. Alternatively set an API key or token in the add-on configuration.</p><p class="muted">Signing in does not enable a provider in T3. In the HA environment, open T3 Settings &gt; Providers, enable the provider, and select Refresh provider status to populate the model picker. For local OpenCode, leave Server URL empty.</p><p class="muted">Pi is bundled with this add-on. Enable Pi in T3 Settings &gt; Providers. For subscription sign-in, run pi in the add-on terminal and use /login, then refresh provider status. Pi sign-in is separate from Claude Code and Codex.</p>';
  for (const name of ["claude","codex","opencode"]) {
    const v = p[name]; if (!v) continue;
    const label = name === "claude" ? "Claude Code" : name === "opencode" ? "OpenCode (ChatGPT subscription)" : "Codex";
    h += '<div class="row"><span>'+label+'</span><span class="'+(v.signedIn?"ok":"bad")+'">'+(!v.installed?"not installed":v.signedIn?(v.viaEnv?"configured via add-on option":"signed in"):"signed out")+'</span></div>';
    if (!v.installed) continue;
    if (v.detail) h += '<p class="muted">'+esc(v.detail)+'</p>';
    const s = v.session;
    if (v.signedIn && !v.viaEnv) {
      h += '<button class="secondary" onclick="plogout(\\''+name+'\\')">Sign out of '+label+'</button>';
    } else if (!v.signedIn && (!s || s.state === "failed" || s.state === "done")) {
      h += (s && s.state === "failed" ? '<p class="bad">'+esc(s.error)+'</p>' : '') +
        '<button onclick="start(\\''+name+'\\')">Sign in to '+label+'</button>';
    } else if (!v.signedIn && s) {
      h += flowHtml(name, s);
    }
  }
  el.innerHTML = h;
}
async function refreshUpdate(){
  const el = document.getElementById("updates");
  try {
    const u = await api("/api/t3-update");
    if (u.error) throw new Error(u.error);
    el.innerHTML = '<h2>T3 updates</h2><p>Running T3 '+esc(u.current)+'</p>' +
      '<p>'+esc(u.message)+'</p>' +
      (u.queued ? '<p class="ok">T3 '+esc(u.queued)+' is being prepared for installation.</p>' : '') +
      '<button onclick="downloadUpdate()" '+(u.busy?'disabled':'')+'>'+(u.busy?'Updating T3…':'Update T3 now')+'</button>' +
      '<p class="muted">This button installs the update and restarts T3 immediately, even if automatic updates are off.</p>';
  } catch { el.textContent = 'T3 update information is unavailable. Your running version is unchanged.'; }
}
async function downloadUpdate(){ await post("/api/t3-update"); await refreshUpdate(); }
async function start(n){ await post("/api/login/"+n+"/start"); await refresh(); }
async function submit(n){ const code=document.getElementById("code-"+n).value; if(!code) return; pending[n]=""; await post("/api/login/"+n+"/code",{code}); await refresh(); }
async function unlink(){ if(confirm("Disable remote access?")) { await post("/api/unlink"); await refresh(); } }
async function logout(){ if(confirm("Sign out of T3 Connect?")) { await post("/api/logout"); await refresh(); } }
async function plogout(n){ if(confirm("Sign out?")) { await post("/api/provider/"+n+"/logout"); await refresh(); } }
async function restart(){ await post("/api/restart"); setTimeout(refresh, 4000); }
refresh(); setInterval(refresh, 4000);
</script></body></html>`;
