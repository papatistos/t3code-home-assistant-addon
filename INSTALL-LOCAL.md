# Install a local copy of T3 Code

For normal installation, add `https://github.com/papatistos/t3code-home-assistant-addon`
to Home Assistant's repositories and install T3 Code as described in the README.
Use the instructions below only if you prefer a local source copy.

1. Make a Home Assistant backup and download a copy to another device.
2. Open Home Assistant's local add-on folder through Samba or Terminal & SSH.
   Current Home Assistant releases call the folder `local_apps` and mount it at
   `/local_apps` in Terminal & SSH. Older releases call the folder `addons` and
   mount it at `/addons`. Use the local add-on folder on your installation, not
   the Home Assistant configuration folder.
3. Extract the archive into the local add-on folder. The archive creates a new
   `t3code` folder. If a `t3code` folder already exists, stop and
   preserve the existing folder before proceeding. Alternatively, copy the
   checkout's `t3code` folder into the local add-on folder as `t3code`.
   The `Dockerfile` and `config.yaml` must be directly inside `t3code`.
4. In Settings > Apps > Install app, or Settings > Add-ons > Add-on store on older
   releases, select **Check for updates** from the menu and refresh the page.
5. Select **T3 Code** under Local apps/add-ons and install it.
   Home Assistant builds the patched source. The first build downloads several
   dependencies and can take several minutes.
6. Leave protection mode enabled. Leave the network port disabled for T3 Connect.
   Start the add-on, open its sidebar panel, and sign in to T3 Connect. Sign in
   to the desired provider through the panel or the T3 Code app.
7. Check the startup log and confirm that the project is registered and the
   server stays running. Connect from the T3 Code app and first request a
   read-only task before allowing changes to your configuration.

Home Assistant gives add-ons from different repositories, and local copies,
separate persistent data. Sign in again when moving between copies. Stop any
previous T3 Code add-on before using another copy against the same configuration.

The agents have the original Home Assistant access: write access to `/config`,
`/addons`, and `/share`, read access to `/ssl`, administrator access through the
Home Assistant Core API, and Supervisor manager access through the `ha` CLI or
API. The agents need that access for configuration editing, device control,
and add-on management. Configuration secrets remain accessible to the agents.
Keep agent approval prompts enabled and review proposed actions. Protect the T3
Connect account and treat a LAN pairing link as a password. Do not forward the
LAN port to the internet. Configuration content sent to an AI provider leaves
your Home Assistant machine.

Setting `enable_ha_mcp: false` skips MCP registration on a new installation.
The option does not revoke the add-on's API permissions or remove registrations
from a previous start. Stop the add-on to prevent all agent access.

The strict ingress check means direct requests from an SSH add-on to port 8099
return HTTP 403. Use the sidebar panel for sign-in and management.

Local builds do not automatically receive fixes from the original repository.
Review and rebuild dependency updates periodically. Debian security packages
remain updateable at build time; apt packages are not frozen to old versions.

The Home Assistant documentation describes the
[local installation process](https://contributors.home-assistant.io/apps/first-app/)
and the [ingress security boundary](https://contributors.home-assistant.io/apps/guides/ingress/).

## Verification of this local version

The ARM64 and x86-64 containers both built successfully. Both containers passed
six HTTP security regression tests, full startup with a mock Supervisor,
project and MCP registration, MCP initialization and tool listing, network
isolation between containers, and rejection of invalid startup configuration.
The MCP test called no device tools. The `ha` CLI also sent an authenticated
configuration-check request to the mock Supervisor. Dockerfile and shell lint
checks passed.
The npm audit and both Python lockfile audits reported no known vulnerabilities
on 31 October 2026. Audit results do not guarantee the absence of vulnerabilities.

The runtime pins are T3 0.1.6, Claude Code 2.1.316, Codex 0.166.0, OpenCode
1.19.5, ha-mcp 9.0.0, Node 22.23.4, Python 3.13.18, cloudflared 2026.5.2, and
Home Assistant CLI 5.6.0.

A real Home Assistant installation, provider sign-ins, T3 Connect pairing,
and authenticated device queries remain to be verified after installation.
