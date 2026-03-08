#!/usr/bin/env bash
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_ROOT"

RELAY_HOST="127.0.0.1"
RELAY_PORT="18793"
ATTACH_TIMEOUT_MS="120000"
REQUIRE_TARGET_CREATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      RELAY_HOST="${2:-$RELAY_HOST}"
      shift 2
      ;;
    --port)
      RELAY_PORT="${2:-$RELAY_PORT}"
      shift 2
      ;;
    --attach-timeout-ms)
      ATTACH_TIMEOUT_MS="${2:-$ATTACH_TIMEOUT_MS}"
      shift 2
      ;;
    --require-target-create)
      REQUIRE_TARGET_CREATE=1
      shift
      ;;
    *)
      echo "[preflight] Unknown argument: $1" >&2
      echo "[preflight] Usage: ./scripts/preflight.sh [--host 127.0.0.1] [--port 18793] [--attach-timeout-ms 120000] [--require-target-create]" >&2
      exit 1
      ;;
  esac
done
RELAY_STATUS_URL="http://${RELAY_HOST}:${RELAY_PORT}/status"

echo "[preflight] checking relay status: ${RELAY_STATUS_URL}"
echo "[preflight] expected relay port: ${RELAY_PORT} on ${RELAY_HOST}"
echo "[preflight] attach timeout: ${ATTACH_TIMEOUT_MS}ms"
echo "[preflight] require target-create: ${REQUIRE_TARGET_CREATE}"

node scripts/extension-status.js --host "${RELAY_HOST}" --port "${RELAY_PORT}" --status-timeout-ms 3000

echo "[preflight] relay attached, now checking script bridge..."
CHECK_ARGS=(--check --wait-for-attach --attach-timeout-ms "${ATTACH_TIMEOUT_MS}" --host "${RELAY_HOST}" --port "${RELAY_PORT}")
if [[ "$REQUIRE_TARGET_CREATE" -eq 1 ]]; then
  CHECK_ARGS+=(--require-target-create)
fi
node scripts/read-active-tab.js "${CHECK_ARGS[@]}"
echo "[preflight] OK: relay + extension bridge are ready"
