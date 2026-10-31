# Verify the add-on

## HTTP security regression tests

Run `node --test tests/*.test.mjs` with Node 22 or later. The tests open temporary
loopback ports and use fake CLI responses. They do not call an AI provider.

The tests verify the TCP-peer allowlist, rejection of spoofed forwarding headers,
removal of all diagnostics, ingress management routing, cross-site and content-type
checks, authorization-code validation, request size limits, and safe ingress-path
rendering.

## Build each architecture

The Dockerfile selects a digest-pinned Debian base for `BUILD_ARCH`. It does not
use Supervisor's `BUILD_FROM` override or the deprecated `build.yaml` file.
For ARM64, set the Docker platform to `linux/arm64` and `BUILD_ARCH=aarch64`.
For x86-64, use `linux/amd64` and `BUILD_ARCH=amd64`.

Use Supervisor's default Alpine argument deliberately when testing. The build
must still select Debian and complete successfully:

```sh
docker buildx build t3code \
  --file t3code/Dockerfile \
  --platform linux/amd64 --pull \
  --build-arg BUILD_VERSION=0.1.12 \
  --build-arg BUILD_ARCH=amd64 \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/base:latest \
  -t t3code-ha:0.1.12-amd64
```

Check the provider versions, `t3 serve --help`, and `ha-mcp --help` inside the
container before using credentials. Run the HTTP regression tests on Node 22 in
the container as well.

Run `python3 tests/container-smoke.py t3code-ha:0.1.12-amd64` to verify
full startup, real TCP-peer filtering, and the MCP initialization and tool-list
handshake. The test creates an isolated Docker network, a mock Supervisor, and
temporary configuration files. The test calls no device tools and uses no real
provider credentials. Run the x86-64 image test separately because both tests
use the Supervisor's fixed subnet. The test also checks that the `ha` CLI sends
an authenticated configuration-check request to the mock Supervisor.

## Update dependency locks

Update direct npm versions deliberately in `t3code/package.json`, then run
`npm install --package-lock-only --ignore-scripts` in `t3code` and review the diff.
Run `npm audit --omit=dev` against the resulting lockfile.

Generate Python locks on Linux with Python 3.13, pip 25.3, and pip-tools 7.5.2.
Run `pip-compile --generate-hashes --strip-extras` against `requirements.in` once
per supported architecture, writing `requirements-aarch64.lock` and
`requirements-amd64.lock`. Architecture-specific locks preserve dependencies
selected by platform markers. Run `pip-audit` against each lock.

When updating Cloudflare or the Home Assistant CLI, update the download version
and each architecture's expected SHA-256 digest in the Dockerfile from the
official GitHub release.
Review base-image digest updates in the Dockerfile.
Debian security packages remain updateable during builds.

## Verify in Home Assistant

After installing from [INSTALL-LOCAL.md](INSTALL-LOCAL.md), confirm that the
add-on starts, registers `/config`, and configures MCP for installed providers.
Open the sidebar panel to sign in. Direct requests from another add-on to port
8099 must return HTTP 403, including requests with spoofed ingress headers.

Confirm T3 Connect pairing or LAN pairing, provider sign-in, and a read-only
agent task. With MCP enabled, verify a read-only entity query before allowing
configuration edits or service calls. Device actions, provider authentication,
and real Home Assistant API requests require a live installation and are not
established by local container tests.
