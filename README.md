# T3 Code for Home Assistant

[![Build add-on](https://github.com/oded996/t3code-home-assistant-addon/actions/workflows/builder.yaml/badge.svg)](https://github.com/oded996/t3code-home-assistant-addon/actions/workflows/builder.yaml)

Run a headless [T3 Code](https://github.com/pingdotgg/t3code) server on your Home Assistant
box and control AI coding agents (Claude Code, Codex, OpenCode) from the T3 Code app on your
phone or desktop through **T3 Connect**.

There is no T3 Code UI on Home Assistant itself. The add-on only exposes a small status page
to sign in to T3 Connect. Everything else, including provider logins, is done remotely from
the T3 Code app.

## Install the hardened local version

Follow [INSTALL-LOCAL.md](INSTALL-LOCAL.md). Copy the patched source into Home
Assistant's local add-on folder and install **T3 Code (hardened local)**.
The patched configuration builds locally and does not pull the original container.

This checkout restricts the management server to the Supervisor ingress proxy,
removes diagnostic endpoints, and limits mounted folders to `/config`.
Supervisor management access is disabled. Home Assistant Core API access remains
available for device control and automation management.

The T3 server and provider CLIs use an npm integrity lockfile. The Home Assistant
MCP server uses architecture-specific Python hash lockfiles. Node, Python, and
Home Assistant base images are pinned by digest. The Cloudflare relay executable
is checked against its published SHA-256 digest.

See [t3code/DOCS.md](t3code/DOCS.md) for configuration and
[TESTING.md](TESTING.md) for verification.

## Development

Home Assistant builds the patched add-on from local source. To test a build with
the official Home Assistant builder:

```bash
docker run --rm --privileged -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD":/data ghcr.io/home-assistant/amd64-builder --test --amd64 --target t3code
```
