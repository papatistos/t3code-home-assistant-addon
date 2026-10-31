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
   Claude Code and Codex. It shows a login link to open on any device; if the browser
   returns a code, paste it back into the page.
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
| `extra_project_dirs` | `[]` | Additional directories to register as T3 Code projects, for example `/config/projects/example`. |
| `git_init_config` | `false` | Run `git init` in `/config` on start if it is not a repository. T3 Code works best with git projects. |
| `git_exclude_patterns` | HA data dirs, databases, logs, `custom_components/` | Patterns written to the repo-local `.git/info/exclude` of each project. T3 Code snapshots the whole working tree with `git add -A` before every turn and aborts after 30 seconds, so large untracked data must be excluded. Nothing is committed and your `.gitignore` is untouched. Remove `custom_components/` if you want agents' edits there covered by checkpoints. |
| `git_auto_exclude_large` | `true` | At start, any untracked top-level directory with 500+ files or 50+ MB is added to the managed excludes automatically (logged as a notice). Turn off if you need such a directory covered by checkpoints. |
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
inspect history and logs, and manage automations. Supervisor management access is disabled, and the `ha` CLI is not installed.

## Mounted directories

`/config` is the only mounted host directory, with read-write access.
The add-on does not mount shared files, other add-on files, or SSL certificates.
`/config` is registered as the default project.

## Security notes

- Anyone who can reach your T3 Connect account or a pairing link can run agents with full
  read-write access to your Home Assistant configuration. Protect that account.
- Provider CLIs run inside the container as root, as is standard for add-ons.
- The status server accepts only connections from the Supervisor ingress proxy at
  `172.30.32.2`. It does not trust forwarding headers from direct clients.
- Diagnostic endpoints, including shell execution and Claude prompting, are removed.
- The Core API permission grants administrator access. Disabling MCP registration
  does not revoke the Core API permission or prevent agents from reading `/config`.
- Configuration secrets remain readable to agents. Git exclusions do not restrict
  file access or prevent agents from sending content to an AI provider.

## Troubleshooting

- **"Relay client" shows unsupported or missing**: the bundled `cloudflared` did not start.
  Check the log for details and open an issue with your architecture.
- **Signed in but not linked**: the server links on its next start. Restart the add-on.
- **Code rejected**: open the login link again to get a fresh code. Codes are single use.
- **Agent cannot see Home Assistant tools**: confirm `enable_ha_mcp` is on and check the log
  for "ha-mcp configured".
