#!/usr/bin/env bash
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_ROOT"

RELAY_HOST="${GRAIS_RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${GRAIS_RELAY_PORT:-18793}"
ATTACH_TIMEOUT_MS="${GRAIS_ATTACH_TIMEOUT_MS:-120000}"
RELAY_STATUS_URL="http://${RELAY_HOST}:${RELAY_PORT}/status"

echo "[preflight] checking relay status: ${RELAY_STATUS_URL}"
echo "[preflight] expected relay port: ${RELAY_PORT} on ${RELAY_HOST}"
echo "[preflight] attach timeout: ${ATTACH_TIMEOUT_MS}ms"

status="$(curl --max-time 3 -sS "${RELAY_STATUS_URL}" || true)"
if [[ -z "$status" ]]; then
  echo "[preflight] FAIL: relay did not respond" >&2
  exit 1
fi

echo "$status" | grep -q '"extensionConnected":true' || {
  echo "[preflight] FAIL: extension not connected (expected extensionConnected=true)." >&2
  echo "[preflight] extension status: $status" >&2
  exit 1
}

echo "[preflight] relay attached, now checking script bridge..."
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms "${ATTACH_TIMEOUT_MS}" --host "${RELAY_HOST}" --port "${RELAY_PORT}"
echo "[preflight] OK: relay + extension bridge are ready"
