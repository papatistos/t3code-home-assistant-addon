#!/usr/bin/env python3
"""Check the installed stdio launcher without calling any Home Assistant tools."""
import json
import selectors
import subprocess
import tempfile
import time

with tempfile.TemporaryFile(mode="w+") as errors:
    process = subprocess.Popen(["/usr/local/bin/ha-mcp-server"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=errors, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def receive(identifier):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if not selector.select(timeout=1):
                if process.poll() is not None:
                    break
                continue
            line = process.stdout.readline()
            if not line:
                break
            message = json.loads(line)
            if message.get("id") == identifier:
                assert "error" not in message, message
                return message["result"]
        errors.seek(0)
        raise AssertionError("MCP response missing: " + errors.read()[-4000:])

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "local-security-smoke", "version": "1.0"}}})
        initialized = receive(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = receive(2)["tools"]
        assert tools, "MCP must advertise tools"
        print(f"PASS: MCP initialized with protocol {initialized['protocolVersion']} and advertised {len(tools)} tools; no tools called")
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
