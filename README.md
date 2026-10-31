# T3 Code for Home Assistant

[![Build add-on](https://github.com/papatistos/t3code-home-assistant-addon/actions/workflows/builder.yaml/badge.svg)](https://github.com/papatistos/t3code-home-assistant-addon/actions/workflows/builder.yaml)

Run a headless [T3 Code](https://github.com/pingdotgg/t3code) server on your Home Assistant
box and control AI coding agents (Claude Code, Codex, OpenCode) from the T3 Code app on your
phone or desktop through **T3 Connect**.

The Home Assistant sidebar panel manages T3 Connect and provider sign-ins.
Use the T3 Code app to work with agents.

## Install

1. Open Settings > Apps > Install app, or Settings > Add-ons > Add-on store on older releases.
2. Open the menu, select Repositories, and add:

   ```text
   https://github.com/papatistos/t3code-home-assistant-addon
   ```

3. Install **T3 Code** from **T3 Code for Home Assistant**. Home Assistant builds
   the add-on from this fork's source. The first build can take several minutes.
4. Start the add-on and open its sidebar panel to sign in to T3 Connect and your
   provider. Open the T3 Code app with the same T3 account to connect.

Keep protection mode enabled. Leave the network port disabled when using T3 Connect.
See [INSTALL-LOCAL.md](INSTALL-LOCAL.md) if you prefer installing a local copy.

This repository is a fork of
[oded996/t3code-home-assistant-addon](https://github.com/oded996/t3code-home-assistant-addon).

This checkout restricts the management server to the Supervisor ingress proxy,
removes diagnostic endpoints, and preserves the original Home Assistant access.
Agents can edit `/config`, `/addons`, and `/share`, read `/ssl`, and use the
Home Assistant Core API and Supervisor manager API to configure the system.
The `ha` CLI is installed at a pinned version with checksum verification.

The T3 server and provider CLIs use an npm integrity lockfile. The Home Assistant
MCP server uses architecture-specific Python hash lockfiles. Node, Python, and
Home Assistant base images are pinned by digest. The Cloudflare relay executable
is checked against its published SHA-256 digest.

See [t3code/DOCS.md](t3code/DOCS.md) for configuration and
[TESTING.md](TESTING.md) for verification.

## Development

Home Assistant builds the add-on from the repository source. To test a build with
the official Home Assistant builder:

```bash
docker run --rm --privileged -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD":/data ghcr.io/home-assistant/amd64-builder --test --amd64 --target t3code
```
