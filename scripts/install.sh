#!/usr/bin/env bash
# ShipLayer install/uninstall script.
#
# What it does:
#   1. Builds the CLI (npm run build), since the skill and `shiplayer` on
#      PATH both invoke dist/.
#   2. Links the CLI onto PATH with `npm link`, so `shiplayer` resolves to
#      this checkout without a copy going stale.
#   3. Symlinks skills/ship-app-store into the two skill directories the
#      supported tools read: ~/.claude/skills/ship-app-store and
#      ~/.codex/skills/ship-app-store. Symlinks, never copies, so an edit
#      in this repo is visible through the installed path immediately.
#
# Safety rules this script follows everywhere:
#   - Never write outside $CLAUDE_SKILLS_DIR, $CODEX_SKILLS_DIR, and npm's
#     own global link target.
#   - Never delete or overwrite a path this script did not itself create as
#     a symlink to this repo's skill directory.
#   - Every write is reported: this script prints every path it touches.
#
# Usage:
#   scripts/install.sh install [--skip-build] [--skip-cli-link] [--skip-skills]
#   scripts/install.sh uninstall [--skip-cli-unlink] [--skip-skills]
#   scripts/install.sh status
#
# Environment overrides (used by tests; also usable by a human):
#   HOME                    Changes both default skill directory roots.
#   SHIPLAYER_CLAUDE_SKILLS_DIR   Overrides ~/.claude/skills directly.
#   SHIPLAYER_CODEX_SKILLS_DIR    Overrides ~/.codex/skills directly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_NAME="ship-app-store"
SKILL_SRC="$REPO_ROOT/skills/$SKILL_NAME"

CLAUDE_SKILLS_DIR="${SHIPLAYER_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS_DIR="${SHIPLAYER_CODEX_SKILLS_DIR:-$HOME/.codex/skills}"

# --- helpers ----------------------------------------------------------------

# Canonicalize a path that may not exist yet (BSD/macOS readlink supports
# -f on this platform; fall back to Python's realpath if not available).
realpath_of() {
  local target="$1"
  if readlink -f "$target" >/dev/null 2>&1; then
    readlink -f "$target"
  else
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$target"
  fi
}

log() { printf '%s\n' "$*"; }

TOUCHED=()
note_touched() { TOUCHED+=("$1"); }

# --- skill install/uninstall for one target directory -----------------------

install_skill_into() {
  local label="$1" dir="$2"
  local target="$dir/$SKILL_NAME"

  mkdir -p "$dir"
  note_touched "$dir (ensured exists)"

  if [ -L "$target" ]; then
    local existing_resolved
    existing_resolved="$(realpath_of "$target")"
    if [ "$existing_resolved" = "$SKILL_SRC" ]; then
      log "[$label] already linked: $target -> $SKILL_SRC (no-op)"
      return 0
    else
      log "[$label] REFUSING: $target is a symlink to a different location ($existing_resolved), not this repo. Not touching it."
      return 1
    fi
  elif [ -e "$target" ]; then
    log "[$label] REFUSING: $target already exists and is not a symlink this script created. Not touching it. Move or remove it yourself if you want ShipLayer's skill installed here."
    return 1
  else
    ln -s "$SKILL_SRC" "$target"
    note_touched "$target -> $SKILL_SRC (created symlink)"
    log "[$label] linked: $target -> $SKILL_SRC"
    return 0
  fi
}

uninstall_skill_from() {
  local label="$1" dir="$2"
  local target="$dir/$SKILL_NAME"

  if [ -L "$target" ]; then
    local existing_resolved
    existing_resolved="$(realpath_of "$target")"
    if [ "$existing_resolved" = "$SKILL_SRC" ]; then
      rm "$target"
      note_touched "$target (removed symlink)"
      log "[$label] removed: $target"
    else
      log "[$label] leaving alone: $target is a symlink to a different location ($existing_resolved), not created by this script."
    fi
  elif [ -e "$target" ]; then
    log "[$label] leaving alone: $target exists and is not a symlink this script created."
  else
    log "[$label] nothing to remove: $target does not exist."
  fi
}

# --- CLI link -----------------------------------------------------------

cli_link() {
  log "Linking CLI onto PATH with 'npm link'..."
  (cd "$REPO_ROOT" && npm link)
  note_touched "npm global link -> shiplayer (see 'npm link --loglevel info' for exact paths; run 'npm root -g' / 'npm prefix -g' to inspect)"
}

cli_unlink() {
  log "Unlinking CLI from PATH with 'npm unlink -g shiplayer'..."
  if ! (cd "$REPO_ROOT" && npm unlink -g shiplayer 2>&1); then
    log "(nothing to unlink, or already unlinked — continuing)"
  fi
}

# --- top-level commands ----------------------------------------------------

cmd_install() {
  local skip_build=0 skip_cli_link=0 skip_skills=0
  for arg in "$@"; do
    case "$arg" in
      --skip-build) skip_build=1 ;;
      --skip-cli-link) skip_cli_link=1 ;;
      --skip-skills) skip_skills=1 ;;
      *) log "unknown flag: $arg"; exit 64 ;;
    esac
  done

  if [ "$skip_build" -eq 0 ]; then
    log "Building ShipLayer (npm run build)..."
    (cd "$REPO_ROOT" && npm run build)
  fi

  local failures=0
  if [ "$skip_cli_link" -eq 0 ]; then
    cli_link
  fi

  if [ "$skip_skills" -eq 0 ]; then
    install_skill_into "claude" "$CLAUDE_SKILLS_DIR" || failures=1
    install_skill_into "codex" "$CODEX_SKILLS_DIR" || failures=1
  fi

  log ""
  log "Paths touched:"
  for p in "${TOUCHED[@]}"; do log "  - $p"; done

  if [ "$failures" -ne 0 ]; then
    log ""
    log "Install finished with refusals above — resolve them and re-run."
    exit 1
  fi
  log ""
  log "Install complete."
}

cmd_uninstall() {
  local skip_cli_unlink=0 skip_skills=0
  for arg in "$@"; do
    case "$arg" in
      --skip-cli-unlink) skip_cli_unlink=1 ;;
      --skip-skills) skip_skills=1 ;;
      *) log "unknown flag: $arg"; exit 64 ;;
    esac
  done

  if [ "$skip_skills" -eq 0 ]; then
    uninstall_skill_from "claude" "$CLAUDE_SKILLS_DIR"
    uninstall_skill_from "codex" "$CODEX_SKILLS_DIR"
  fi

  if [ "$skip_cli_unlink" -eq 0 ]; then
    cli_unlink
  fi

  log ""
  log "Paths touched:"
  for p in "${TOUCHED[@]}"; do log "  - $p"; done
  log ""
  log "Uninstall complete."
}

cmd_status() {
  log "Repo:  $REPO_ROOT"
  log "Skill source: $SKILL_SRC"
  for pair in "claude:$CLAUDE_SKILLS_DIR" "codex:$CODEX_SKILLS_DIR"; do
    local label="${pair%%:*}" dir="${pair#*:}"
    local target="$dir/$SKILL_NAME"
    if [ -L "$target" ]; then
      log "[$label] $target -> $(realpath_of "$target") $( [ "$(realpath_of "$target")" = "$SKILL_SRC" ] && echo "(ours)" || echo "(NOT ours)" )"
    elif [ -e "$target" ]; then
      log "[$label] $target exists, not a symlink"
    else
      log "[$label] $target not installed"
    fi
  done
  if command -v shiplayer >/dev/null 2>&1; then
    log "shiplayer on PATH: $(command -v shiplayer)"
  else
    log "shiplayer NOT on PATH"
  fi
}

main() {
  local cmd="${1:-install}"
  [ $# -gt 0 ] && shift || true
  case "$cmd" in
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    status) cmd_status "$@" ;;
    *) log "usage: $0 {install|uninstall|status} [flags]"; exit 64 ;;
  esac
}

main "$@"
