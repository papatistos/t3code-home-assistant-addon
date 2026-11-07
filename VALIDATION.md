# Validation of persistent T3 updates

The development checkout starts from add-on commit
`6b8dea42cb28959bb083a53e1106876b3eca2416`. GitHub HEAD was verified at that commit
on 7 November 2026. No live Home Assistant installation was changed or restarted.

## Local results

- All 47 tests passed under a temporary official Node 22.23.4 executable on macOS
  ARM64. This includes 32 updater tests, all nine existing HTTP/security/device
  login tests, and six manual-update panel tests. Temporary HTTP fixtures required execution outside the sandbox.
- The 32 updater tests also passed with Node 22 inside the filesystem sandbox.
  Manual-update tests verify immediate installation after a click, including
  graceful shutdown before copying data, activation, and automatic recovery after
  a failed first start. The copy includes final shutdown writes. Requests work
  with automatic updates disabled and can recover offline after interruption.
  Panel tests cover supervisor IPC, access controls, duplicate clicks, management
  command exclusion during an update, safe failure messages, and escaped values.
  Archive fixtures cover ARM64 and x64 asset selection, not native Linux execution.
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
