import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStatusServer, createUpdateController, isIngressRequest, parseLoginOutput } from "../t3code/rootfs/opt/t3code/status-server.mjs";

async function serve(t, options) {
  const server = createStatusServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, method, headers }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("only the Supervisor TCP peer is trusted, including IPv4-mapped IPv6", () => {
  for (const address of ["172.30.32.2", "::ffff:172.30.32.2"]) {
    assert.equal(isIngressRequest({ socket: { remoteAddress: address } }), true);
  }
  for (const address of ["127.0.0.1", "::1", "172.30.33.5", "192.168.1.2", undefined]) {
    assert.equal(isIngressRequest({ socket: { remoteAddress: address }, headers: { "x-forwarded-for": "172.30.32.2" } }), false);
  }
});

test("direct HTTP clients cannot bypass ingress with spoofed headers", async t => {
  const calls = [];
  const request = await serve(t, { runCommand: (...args) => { calls.push(args); } });
  for (const path of ["/", "/api/status", "/api/logout", "/api/login/t3/start", "/api/diag/exec", "/api/diag/claude"]) {
    const response = await request(path, { method: "POST", headers: {
      "content-type": "application/json", "x-forwarded-for": "172.30.32.2",
      "x-real-ip": "172.30.32.2", "x-ingress-path": "/api/hassio_ingress/test",
      "x-remote-user-id": "admin",
    }, body: "{}" });
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(calls, []);
});

// Simulate ingress after testing the production TCP-peer check above.
const ingress = { isTrustedRequest: () => true };
const jsonHeaders = { "content-type": "application/json" };

test("ingress can render the page and manage a login without exposing diagnostics", async t => {
  const calls = [];
  const request = await serve(t, { ...ingress, runCommand: async (...args) => {
    calls.push(args);
    return { ok: true, stdout: "signed out", stderr: "" };
  } });
  const page = await request("/api/hassio_ingress/test/", { headers: { "x-ingress-path": "/api/hassio_ingress/test" } });
  assert.equal(page.status, 200);
  assert.match(page.text, /const BASE = "\/api\/hassio_ingress\/test"/);
  new Script(page.text.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.equal((await request("/api/logout", { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  assert.deepEqual(calls, [["t3", ["connect", "logout"]]]);
  for (const path of ["/api/diag", "/api/diag/git", "/api/diag/logs", "/api/diag/exec", "/api/diag/checkpoint", "/api/diag/claude"]) {
    for (const method of ["GET", "POST"]) {
      assert.equal((await request(path, { method, headers: jsonHeaders, body: method === "POST" ? "{}" : undefined })).status, 404, `${method} ${path}`);
    }
  }
  assert.equal(calls.length, 1);
});

test("ingress rejects cross-site requests and form submissions", async t => {
  const request = await serve(t, { ...ingress, runCommand: () => assert.fail("must not run a command") });
  assert.equal((await request("/api/logout", { method: "POST" })).status, 415);
  assert.equal((await request("/api/logout", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await request("/api/logout", { method: "POST", headers: { ...jsonHeaders, "sec-fetch-site": "cross-site" }, body: "{}" })).status, 403);
});

test("authorization code inputs reject malformed JSON, control characters, and excessive bodies", async t => {
  const request = await serve(t, ingress);
  for (const body of ["{", "null", "[]", '{"code":123}', '{"code":""}', JSON.stringify({ code: "a\ncommand" }), JSON.stringify({ code: "\u001b[A" })]) {
    assert.equal((await request("/api/login/t3/code", { method: "POST", headers: jsonHeaders, body })).status, 400, body);
  }
  assert.equal((await request("/api/login/t3/code", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ code: "a".repeat(9000) }) })).status, 413);
  const result = await request("/api/login/t3/code", { method: "POST", headers: jsonHeaders, body: '{"code":"valid-code"}' });
  assert.equal(result.status, 200);
  assert.match(result.text, /No login in progress/);
  assert.equal((await request("/")).status, 200, "server remains available after invalid requests");
});

test("an ingress path cannot inject script into the page", async t => {
  const request = await serve(t, ingress);
  assert.equal((await request("/", { headers: { "x-ingress-path": '\";</script><script>alert(1)</script>' } })).status, 400);
});

// Matches the prompt layout in Codex rust-v0.166.0 login/src/device_code_auth.rs.
// The code is a fictional test value, never obtained from an authentication run.
const codexPrompt = "\nWelcome to Codex [v\x1b[90m0.166.0\x1b[0m]\n" +
  "OpenAI's command-line coding agent\n\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
  "1. Open this link in your browser and sign in to your account\n" +
  "   \x1b[34mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n" +
  "   \x1b[34mABCD-EFGHI\x1b[0m\n\n" +
  "Continue only if you started this login in Codex.\n";

test("Codex device codes are extracted from their own ANSI-colored line", () => {
  assert.deepEqual(parseLoginOutput(codexPrompt), {
    url: "https://auth.openai.com/codex/device", code: "ABCD-EFGHI",
  });
  assert.equal(parseLoginOutput(codexPrompt.replaceAll("\n", "\r\n")).code, "ABCD-EFGHI");
  const partial = codexPrompt.slice(0, codexPrompt.indexOf("ABCD-EFGHI") + 9);
  assert.equal(parseLoginOutput(partial).code, null, "do not freeze an incomplete code at a chunk boundary");
  assert.equal(parseLoginOutput("Open https://auth.openai.co").url, null);
  assert.equal(parseLoginOutput("Enter code: ABCD-1234\n").code, "ABCD-1234");
});

test("device-login page sends the code to OpenAI without a paste-back field", async t => {
  const request = await serve(t, ingress);
  const page = await request("/");
  const context = createContext({ fetch: () => new Promise(() => {}), setInterval: () => 0 });
  new Script(page.text.match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(context);
  const html = context.flowHtml("codex", {
    codeEntry: "browser", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGHI",
    state: "waiting_for_browser",
  });
  assert.match(html, /ABCD-EFGHI/);
  assert.match(html, /Enter this device code on the OpenAI sign-in page/);
  assert.doesNotMatch(html, /<input|Submit code|paste back/);
  assert.doesNotMatch(context.flowHtml("codex", { codeEntry: "browser", url: "https://auth.openai.com/codex/device" }), /<a /,
    "wait for the code before sending the user to OpenAI");
  const terminal = context.flowHtml("claude", { codeEntry: "terminal", url: "https://example.test/login" });
  assert.match(terminal, /<input/);
  assert.match(terminal, /Submit code/);
});

test("Codex login API retains a fragmented device code and waits for browser authorization", async t => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const submitted = [];
  child.stdin.on("data", chunk => submitted.push(chunk.toString()));
  let signedIn = false;
  const splitAt = codexPrompt.indexOf("ABCD-EFGHI") + 9;
  const request = await serve(t, { ...ingress,
    spawnLogin: (command, args) => {
      assert.equal(command, "script");
      assert.equal(args[1], "codex login --device-auth");
      queueMicrotask(() => child.stdout.write(codexPrompt.slice(0, splitAt)));
      return child;
    },
    runCommand: async (command, args) => {
      if (command === "t3") return { ok: true, stdout: '{"authenticated":false}', stderr: "" };
      return { ok: signedIn && command === "codex", stdout: signedIn && command === "codex" ? "Logged in using ChatGPT" : "Not logged in", stderr: "" };
    },
  });
  t.after(() => {
    child.emit("exit", 0);
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
  const start = await request("/api/login/codex/start", { method: "POST", headers: jsonHeaders, body: "{}" });
  const first = JSON.parse(start.text);
  assert.equal(first.codeEntry, "browser");
  assert.equal(first.state, "waiting_for_browser");
  assert.equal(first.code, null);
  child.stderr.write(codexPrompt.slice(splitAt));
  let status = JSON.parse((await request("/api/status")).text);
  assert.equal(status.providers.codex.session.code, "ABCD-EFGHI");
  const rejected = await request("/api/login/codex/code", { method: "POST", headers: jsonHeaders, body: '{"code":"ABCD-EFGHI"}' });
  assert.equal(JSON.parse(rejected.text).ok, false);
  assert.deepEqual(submitted, [], "device codes must never be written to Codex stdin");
  signedIn = true;
  child.stdout.write("Successfully logged in\n");
  child.emit("exit", 0);
  status = JSON.parse((await request("/api/status")).text);
  assert.equal(status.providers.codex.session.state, "done");
  assert.equal(status.providers.codex.signedIn, true);
});

test('manual update requests keep ingress protections and accept no arbitrary package or version', async t => {
  let starts = 0;
  const updates = {
    status: async () => ({current:'0.1.6',queued:null,busy:false,message:'Ready'}),
    start: () => { starts++; },
  };
  const direct = await serve(t,{updates});
  assert.equal((await direct('/api/t3-update',{method:'POST',headers:jsonHeaders,body:'{}'})).status,403);
  assert.equal((await direct('/api/t3-update')).status,403);
  const request = await serve(t,{...ingress,updates});
  assert.equal((await request('/api/t3-update',{method:'POST',headers:{...jsonHeaders,'sec-fetch-site':'cross-site'},body:'{}'})).status,403);
  assert.equal((await request('/api/t3-update',{method:'POST',body:'{}'})).status,415);
  assert.equal((await request('/api/t3-update',{method:'POST',headers:jsonHeaders,body:'{'})).status,400);
  assert.equal((await request('/api/t3-update',{method:'POST',headers:jsonHeaders,body:'{"version":"arbitrary"}'})).status,400);
  assert.equal((await request('/api/t3-update',{method:'POST',headers:jsonHeaders,body:JSON.stringify({padding:'x'.repeat(9000)})})).status,413);
  assert.equal(starts,0);
  assert.equal((await request('/api/t3-update',{method:'POST',headers:jsonHeaders,body:'{}'})).status,202);
  assert.equal(starts,1);
  assert.equal(JSON.parse((await request('/api/t3-update')).text).current,'0.1.6');
});

test('manual update controller runs one download at a time and reports failures without secrets', async () => {
  let calls=0, complete;
  const updates=createUpdateController({
    load:async()=>({active:'bundled'}),
    downloadUpdate:()=>{calls++;return new Promise(resolve=>{complete=resolve;});},
  });
  updates.start();updates.start();
  assert.equal(calls,1);
  assert.equal((await updates.status()).busy,true);
  complete({message:'Downloaded for next add-on restart'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await updates.status()).busy,false);
  assert.match((await updates.status()).message,/next add-on restart/);
  const failure=createUpdateController({load:async()=>({active:'0.1.7',requested:'0.1.8'}),downloadUpdate:async()=>{throw new Error('credential=private');}});
  failure.start();await new Promise(resolve=>setImmediate(resolve));
  const status=await failure.status();
  assert.equal(status.queued,'0.1.8');
  assert.match(status.message,/running T3 version is unchanged/);
  assert.doesNotMatch(JSON.stringify(status),/credential|private/);
});

test('manual update button explains when installation happens and escapes displayed values', async t => {
  const request=await serve(t,ingress);
  const page=await request('/');
  let html='';
  const context=createContext({
    fetch:async url=>({json:async()=>url.endsWith('/api/t3-update')?{current:'<current>',queued:'<next>',message:'<message>',busy:true}:{}}),
    setInterval:()=>0,
    document:{getElementById:()=>({set innerHTML(value){html=value;}})},
  });
  new Script(page.text.match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(context);
  await context.refreshUpdate();
  assert.match(html,/restart the add-on in Home Assistant/);
  assert.match(html,/even if automatic updates are off/);
  assert.match(html,/Checking and downloading/);
  assert.match(html,/disabled/);
  assert.match(html,/&lt;next&gt;/);
  assert.doesNotMatch(html,/<next>|<message>/);
});
