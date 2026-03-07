#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CANONICAL_ROOT="${HOME}/.agents/skills/private"
CANONICAL_SKILL_PATH="${CANONICAL_ROOT}/agent-browser-relay"
LEGACY_ALIAS_PATH="${CANONICAL_ROOT}/browser-relay"
CANONICAL_EXTENSION_PATH="${CANONICAL_SKILL_PATH}/extension"
VISIBLE_ROOT="${HOME}/agent-browser-relay"
VISIBLE_EXTENSION_PATH="${VISIBLE_ROOT}/extension"

MODE="install"
FORCE=0
EXTENSION_INSTALL_STATUS=0
EXTENSION_INSTALL_OUTPUT=""

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
  ~/.agents/skills/private/agent-browser-relay

Then Chrome should load:
  ~/.agents/skills/private/agent-browser-relay/extension

Compatibility alias:
  ~/.agents/skills/private/browser-relay -> ~/.agents/skills/private/agent-browser-relay
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
NEED_CANONICAL_LINK=1

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
    echo "[codex-skill] Primary Chrome load path:"
    echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
    NEED_CANONICAL_LINK=0
  else
    if [[ "$FORCE" -ne 1 ]]; then
      echo "[codex-skill] ERROR: $CANONICAL_SKILL_PATH exists and is a directory. Use --force to replace it." >&2
      exit 2
    fi

    rm -rf "$CANONICAL_SKILL_PATH"
  fi
fi

if [[ "$NEED_CANONICAL_LINK" -eq 1 ]]; then
  ln -sfn "$REPO_ROOT" "$CANONICAL_SKILL_PATH"
fi

if [[ -e "$LEGACY_ALIAS_PATH" && ! -L "$LEGACY_ALIAS_PATH" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "[codex-skill] ERROR: legacy alias path exists and is a directory. Use --force to replace it: $LEGACY_ALIAS_PATH" >&2
    exit 2
  fi
  rm -rf "$LEGACY_ALIAS_PATH"
fi

ln -sfn "$CANONICAL_SKILL_PATH" "$LEGACY_ALIAS_PATH"

if command -v node >/dev/null 2>&1; then
  set +e
  EXTENSION_INSTALL_OUTPUT="$(node "$REPO_ROOT/scripts/extension-install-helper.js" 2>&1)"
  EXTENSION_INSTALL_STATUS=$?
  set -e
else
  EXTENSION_INSTALL_STATUS=127
  EXTENSION_INSTALL_OUTPUT="[codex-skill] WARNING: node is not available; skipping visible extension preparation."
fi

if [[ -n "$EXTENSION_INSTALL_OUTPUT" ]]; then
  printf '%s\n' "$EXTENSION_INSTALL_OUTPUT"
fi

echo "[codex-skill] Linked skill workspace:"
echo "[codex-skill]   $CANONICAL_SKILL_PATH -> $REPO_ROOT"
echo "[codex-skill] Linked compatibility alias:"
echo "[codex-skill]   $LEGACY_ALIAS_PATH -> $CANONICAL_SKILL_PATH"
echo "[codex-skill] Primary Chrome load path:"
echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
if [[ "$EXTENSION_INSTALL_STATUS" -eq 0 ]]; then
  echo "[codex-skill] Optional visible convenience path:"
  echo "[codex-skill]   $VISIBLE_EXTENSION_PATH"
  echo "[codex-skill] Chrome can load either path, but the primary path above is the guaranteed install location."
else
  echo "[codex-skill] WARNING: optional visible convenience path was not prepared."
  echo "[codex-skill] Load the primary extension path:"
  echo "[codex-skill]   $CANONICAL_EXTENSION_PATH"
  echo "[codex-skill] If you want the visible shortcut later, run:"
  echo "[codex-skill]   npm run extension:install"
fi
echo "[codex-skill] To print the exact current load path again:"
echo "[codex-skill]   npm run extension:path"
