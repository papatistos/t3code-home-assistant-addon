#!/usr/bin/env python3
"""Exercise real startup and ingress isolation with disposable data and no credentials."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

image = sys.argv[1]
repo = Path(__file__).resolve().parents[1]
name = "t3ha-smoke-" + uuid.uuid4().hex[:10]
network = name + "-net"
supervisor = name + "-supervisor"
invalid = name + "-invalid"


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, **kwargs)


probe = r'''
import http.client,json,time,sys
allowed = sys.argv[1] == "allowed"
def request(path, method="GET", body=None, extra=None):
    c=http.client.HTTPConnection("172.30.32.10",8099,timeout=40)
    headers={"content-type":"application/json", "x-forwarded-for":"172.30.32.2"}
    headers.update(extra or {})
    c.request(method,path,body=body,headers=headers)
    r=c.getresponse(); data=r.read().decode(); c.close()
    return r.status,data
for attempt in range(60):
    try:
        code,page=request("/")
        break
    except OSError:
        if attempt==59: raise
        time.sleep(1)
assert code == (200 if allowed else 403), (code,page)
if not allowed:
    for path in ["/api/status","/api/login/t3/start","/api/logout","/api/diag/claude","/api/diag/exec"]:
        assert request(path,"POST","{}")[0]==403,path
    print("PASS: untrusted container cannot access management, even with spoofed headers")
    sys.exit(0)
for path in ["/api/diag","/api/diag/logs","/api/diag/claude","/api/diag/exec","/api/diag/checkpoint"]:
    assert request(path,"POST","{}")[0]==404,path
assert request("/api/login/t3/code","POST",'{"code":"line\\ncommand"}')[0]==400
code,raw=request("/api/status")
assert code==200,(code,raw)
status=json.loads(raw)
assert not status["connect"].get("error"),status
relay=status["connect"].get("relayClient",{})
assert relay.get("status")=="available",relay
assert relay.get("version"),relay
assert status["providers"]["claude"]["installed"],status
assert status["providers"]["codex"]["installed"],status
assert not status["providers"]["claude"]["signedIn"],status
assert not status["providers"]["codex"]["signedIn"],status
print("PASS: simulated Supervisor can render the panel and obtain real CLI status; diagnostics are absent")
print("PASS: T3 recognizes the available cloudflared relay client at version " + relay["version"])
'''

options = {
    "remote_mode": "t3_connect", "lan_port": 3773, "log_level": "info",
    "claude_code_oauth_token": "", "anthropic_api_key": "", "openai_api_key": "",
    "auto_update_t3": False, "git_init_config": False, "enable_ha_mcp": True, "extra_project_dirs": [],
    "git_exclude_patterns": [".storage/", "*.db"], "git_auto_exclude_large": True,
}

supervisor_code = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/addons/self/options/config":
            body=json.dumps({"result":"ok", "data":json.load(open("/fixture/options.json"))}).encode()
            self.send_response(200)
        else:
            body=b'{"result":"error","message":"Not implemented in test Supervisor"}'
            self.send_response(404)
        self.send_header("Content-Type","application/json")
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if self.path != "/core/check" or self.headers.get("Authorization") != "Bearer local-test-token-not-a-credential":
            self.send_response(403); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.end_headers(); self.wfile.write(b'{"result":"ok","data":{}}')
HTTPServer(("0.0.0.0",80),Handler).serve_forever()
'''

with tempfile.TemporaryDirectory(prefix="t3ha-smoke-") as temporary:
    root = Path(temporary)
    data = root / "data"
    config = root / "config"
    data.mkdir()
    config.mkdir()
    (data / "options.json").write_text(json.dumps(options))
    (config / "configuration.yaml").write_text("default_config:\n")
    docker("network", "create", "--subnet", "172.30.32.0/24", network, capture_output=True)
    try:
        docker("run", "-d", "--name", supervisor, "--network", network,
               "--network-alias", "supervisor", "--ip", "172.30.32.2",
               "-v", f"{data}:/fixture:ro", "--entrypoint", "python3", image,
               "-c", supervisor_code, capture_output=True)
        docker("run", "-d", "--name", name, "--network", network, "--ip", "172.30.32.10",
               "-e", "SUPERVISOR_TOKEN=local-test-token-not-a-credential",
               "-v", f"{data}:/data", "-v", f"{config}:/config", image, capture_output=True)
        docker("exec", supervisor, "python3", "-c", probe, "allowed")
        docker("run", "--rm", "--network", network, "--ip", "172.30.32.3",
               "--entrypoint", "python3", image, "-c", probe, "denied")
        docker("exec", "-i", name, "python3", "-", input=(repo / "tests/mcp-smoke.py").read_text())
        docker("exec", name, "ha", "--help", capture_output=True)
        docker("exec", name, "ha", "core", "check")
        print("PASS: ha CLI sends an authenticated configuration-check request to the mock Supervisor")
        output = docker("logs", name, capture_output=True)
        logs = output.stdout + output.stderr
        print(logs)
        assert "Registered project: /config" in logs or "Project already registered: /config" in logs
        assert "ha-mcp configured for Claude Code" in logs
        assert "ha-mcp configured for Codex" in logs
        assert "ha-mcp configured for OpenCode" in logs
        assert "Starting: t3 serve" in logs
        assert "t3 serve exited" not in logs
        assert "Server exited; restarting selected runtime" not in logs
        assert "ERROR:" not in logs
        assert (config / "configuration.yaml").read_text() == "default_config:\n"
        print("PASS: project registration, MCP registration, and server startup with unchanged test configuration")
        options["remote_mode"] = ""
        (data / "options.json").write_text(json.dumps(options))
        rejected = subprocess.run(["docker", "run", "--rm", "--name", invalid,
                                   "--network", network, "-e", "SUPERVISOR_TOKEN=local-test-token",
                                   "-v", f"{data}:/data", "-v", f"{config}:/config", image],
                                  text=True, capture_output=True, timeout=30)
        rejected_logs = rejected.stdout + rejected.stderr
        assert rejected.returncode != 0, rejected_logs
        assert "refusing to start" in rejected_logs, rejected_logs
        assert "Starting: t3 serve" not in rejected_logs, rejected_logs
        print("PASS: invalid remote configuration fails closed before starting the server")
    except Exception:
        subprocess.run(["docker", "logs", name], check=False)
        raise
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, capture_output=True)
        subprocess.run(["docker", "rm", "-f", invalid], check=False, capture_output=True)
        subprocess.run(["docker", "rm", "-f", supervisor], check=False, capture_output=True)
        docker("network", "rm", network, capture_output=True)
        # The add-on runs as root and creates private directories such as
        # /data/t3-updates. Open them up so the runner can delete the fixture.
        subprocess.run(["docker", "run", "--rm", "-v", f"{root}:/fixture", "--entrypoint", "chmod",
                        image, "-R", "a+rwX", "/fixture"], check=False, capture_output=True)
