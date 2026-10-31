#!/usr/bin/with-contenv bashio
# T3 Code add-on entrypoint.
# bashio enables errexit/nounset; we manage failures ourselves.
set +o errexit +o nounset
set -o pipefail

export HOME=/data/home
export T3CODE_HOME=/data/t3code
export T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared
export T3CODE_TELEMETRY_ENABLED=false

REMOTE_MODE=$(bashio::config 'remote_mode' 't3_connect')
LAN_PORT=$(bashio::config 'lan_port' '3773')
LOG_LEVEL=$(bashio::config 'log_level' 'info')
GIT_INIT_CONFIG=$(bashio::config 'git_init_config' 'false')
ENABLE_HA_MCP=$(bashio::config 'enable_ha_mcp' 'true')

# Optional provider credentials (alternative to signing in from the status page).
if bashio::config.has_value claude_code_oauth_token; then
    CLAUDE_CODE_OAUTH_TOKEN=$(bashio::config claude_code_oauth_token)
    export CLAUDE_CODE_OAUTH_TOKEN
fi
if bashio::config.has_value anthropic_api_key; then
    ANTHROPIC_API_KEY=$(bashio::config anthropic_api_key)
    export ANTHROPIC_API_KEY
fi
if bashio::config.has_value openai_api_key; then
    OPENAI_API_KEY=$(bashio::config openai_api_key)
    export OPENAI_API_KEY
fi

export T3CODE_REMOTE_MODE="${REMOTE_MODE}"
export T3CODE_LAN_PORT="${LAN_PORT}"

bashio::log.info "T3 Code add-on starting (t3 $(t3 --version 2>/dev/null || echo unknown), mode: ${REMOTE_MODE})"
for cli in claude codex opencode cloudflared ha ha-mcp; do
    if command -v "${cli}" >/dev/null 2>&1; then
        bashio::log.info "  found ${cli}: $(command -v "${cli}")"
    else
        bashio::log.warning "  missing ${cli}"
    fi
done

# ---------------------------------------------------------------------------
# Persistent state
# ---------------------------------------------------------------------------
mkdir -p "${HOME}" "${T3CODE_HOME}" "${HOME}/.config"
git config --global --add safe.directory '*' 2>/dev/null || true
if ! git config --global user.email >/dev/null 2>&1; then
    git config --global user.email "t3code@homeassistant.local"
    git config --global user.name "T3 Code"
fi

if [ "${GIT_INIT_CONFIG}" = "true" ] && [ ! -d /config/.git ]; then
    bashio::log.info "Initializing git repository in /config"
    git -C /config init -q
fi

# T3 Code snapshots the whole working tree (git add -A) before every turn. Large
# untracked Home Assistant data (databases, caches, HACS components) makes that
# time out, so write exclude patterns to the repo-local .git/info/exclude.
/opt/t3code/git-excludes.sh || bashio::log.warning "git exclude setup had errors (continuing)"

# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
/opt/t3code/register-projects.sh || bashio::log.warning "Project registration had errors (continuing)"

# ---------------------------------------------------------------------------
# Home Assistant MCP for each installed provider
# ---------------------------------------------------------------------------
if [ "${ENABLE_HA_MCP}" = "true" ]; then
    /opt/t3code/setup-ha-mcp.sh || bashio::log.warning "ha-mcp setup had errors (continuing)"
else
    bashio::log.info "ha-mcp integration disabled in configuration"
fi

# ---------------------------------------------------------------------------
# Status page (ingress)
# ---------------------------------------------------------------------------
node /opt/t3code/status-server.mjs &
STATUS_PID=$!

# ---------------------------------------------------------------------------
# T3 Code server
# ---------------------------------------------------------------------------
if [ "${REMOTE_MODE}" = "t3_connect" ]; then
    if t3 connect status --json 2>/dev/null | sed -n '/^{/,$p' | jq -e '.authenticated and .desired' >/dev/null; then
        bashio::log.info "T3 Connect is authorized; the server will link on startup."
    else
        bashio::log.notice "T3 Connect is NOT set up yet."
        bashio::log.notice "Open the 'T3 Code' panel in the Home Assistant sidebar and click 'Start sign-in'."
        bashio::log.notice "You will get a login link to open on any device and a one-time code to paste back."
    fi
    SERVE_ARGS=(--host 127.0.0.1 --port 3773)
else
    bashio::log.info "LAN mode: binding to 0.0.0.0:${LAN_PORT}. Expose port ${LAN_PORT} in the add-on network settings."
    bashio::log.notice "The pairing URL below uses the container IP; replace the host with your Home Assistant IP."
    SERVE_ARGS=(--host 0.0.0.0 --port "${LAN_PORT}")
fi

SERVE_PID=""
term_handler() {
    bashio::log.info "Shutting down"
    kill "${STATUS_PID}" 2>/dev/null || true
    if [ -n "${SERVE_PID}" ]; then
        kill "${SERVE_PID}" 2>/dev/null || true
    fi
    wait
    exit 0
}
trap term_handler SIGTERM SIGINT

cd /config || exit 1
while true; do
    bashio::log.info "Starting: t3 serve ${SERVE_ARGS[*]}"
    t3 serve "${SERVE_ARGS[@]}" --log-level "${LOG_LEVEL}" /config &
    SERVE_PID=$!
    wait "${SERVE_PID}"
    RC=$?
    if [ -f /tmp/t3-restart-requested ]; then
        rm -f /tmp/t3-restart-requested
        bashio::log.info "Restart requested from the status page; restarting server"
        continue
    fi
    bashio::log.warning "t3 serve exited with code ${RC}; restarting in 5s"
    sleep 5
done
