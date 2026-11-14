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
