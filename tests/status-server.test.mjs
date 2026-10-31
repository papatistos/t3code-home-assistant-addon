import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Script } from "node:vm";
import { createStatusServer, isIngressRequest } from "../t3code/rootfs/opt/t3code/status-server.mjs";

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
