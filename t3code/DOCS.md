# T3 Code add-on

Runs a headless [T3 Code](https://github.com/pingdotgg/t3code) server inside Home Assistant.
You control it remotely from the T3 Code app (iOS, Android, web, or desktop). The add-on
itself only serves a small status page for signing in to T3 Connect.

## First run (T3 Connect)

1. Start the add-on and open the **T3 Code** panel in the sidebar.
2. Click **Start sign-in**. A login link appears.
3. Open the link on any device, sign in to your T3 account, and copy the one-time code.
4. Paste the code into the status page and submit.
5. Click **Restart server now**. The server links to T3 Connect and becomes reachable.
6. In the T3 Code app, sign in with the same account. The Home Assistant environment
   appears under T3 Connect.

The same instructions are printed in the add-on **Log** tab if you prefer to follow them
from there.

## Provider sign-in (Claude Code, Codex)

Provider logins are per machine, so signing in on your laptop does not sign in the add-on.
You have three options:

1. **Status page.** The T3 Code panel has a Providers section with a Sign in button for
   Claude Code and Codex. For Codex, open the OpenAI sign-in link and enter the
   device code displayed in the panel. Codex then completes sign-in automatically;
   no code needs to be pasted back into the panel. For Claude Code, open its login
   link and paste the authorization code back into the panel if the browser asks.
2. **Add-on options.** Set `claude_code_oauth_token` (from `claude setup-token` on a machine
   with a browser), `anthropic_api_key`, or `openai_api_key` in the add-on configuration and
   restart. These are passed to the CLIs as environment variables.
3. **T3 Code app.** Settings → Providers, if the app offers sign-in for this environment.

Credentials are stored in the add-on's `/data` directory and survive restarts and updates.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `remote_mode` | `t3_connect` | `t3_connect` uses the managed relay (no ports to open). `lan` binds the server to a port for direct pairing on your network. |
| `claude_code_oauth_token` | empty | Long-lived Claude subscription token from `claude setup-token`. |
| `anthropic_api_key` | empty | Anthropic API key for Claude Code (API billing). |
| `openai_api_key` | empty | OpenAI API key for Codex. |
| `lan_port` | `3773` | Port used in `lan` mode. Also expose it under the add-on's Network section. |
| `extra_project_dirs` | `[]` | Additional directories to register as T3 Code projects, for example `/addons/my-addon` or `/share/projects`. |
| `git_init_config` | `false` | Run `git init` in `/config` on start if it is not a repository. T3 Code works best with git projects. |
| `git_exclude_patterns` | HA data dirs, databases, logs, `custom_components/` | Patterns written to the repo-local `.git/info/exclude` of each project. T3 Code snapshots the whole working tree with `git add -A` before every turn and aborts after 30 seconds, so large untracked data must be excluded. Nothing is committed and your `.gitignore` is untouched. Remove `custom_components/` if you want agents' edits there covered by checkpoints. |
| `git_auto_exclude_large` | `true` | At start, any untracked top-level directory with 500+ files or 50+ MB is added to the managed excludes automatically (logged as a notice). Turn off if you need such a directory covered by checkpoints. |
| `auto_update_t3` | `true` | Check for a newer stable T3 release once at add-on startup. Disabling retains the selected installed version. |
| `enable_ha_mcp` | `true` | Configure the `ha-mcp` Home Assistant MCP server for Claude Code, Codex, and OpenCode. |
| `log_level` | `info` | T3 Code server log level. |

## LAN mode

Set `remote_mode: lan`, expose the port in the add-on's Network section, and restart. On each
start the log prints a connection string, token, and pairing URL. The host in that URL is the
container's address, so replace it with your Home Assistant IP before pasting it into the
T3 Code app. Treat the pairing URL as a password.

## Home Assistant MCP

The add-on ships `ha-mcp` and points each installed provider at it through the launcher
`/usr/local/bin/ha-mcp-server`, which injects the add-on's Supervisor token at run time. No
secrets are written into provider config files. The agents can read states, call services,
inspect history and logs, and manage automations. The `ha` CLI is available for Supervisor commands, including configuration checks and add-on management.

## Mounted directories

The add-on preserves the original mounts: `/config`, `/addons`, and `/share`
have read-write access, and `/ssl` has read-only access.
`/config` is registered as the default project.

## Security notes

- Anyone who can reach your T3 Connect account or a pairing link can run agents with full
  read-write access to your Home Assistant configuration. Protect that account.
- Provider CLIs run inside the container as root, as is standard for add-ons.
- The status server accepts only connections from the Supervisor ingress proxy at
  `172.30.32.2`. It does not trust forwarding headers from direct clients.
- Diagnostic endpoints, including shell execution and Claude prompting, are removed.
- The Core API permission grants administrator access, and the Supervisor manager
  role allows system configuration and add-on management. Those permissions are
  intentional so agents can configure Home Assistant. Disabling MCP registration
  does not revoke the API permissions or prevent agents from reading mounted files.
- Configuration secrets remain readable to agents. Git exclusions do not restrict
  file access or prevent agents from sending content to an AI provider.

## Troubleshooting

- **"Relay client" shows unsupported or missing**: the bundled `cloudflared` did not start.
  Check the log for details and open an issue with your architecture.
- **Signed in but not linked**: the server links on its next start. Restart the add-on.
- **Code rejected**: open the login link again to get a fresh code. Codes are single use.
- **Agent cannot see Home Assistant tools**: confirm `enable_ha_mcp` is on and check the log
  for "ha-mcp configured".

## T3 updates and recovery

`auto_update_t3` defaults to `true`. At add-on startup, before project registration
or T3 Connect commands, the add-on checks GitHub's latest non-prerelease T3 release.
It accepts only a stable `major.minor.patch` version newer than the current version.
Set `auto_update_t3: false` in the add-on configuration and restart to disable
checks. Disabling keeps the installed selection. It does not revert to the bundle.
The management panel's restart button and automatic crash restarts use the current
selection without checking again. Finish active work before restarting the add-on.

The updater downloads only T3's Linux ARM64 or x64 release archive and verifies
its SHA-256 against the release's `SHA256SUMS`. The archive includes its own Node
runtime and native dependencies. It does not change `/usr/local/bin/node`, npm's
provider installations, Claude Code, Codex, OpenCode, cloudflared, or system
packages. A future T3 release can include a newer embedded Node runtime. The
container's pinned Node 22 still runs the add-on management code. An incompatible
executable, system library requirement, or launcher protocol fails validation and
leaves the selected runtime in place. Updating the add-on may be needed for a new
launcher protocol or system library requirement.

Persistent files are separate from the provider CLIs:

| Path | Purpose |
| --- | --- |
| `/data/t3-updates/versions/<version>` | Validated immutable T3 archive contents. |
| `/data/t3-updates/state.json` | Active version, previous version, and pending trial or retained snapshot ID. |
| `/data/t3-updates/snapshots/<id>` | Private copy of `/data/t3code` before the trial. Treat it as credential-bearing data. |
| `/run/t3-executable` | Container-local selection used by `/usr/local/bin/t3` for all invocations. Recreated on startup. |
| `/opt/t3code-bundled/runtime/versions/0.1.6/t3` | Pinned initial fallback, downloaded and validated while building the image. |

`/data/home`, provider credentials and installations, and `/data/t3code` keep their
existing locations. Container replacement and add-on updates retain `/data`, so
the selected T3 version persists. The image bundle is used when no persistent
selection exists. Missing or invalid established state causes startup to refuse
rather than silently opening migrated data with an older bundle.

The release check has an eight-second deadline, with a five-second connection
limit. Download and extraction share a two-minute budget. Version and compatibility
checks have a fifteen-second limit each within that budget. Offline checks, HTTP
errors, rate limits, download errors, checksum mismatches, failed preflight, and
snapshot failures retain the working selection. Logs name the selected version,
staging, activation, fallback, and skipped failed trials. The updater does not log
CLI output, credential values, or environment variables. Ordinary T3 and provider
logs retain their existing behavior.

Before any candidate T3 command opens persistent data, the updater copies and
flushes the complete `/data/t3code` directory and records a pending trial durably.
The snapshot needs enough free storage for a complete copy, plus migration writes.
Data symlinks cause the update to be skipped because their targets could escape
the snapshot. Snapshot copying and flushing can take time on large data directories.
The network deadlines do not bound local disk operations.

The candidate must pass upstream's `__service-preflight` with launcher protocol 3.
At first server launch it receives a pending-update context over IPC. It must
report `prepared`, after migrations and startup acquisitions, before the manager
records activation and replies `committed`. The ingress panel starts after this
trial. The upstream activation gate keeps agent continuation, scheduled work, and
incoming commands from running before commit. The startup deadline is thirty
minutes, matching upstream's allowance for large migrations. A crash fails the
trial immediately. A hung trial can delay startup for the full deadline.

A failed or interrupted pending trial is stopped before the snapshot is restored.
The manager then selects the previous runtime. The snapshot, pending journal,
and restore procedure survive container replacement. The failed version is
recorded as `rejected` and skipped on subsequent starts until a newer release is
published. To retry that exact version, stop the add-on, preserve its data, and
remove only the `rejected` field from `state.json` before starting with updates
enabled. Do not delete the whole state file.

### Recovery limits

An executable downgrade does not undo database migrations. Automatic data restore
is limited to an uncommitted startup trial, before clients can use the candidate.
After activation, subsequent crashes restart that version and preserve new history.
They do not restore an old snapshot. Provider state in `/data/home`, attachments
outside `/data/t3code`, workspace files, and external side effects are outside the
snapshot. A future upstream bug that performs work before its activation gate
would be outside the manager's guarantees.

For a problem after activation, stop the add-on and make a full Home Assistant
backup before recovery. Prefer restoring a complete pre-update add-on backup.
For manual recovery with offline access to the add-on data, preserve the current
`/data/t3code` and `state.json`, then restore the matching retained snapshot to
`/data/t3code` and set `active` to the recorded `previous` version. Remove `pending`
if present and set `rejected` to the failed active version. Set `auto_update_t3`
to `false` before restarting. Confirm that the chosen runtime still exists. Do
not change only the executable selection or delete provider credentials. Restoring
a pre-update snapshot discards T3 history written after that snapshot. If the
snapshot or previous runtime is missing, use a complete backup rather than guess.

The updater retains previous runtimes and snapshots and does not prune them
automatically. Monitor `/data` usage. With the add-on stopped and a complete backup
available, old snapshots, `.stage` remnants, `.restore` remnants, `.failed` copies,
and unreferenced version directories can be removed. Keep the active and previous
runtimes, the snapshot named in `state.json`, and every snapshot referenced by a
pending trial. Never remove a pending trial's recovery files to free space.

### Upstream basis

The implementation was checked against T3 stable 0.1.7, commit
`322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`, and current upstream on 7 November 2026.
Both bundled 0.1.6 and stable 0.1.7 use launcher protocol 3. The npm latest manifest
reported 0.1.7 with `engines.node >=20.11`. The downloaded standalone archive runs
its embedded runtime, so that npm launcher requirement does not govern updates.

Upstream's [server update design](https://github.com/pingdotgg/t3code/blob/v0.1.7/docs/internals/server-updates.md)
uses a systemd/launchd launcher and IPC activation, and explains its SQLite rollback
boundary. The [release implementation](https://github.com/pingdotgg/t3code/blob/v0.1.7/apps/server/src/cloud/pinnedRuntime.ts)
verifies standalone archives. The add-on reuses those archive and activation
contracts, with container-owned persistent selection and a whole-directory snapshot.
It does not run `t3 update`, which also manages host service/launcher state and does
not own this add-on's startup loop. Remote update requests are rejected with an
instruction that this add-on updates only at add-on startup. Do not run `t3 update`
or install a T3 background service inside the add-on.
