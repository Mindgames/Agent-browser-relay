#!/usr/bin/env bash
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SKILL_ROOT"

echo "[preflight] checking relay status: http://127.0.0.1:18792/status"
status="$(curl -sS http://127.0.0.1:18792/status || true)"
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
node scripts/read-active-tab.js --check --wait-for-attach --attach-timeout-ms 120000
echo "[preflight] OK: relay + extension bridge are ready"
