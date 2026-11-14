# OpenCode v2 replacement for 0.1.18

- All 83 Node tests passed. The v1 package and platform packages are absent from
  the lockfile; v2 Linux x64, x64-baseline, and arm64 packages are pinned at 2.3.0.
- A clean npm installation plus the required `@opencode/cli` postinstall ran
  the actual v2 binary on macOS. Docker's existing `npm ci` enables postinstall.
- The real-CLI smoke test used disposable HOME/XDG directories and fictional
  credentials. It verified legacy OAuth import, token-free JSON account metadata,
  normalization of the existing HA MCP configuration, and account-specific logout
  while retaining another provider's credential.
- Panel tests cover v2 login output, failed/malformed status, reauthentication,
  multiple-account logout, preservation of API keys, and ingress protection.
- Existing non-OpenCode locked package versions remained unchanged.
- Linux container execution and live HA inference remain unverified. No live
  provider data was migrated, no HA restart occurred, and nothing was published.
  A backup of HA configuration and add-on data is required before installation.

# Updater fix and live provider diagnosis for 0.1.17

- Integrated the previously unmerged version parser fix from `a1e0d6d`.
  The parser covers current-version comparisons, downloaded executable validation,
  and the startup trial's previous-version metadata.
- All 81 Node tests passed, including update activation and rollback with test
  executables that print the actual `t3 v…` format.
- Live HA inspection confirmed add-on 0.1.16, T3 0.1.6, Pi 1.5.2,
  OpenCode 1.19.5, and Node 22.23.4. Provider HOME successfully resolves to
  `/config/.t3code/provider-home`.
- Live OpenCode has an OpenAI OAuth credential and lists 26 OpenAI models.
  Persisted T3 settings do not enable OpenCode or Pi; matching-version T3
  defaults disable both providers.
- Live Pi reports `credentials_not_configured`, and its model list is empty.
  Authentication, T3 enablement/refresh, and actual model calls remain necessary.
- Docker is unavailable locally. The 0.1.17 Linux image, live update activation,
  and authenticated Pi/OpenCode model turns have not yet been verified.

# Pi provider addition

The add-on now bundles Pi 1.5.2 and exposes `/usr/local/bin/pi`.

- All 80 Node tests passed locally.
- A clean `npm ci --ignore-scripts` installation reported Pi 1.5.2.
- Pi answered an RPC `get_state` request with an isolated HOME and no credentials.
- Existing locked package versions remained unchanged when Pi was added.
- Shell syntax and whitespace checks passed.
- Docker remains unavailable locally. The Linux image build, container smoke test,
  live T3 discovery, authentication, and model turns still need deployment validation.
- No GitHub publication or HA restart was performed.

# Provider storage change, 14 November 2026

The change starts from local main commit `46eae65`. No live Home Assistant data
was inspected or modified. The T3 thread tools were unavailable in this session.

- The complete suite passed 78 tests on Node 26.13.0 and Python 3.15.1 on macOS,
  including all 14 provider storage migration tests.
- `bash -n` and `git diff --check` passed. ShellCheck and Hadolint were not installed.
- The migration preserves the original provider home and keeps `/data/home` as a
  symlink. Migration tests use disposable data and fictional credentials.
- Docker could not connect to the configured OrbStack socket. Linux container
  builds, the expanded container smoke test, and live provider session resumption
  remain unverified. No publication or deployment was performed.

The earlier validation record below concerns the preceding updater work.

# Validation of persistent T3 updates

The development checkout starts from add-on commit
`6b8dea42cb28959bb083a53e1106876b3eca2416`. GitHub HEAD was verified at that commit
on 7 November 2026. No live Home Assistant installation was changed or restarted.

## Local results

- All 59 tests passed under a temporary official Node 22.23.4 executable on macOS
  ARM64. This includes 44 updater tests, all nine existing HTTP/security/device
  login tests, and six manual-update panel tests. Temporary HTTP fixtures required execution outside the sandbox.
- Manual-update tests verify immediate installation after a click, including
  graceful shutdown before copying data, activation, and automatic recovery after
  a failed first start. The copy includes final shutdown writes. Requests work
  with automatic updates disabled and can recover offline after interruption.
  Panel tests cover supervisor IPC, access controls, duplicate clicks, management
  command exclusion during an update, safe failure messages, and escaped values.
  Archive fixtures cover ARM64 and x64 asset selection, not native Linux execution.
- Cleanup tests verify that activation and rollback save completed state before
  removing snapshots and obsolete runtimes. They cover `.stage-*`, `.stage`,
  `.restore`, `.failed`, and `latest.json` leftovers, preservation of pending
  recovery files, crashes after state save and before deletion, failed state
  writes, failed deletion and directory listing, retry at the next startup,
  and retention of the active runtime and image bundle. Existing offline manual
  update recovery still passes. Old `previous` and `snapshot` fields are removed,
  while `rejected` remains. No backup exclusions were added.
- Exact source from upstream tags 0.1.6 and current latest 0.1.7 was fetched again
  for the cleanup change. In both tags, `scripts/npm-launcher/t3.mjs` downloads
  into the home-relative `runtime/versions` directory. The standalone executable
  builds the server CLI, whose `cli/update.ts` still calls
  `ensurePinnedRuntimeInstalled` with the selected home directory. Its
  `cloud/pinnedRuntime.ts` uses that home's `runtime/versions` directory and also
  reads service state under `runtime`. This did not establish that
  `/data/t3code/runtime` is unused or safe to omit from rollback. The directory
  is therefore preserved and included in snapshots; a regression test verifies
  both choices. No live add-on data was inspected.
  Source references for both tags are
  [0.1.6 update](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/cli/update.ts),
  [0.1.7 update](https://github.com/pingdotgg/t3code/blob/v0.1.7/apps/server/src/cli/update.ts),
  [0.1.6 runtime paths](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/cloud/pinnedRuntime.ts),
  and [0.1.7 runtime paths](https://github.com/pingdotgg/t3code/blob/v0.1.7/apps/server/src/cloud/pinnedRuntime.ts).
- `bash -n` passed for startup, helper scripts, and the MCP wrapper. `sh -n`
  passed for the new T3 wrapper. JavaScript and Python syntax checks passed.
- `git diff --check` passed. Add-on/package/lockfile versions agree at 0.1.14.
  A parsed comparison confirmed the dependency lock contains no changes apart
  from release metadata. All provider and system dependency pins remain unchanged.
- ShellCheck and Hadolint executables are not installed on this Mac, so their
  lint checks remain unrun locally. Existing CI lint checks remain enabled and
  ShellCheck now includes the new T3 wrapper.
- Exact upstream 0.1.6/0.1.7 release source confirmed launcher protocol 3, preflight,
  activation gating, and the npm launcher's data-directory-dependent cache. The
  latest npm manifest reported stable 0.1.7 with Node >=20.11. The updater installs
  upstream's standalone archive, which includes its own runtime.

## Container limitations

For the cleanup change, `docker info` was checked against both the configured
OrbStack context and the default context. Neither could connect. The OrbStack,
default Docker, and standard colima sockets were absent; Docker Desktop and
OrbStack were absent at their standard application paths, and no colima command
was available. No engine was started or installed. Both architecture container
checks therefore remain unrun for the cleanup change.


ARM64 and AMD64 Docker build commands were attempted with the Supervisor-style
`BUILD_FROM` override from TESTING.md. Docker could not connect because the
configured OrbStack socket `/Users/xhauch/.orbstack/run/docker.sock` does not exist.
The default `/var/run/docker.sock` also does not exist. Docker Desktop and OrbStack
were not found at their standard `/Applications` paths. No Docker engine was
started or installed.

Consequently neither image build, real native CLI execution, Node tests inside
those images, `ha-mcp --help`, container replacement with a persistent volume,
nor `tests/container-smoke.py` could be validated locally for this change. CI is
configured to build and test both architectures but has not run on this unpushed
branch. Unit fixtures do not substitute for those checks.

Real Home Assistant ingress, provider sign-ins, T3 Connect pairing, device queries,
and real release activation with existing T3 history remain untested. A successful
unit trial does not prove every future upstream migration is reversible.
