ARG BUILD_ARCH=amd64
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node-runtime
FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f AS python-runtime
FROM ghcr.io/home-assistant/amd64-base-debian:bookworm@sha256:ace0614750c6347ad5833b57f6adb0d576c31d1f8725efe38a1fb318512edf49 AS ha-base-amd64
FROM ghcr.io/home-assistant/aarch64-base-debian:bookworm@sha256:19c262f6a05c25fe280fa7b54fc9172d6461e90c7714d82a03eb041e83ee6a8e AS ha-base-aarch64
# Supervisor supplies an Alpine BUILD_FROM by default. Select our Debian base
# directly by architecture so source builds do not depend on deprecated build.yaml.
# hadolint ignore=DL3006
FROM ha-base-${BUILD_ARCH}

ARG BUILD_ARCH

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
# Materialize the pinned T3 archive in the image, outside HOME/T3CODE_HOME. The npm
# launcher otherwise downloads again after startup switches to persistent /data.
COPY package.json package-lock.json /opt/t3code-runtime/
RUN npm ci --loglevel=info --prefix /opt/t3code-runtime --omit=dev --no-fund --no-audit \
    && for cli in claude codex opencode pi; do \
        ln -s "/opt/t3code-runtime/node_modules/.bin/${cli}" "/usr/local/bin/${cli}"; \
    done \
    && pi --version \
    && opencode --version \
    && npm cache clean --force \
    && T3CODE_HOME=/opt/t3code-bundled /opt/t3code-runtime/node_modules/.bin/t3 --version \
    && /opt/t3code-bundled/runtime/versions/0.1.6/t3 --version

ARG CLOUDFLARED_VERSION=2026.10.7
# cloudflared: the T3 Connect relay client. Preinstalled so the add-on
# never has to download it at runtime (T3CODE_CLOUDFLARED_PATH points here).
RUN case "${BUILD_ARCH}" in \
        amd64)   CF_ARCH="amd64"; CF_SHA256="1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872" ;; \
        aarch64) CF_ARCH="arm64"; CF_SHA256="3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775" ;; \
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

ARG HA_CLI_VERSION=5.6.0
# Keep Supervisor configuration workflows available, with a verified CLI binary.
RUN case "${BUILD_ARCH}" in \
        amd64) HA_SHA256="9d259c700bfcd45b6a793709e1fcfd304a595624dda10cfa5edde66f0b8a9656" ;; \
        aarch64) HA_SHA256="4ecdbd67002defbf96e4668e62f631e9767b92d18e1ce54bfee6ddd040c20e73" ;; \
        *) echo "Unsupported BUILD_ARCH: ${BUILD_ARCH}" && exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/local/bin/ha \
        "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/ha_${BUILD_ARCH}" \
    && echo "${HA_SHA256}  /usr/local/bin/ha" | sha256sum -c - \
    && chmod +x /usr/local/bin/ha

COPY rootfs/ /
RUN chmod +x /run.sh /opt/t3code/*.sh /usr/local/bin/ha-mcp-server /usr/local/bin/t3

ENV HOME=/data/home \
    T3CODE_HOME=/data/t3code \
    T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    T3CODE_TELEMETRY_ENABLED=false \
    NODE_OPTIONS=--no-warnings

LABEL org.opencontainers.image.title="Home Assistant Add-on: T3 Code" \
      org.opencontainers.image.description="Headless T3 Code server with T3 Connect remote access" \
      org.opencontainers.image.source="https://github.com/papatistos/t3code-home-assistant-addon" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /config
CMD ["/run.sh"]
