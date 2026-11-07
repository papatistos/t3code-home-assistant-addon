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

## Changes from the original

Compared with the original add-on at version 0.1.8:

- The management panel accepts only Home Assistant ingress connections and rejects cross-site requests and invalid sign-in input.
- The diagnostic HTTP endpoints for shell execution, Claude prompts, logs, and Git operations are removed.
- T3 is updated from 0.0.40 to 0.1.6, and ha-mcp is updated from 3.5.1 to 9.0.0 to address dependency advisories.
- Dependency lockfiles, pinned runtime images, executable checksums, and pinned CI actions make builds more predictable and verifiable.
- Startup rejects invalid connection settings, creates private credential files, and limits Git's automatic directory trust to `/config`.
- Home Assistant builds the add-on from this fork's source instead of pulling the original author's container image.
- Automated tests verify management access controls, startup, MCP communication, and the `ha` CLI in ARM64 and x86-64 Docker containers.

The original Home Assistant access is preserved. Agents can write to `/config`,
`/addons`, and `/share`, read `/ssl`, and use the Home Assistant Core administrator
API, Supervisor manager API, and `ha` CLI to configure Home Assistant.

T3 checks for a newer stable release at add-on startup and keeps installed versions
under `/data/t3-updates`, independently of add-on releases. Set `auto_update_t3: false`
to stop automatic checks and keep the selected version. The sidebar panel also
has a **Download T3 update** button. It downloads an update without interrupting
your work; restart the add-on in Home Assistant when you are ready to install it. The bundled T3 0.1.6 remains
the initial fallback. Provider CLIs and the system Node.js remain pinned.
Read [update operation and recovery](t3code/DOCS.md#t3-updates-and-recovery)
before enabling this on valuable T3 history.

See [t3code/DOCS.md](t3code/DOCS.md) for configuration and
[TESTING.md](TESTING.md) for verification.

## Development

Home Assistant builds the add-on from the repository source. The Dockerfile
selects its Debian base directly for each architecture, even when Supervisor
passes its default Alpine `BUILD_FROM` argument. Build settings do not depend
on `build.yaml`.

See [TESTING.md](TESTING.md) for Supervisor-style builds and container checks.
