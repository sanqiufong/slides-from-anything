#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

shopt -s nullglob
for candidate in \
  "$HOME"/.nvm/versions/node/v24*/bin \
  "$HOME"/.local/share/mise/installs/node/24*/bin \
  "$HOME"/.fnm/node-versions/v24*/installation/bin
do
  if [ -d "$candidate" ]; then
    export PATH="$candidate:$PATH"
  fi
done

export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$PATH:/opt/homebrew/bin:/usr/local/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

OPENPPT_WEB_PORT="${OPENPPT_WEB_PORT:-5173}"
OPENPPT_DAEMON_PORT="${OPENPPT_DAEMON_PORT:-17456}"
DESIGN_VAULT_PORT="${DESIGN_VAULT_PORT:-3217}"
OPENPPT_NAMESPACE="${OPENPPT_NAMESPACE:-integrated}"

OPENPPT_URL="http://127.0.0.1:${OPENPPT_WEB_PORT}"
DESIGN_VAULT_URL="http://127.0.0.1:${DESIGN_VAULT_PORT}"
LOG_DIR="$ROOT_DIR/.tmp/integrated"
DESIGN_VAULT_DATA_DIR="$LOG_DIR/design-vault-data"
DESIGN_VAULT_LOG="$LOG_DIR/design-vault.log"
TOOLS_DEV_LOG="$LOG_DIR/tools-dev-start.log"

mkdir -p "$LOG_DIR"

log() {
  printf '[integrated] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

kill_port() {
  local port="$1"
  local name="$2"
  local pids
  pids="$(port_pids "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi
  log "Stopping stale ${name} listener on port ${port}: ${pids//$'\n'/ }"
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-90}"
  local n=1
  while [ "$n" -le "$attempts" ]; do
    if curl --noproxy '*' -fsS "$url" >/dev/null 2>&1; then
      log "${label} is ready: ${url}"
      return 0
    fi
    sleep 1
    n=$((n + 1))
  done
  printf '%s did not become ready: %s\n' "$label" "$url" >&2
  return 1
}

DESIGN_VAULT_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  log "Stopping services..."
  pnpm tools-dev stop web --namespace "$OPENPPT_NAMESPACE" >/dev/null 2>&1 || true
  if [ -n "${DESIGN_VAULT_PID:-}" ]; then
    kill "$DESIGN_VAULT_PID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

require_cmd node
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" != "24" ]; then
  printf 'OpenPPT requires Node 24.x, but this shell is using %s at %s.\n' "$(node -v)" "$(command -v node)" >&2
  printf 'Install Node 24 or make it active, then run this launcher again.\n' >&2
  exit 1
fi
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
require_cmd pnpm
require_cmd curl

log "Installing workspace dependencies..."
pnpm install

log "Cleaning old local listeners..."
pnpm tools-dev stop web --namespace "$OPENPPT_NAMESPACE" >/dev/null 2>&1 || true
kill_port "$DESIGN_VAULT_PORT" "Design Vault"
kill_port "$OPENPPT_WEB_PORT" "OpenPPT web"
kill_port "$OPENPPT_DAEMON_PORT" "OpenPPT daemon"

export DESIGN_VAULT_COMMUNITY_AUTH_DIR="$LOG_DIR/design-vault-auth"
export DESIGN_VAULT_COMMUNITY_BASE_URL="${DESIGN_VAULT_COMMUNITY_BASE_URL:-https://vault.aassistant.xyz}"
export DESIGN_VAULT_DATA_DIR
mkdir -p "$DESIGN_VAULT_DATA_DIR/designs" "$DESIGN_VAULT_DATA_DIR/jobs"

log "Starting real Design Vault UI..."
pnpm --filter design-vault exec next dev --port "$DESIGN_VAULT_PORT" >"$DESIGN_VAULT_LOG" 2>&1 &
DESIGN_VAULT_PID=$!
echo "$DESIGN_VAULT_PID" > "$LOG_DIR/design-vault.pid"
wait_for_url "${DESIGN_VAULT_URL}/api/health" "Design Vault" 120 || {
  tail -n 120 "$DESIGN_VAULT_LOG" >&2 || true
  exit 1
}

export OPENPPT_VAULT_ORIGIN="$DESIGN_VAULT_URL"
export DESIGN_VAULT_ORIGIN="$DESIGN_VAULT_URL"
export OPENPPT_VAULT_DESIGNS_DIR="$DESIGN_VAULT_DATA_DIR/designs"

log "Starting real OpenPPT web UI and daemon..."
pnpm tools-dev start web \
  --namespace "$OPENPPT_NAMESPACE" \
  --daemon-port "$OPENPPT_DAEMON_PORT" \
  --web-port "$OPENPPT_WEB_PORT" >"$TOOLS_DEV_LOG" 2>&1 || {
    cat "$TOOLS_DEV_LOG" >&2 || true
    exit 1
  }

wait_for_url "$OPENPPT_URL" "OpenPPT" 120 || {
  cat "$TOOLS_DEV_LOG" >&2 || true
  pnpm tools-dev logs --namespace "$OPENPPT_NAMESPACE" --json >&2 || true
  exit 1
}

if command -v open >/dev/null 2>&1 && [ "${OPEN_IN_BROWSER:-1}" != "0" ]; then
  open "$OPENPPT_URL"
  open "$DESIGN_VAULT_URL"
fi

cat <<EOF

OpenPPT UI:      ${OPENPPT_URL}
Design Vault UI: ${DESIGN_VAULT_URL}

Press Ctrl+C in this terminal to stop both services.
Logs:
  ${TOOLS_DEV_LOG}
  ${DESIGN_VAULT_LOG}

EOF

while kill -0 "$DESIGN_VAULT_PID" >/dev/null 2>&1; do
  sleep 3
done
