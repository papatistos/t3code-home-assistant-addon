ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm@sha256:ace0614750c6347ad5833b57f6adb0d576c31d1f8725efe38a1fb318512edf49
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node-runtime
FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f AS python-runtime
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG CLOUDFLARED_VERSION=2026.5.2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git jq nano vim-tiny less procps \
        util-linux bsdutils openssh-client bubblewrap \
        python3 python3-pip python3-venv \
        build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Node.js and npm come from a digest-pinned official image on the same Debian release.
COPY --from=python-runtime /usr/local/ /usr/local/
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ldconfig

# npm ci checks the integrity hashes and versions of the complete dependency tree.
COPY package.json package-lock.json /opt/t3code-runtime/
RUN npm ci --prefix /opt/t3code-runtime --omit=dev --no-fund --no-audit \
    && for cli in t3 claude codex opencode; do \
        ln -s "/opt/t3code-runtime/node_modules/.bin/${cli}" "/usr/local/bin/${cli}"; \
    done \
    && npm cache clean --force \
    && t3 --version

# cloudflared: the T3 Connect relay client. Preinstalled so the add-on
# never has to download it at runtime (T3CODE_CLOUDFLARED_PATH points here).
RUN case "${BUILD_ARCH}" in \
        amd64)   CF_ARCH="amd64"; CF_SHA256="5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886" ;; \
        aarch64) CF_ARCH="arm64"; CF_SHA256="5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815" ;; \
        *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH}" && exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CF_ARCH}" \
    && echo "${CF_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

# ha-mcp: Home Assistant MCP server (https://github.com/homeassistant-ai/ha-mcp)
COPY requirements-${BUILD_ARCH}.lock /opt/ha-mcp-requirements.lock
RUN python3 -m venv /opt/ha-mcp \
    && /opt/ha-mcp/bin/pip install --no-cache-dir --require-hashes -r /opt/ha-mcp-requirements.lock \
    && ln -s /opt/ha-mcp/bin/ha-mcp /usr/local/bin/ha-mcp

COPY rootfs/ /
RUN chmod +x /run.sh /opt/t3code/*.sh /usr/local/bin/ha-mcp-server

ENV HOME=/data/home \
    T3CODE_HOME=/data/t3code \
    T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    T3CODE_TELEMETRY_ENABLED=false \
    NODE_OPTIONS=--no-warnings

WORKDIR /config
CMD ["/run.sh"]
