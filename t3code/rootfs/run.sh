#!/usr/bin/with-contenv bashio
# T3 Code add-on entrypoint.
# bashio enables errexit/nounset; we manage failures ourselves.
set +o errexit +o nounset
set -o pipefail
umask 077

# Complete storage migration before any T3 or provider command can write state.
python3 /opt/t3code/provider-storage.py || exit 1

export HOME=/data/home
export T3CODE_HOME=/data/t3code
export T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared
export T3CODE_TELEMETRY_ENABLED=false

REMOTE_MODE=$(bashio::config 'remote_mode' 't3_connect')
LAN_PORT=$(bashio::config 'lan_port' '3773')
LOG_LEVEL=$(bashio::config 'log_level' 'info')
GIT_INIT_CONFIG=$(bashio::config 'git_init_config' 'false')
ENABLE_HA_MCP=$(bashio::config 'enable_ha_mcp' 'true')
AUTO_UPDATE_T3=$(bashio::config 'auto_update_t3' 'true')

# Bashio can return an empty value when the Supervisor request fails. Never
# interpret an unreadable remote mode as permission to bind the LAN interface.
case "${REMOTE_MODE}" in
    t3_connect|lan) ;;
    *) bashio::log.fatal "Cannot read a valid remote_mode; refusing to start"; exit 1 ;;
esac
if ! [[ "${LAN_PORT}" =~ ^[0-9]+$ ]] || [ "${LAN_PORT}" -lt 1 ] || [ "${LAN_PORT}" -gt 65535 ]; then
    bashio::log.fatal "Cannot read a valid lan_port; refusing to start"
    exit 1
fi

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

# Select once, before any T3 command can open or migrate persistent data.
# An unreadable option must not authorize an update.
node /opt/t3code/runtime-manager.mjs prepare "${AUTO_UPDATE_T3}" || exit 1

bashio::log.info "T3 Code add-on starting (t3 $(timeout 15s t3 --version 2>/dev/null || echo unknown), mode: ${REMOTE_MODE})"
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
git config --global --add safe.directory /config 2>/dev/null || true
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
# Recheck exclusions if this startup initialized Git or rewrote its rules.
# The migration is idempotent; this must pass before project registration.
python3 /opt/t3code/provider-storage.py || exit 1

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
# T3 Code server
# ---------------------------------------------------------------------------
if [ "${REMOTE_MODE}" = "t3_connect" ]; then
    if timeout 15s t3 connect status --json 2>/dev/null | sed -n '/^{/,$p' | jq -e '.authenticated and .desired' >/dev/null; then
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

cd /config || exit 1
# The manager gates a new runtime, restores failed trials, and supervises ordinary
# crashes without rechecking for updates. It starts ingress after trial activation.
exec node /opt/t3code/runtime-manager.mjs serve "${SERVE_ARGS[@]}" --log-level "${LOG_LEVEL}" /config
