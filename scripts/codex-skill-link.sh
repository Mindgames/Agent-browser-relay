#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${HOME}/.codex/skills/private"
CANONICAL_SKILL_PATH="${CANONICAL_ROOT}/browser-relay"
CANONICAL_EXTENSION_PATH="${CANONICAL_SKILL_PATH}/extension"

MODE="install"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  npm run codex:install          # create/update canonical skill path symlink
  npm run codex:install:check     # verify canonical path points to this repo
  bash scripts/codex-skill-link.sh --force   # replace existing non-symlink path

The script always links this repository to:
  ~/.codex/skills/private/browser-relay

Then Chrome should load:
  ~/.codex/skills/private/browser-relay/extension
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

resolve_link_target() {
  local link_path="$1"
  local target
  target="$(readlink "$link_path")"
  if [[ "$target" == /* ]]; then
    printf '%s\n' "$target"
    return 0
  fi

  local base_dir
  base_dir="$(cd "$(dirname "$link_path")" && pwd -P)"
  cd "${base_dir}/${target}"
  printf '%s\n' "$PWD"
}

mkdir -p "$CANONICAL_ROOT"

if [[ "$MODE" == "check" ]]; then
  if [[ -L "$CANONICAL_SKILL_PATH" ]]; then
    if ! linked_root="$(resolve_link_target "$CANONICAL_SKILL_PATH")"; then
      echo "[codex-skill] ERROR: canonical link is broken: $CANONICAL_SKILL_PATH" >&2
      exit 1
    fi

    if [[ "$linked_root" == "$REPO_ROOT" ]]; then
      echo "[codex-skill] OK: $CANONICAL_SKILL_PATH -> $linked_root"
      echo "[codex-skill] Extension location:"
      echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
      exit 0
    fi

    echo "[codex-skill] ERROR: canonical path points to $linked_root, expected $REPO_ROOT" >&2
    exit 2
  fi

  if [[ -d "$CANONICAL_SKILL_PATH" ]]; then
    existing_root="$(cd "$CANONICAL_SKILL_PATH" && pwd -P)"
    if [[ "$existing_root" == "$REPO_ROOT" ]]; then
      echo "[codex-skill] OK: $CANONICAL_SKILL_PATH already exists as this repository"
      echo "[codex-skill] Extension location:"
      echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
      exit 0
    fi

    echo "[codex-skill] ERROR: $CANONICAL_SKILL_PATH exists but is not linked to this repository" >&2
    exit 2
  fi

  echo "[codex-skill] ERROR: $CANONICAL_SKILL_PATH is missing. Run npm run codex:install." >&2
  exit 2
fi

if [[ -d "$CANONICAL_SKILL_PATH" && ! -L "$CANONICAL_SKILL_PATH" ]]; then
  existing_root="$(cd "$CANONICAL_SKILL_PATH" && pwd -P)"
  if [[ "$existing_root" == "$REPO_ROOT" ]]; then
    echo "[codex-skill] Reusing existing repository path at $CANONICAL_SKILL_PATH"
    echo "[codex-skill] Chrome load target:"
    echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
    exit 0
  fi

  if [[ "$FORCE" -ne 1 ]]; then
    echo "[codex-skill] ERROR: $CANONICAL_SKILL_PATH exists and is a directory. Use --force to replace it." >&2
    exit 2
  fi

  rm -rf "$CANONICAL_SKILL_PATH"
fi

ln -sfn "$REPO_ROOT" "$CANONICAL_SKILL_PATH"

echo "[codex-skill] Linked skill workspace:"
echo "[codex-skill]   $CANONICAL_SKILL_PATH -> $REPO_ROOT"
echo "[codex-skill] Chrome load target:"
echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
