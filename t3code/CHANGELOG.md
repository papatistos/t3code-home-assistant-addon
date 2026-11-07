## 0.1.14

- Add a manual **Download T3 update** button to the sidebar panel. It shows the running and downloaded versions, keeps sessions running, and installs the requested update at the next add-on restart, including when automatic updates are disabled.

- Check for stable T3 updates once at add-on startup, enabled by default through `auto_update_t3`.
- Materialize the pinned fallback executable in the image so first offline startup does not require the npm launcher to download it again.
- Keep checksummed T3 runtimes in persistent storage, separate from the pinned provider CLIs and Node.js.
- Stage updates, snapshot T3 data, and require upstream protocol-3 startup preparation before activation. Restore data and the previous runtime if a trial fails or is interrupted.
- Route every T3 invocation through one selection, including the management panel and T3 Connect. Retain the selected version when automatic updates are disabled.
- Add update, persistence, timeout, and rollback regression tests and document recovery limits.

## 0.1.13

- Show the Codex device code printed on a separate terminal line, including ANSI-colored and fragmented output.
- Direct users to enter the device code on OpenAI's sign-in page and wait for automatic completion. Remove the unused paste-back field for Codex.
- Add regression tests using fictional Codex device-login output, without starting a real authentication request.

## 0.1.12

- Update the cloudflared relay client from 2026.5.2 to 2026.10.7 with verified SHA-256 checksums for amd64 and ARM64.

## 0.1.11

- Select the architecture-specific Debian base directly in the Dockerfile so Supervisor's Alpine BUILD_FROM default cannot break installation.
- Remove deprecated build.yaml and keep build parameters and labels in the Dockerfile.
- Test source builds with the same default base argument used by Supervisor.

## Fork distribution

- Use the original T3 Code name and slug in the papatistos repository.
- Install from the fork URL with a source build in Home Assistant.
- Keep CI builds as tests without publishing container images.

## 0.1.10 (hardened local)

- Preserve the original Supervisor manager permissions and mounts for configuration, add-ons, shared files, and SSL certificates so agents can configure Home Assistant fully.
- Restore the `ha` CLI at version 5.6.0 with checksum verification for both architectures.
- Keep ingress access checks, diagnostic removal, locked dependencies, and fail-closed startup behavior.

## 0.1.9 (hardened local)

- Restrict status management to the Supervisor ingress proxy and reject cross-site mutations.
- Remove all diagnostic endpoints and the debug shell option.
- Validate and limit authorization-code requests.
- Remove Supervisor management access and mounts for add-ons, shared files, and SSL certificates.
- Build patched source locally under the `t3code_hardened` slug.
- Upgrade T3 and ha-mcp to address dependency advisories and lock package integrity hashes.
- Pin runtime images by digest and verify the Cloudflare executable checksum.
- Add HTTP security regression tests and local installation instructions.

## 0.1.8

- Development option `debug_shell` exposing POST /api/diag/exec (off by default).

## 0.1.7

- Diagnostics: GET /api/diag/logs lists and tails T3 Code's own log files (server trace, provider logs).

## 0.1.6

- Auto-exclude large untracked top-level directories (500+ files or 50+ MB) from T3 Code checkpoints (`git_auto_exclude_large`).
- Diagnostics: POST /api/diag/checkpoint times the exact checkpoint git sequence inside the container.

## 0.1.5

- Fix turns failing with "Claude runtime stream failed": T3 Code snapshots /config with git add -A before each turn and timed out on large untracked HA data. New `git_exclude_patterns` option writes excludes to .git/info/exclude.
- Diagnostics: /api/diag/git reports git status timing and untracked counts.

## 0.1.4

- Fix sign-in links polluted by terminal hyperlink escape codes.
- Read-only diagnostics endpoints on the status server (/api/diag, /api/diag/claude).

## 0.1.3

- Status page: sign in to Claude Code and Codex on this server (headless login flows).
- New options claude_code_oauth_token, anthropic_api_key, openai_api_key as an alternative.

## 0.1.2

- Add bubblewrap for the Codex sandbox.
- Log the output of `t3 project add` so registration problems are visible.

## 0.1.1

- Fix startup crash: t3 rejects lowercase T3CODE_LOG_LEVEL; pass --log-level only.
- Fix status page and startup check failing to parse `t3 connect status --json` output.
- Disable bashio errexit so a failed `t3 serve` is retried instead of stopping the add-on.
- Log which CLIs are present at startup.

## 0.1.0

- Initial release: headless `t3 serve`, T3 Connect sign-in through the ingress status page,
  LAN pairing mode, `/config` project registration, `ha-mcp` for Claude Code / Codex / OpenCode.
