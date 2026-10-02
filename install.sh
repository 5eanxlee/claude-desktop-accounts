#!/bin/bash
# Installs claude-desktop-accounts: the session sync and the Claude Accounts menu bar app.
#
#   curl -fsSL https://raw.githubusercontent.com/5eanxlee/claude-desktop-accounts/main/install.sh | bash
#   ./install.sh [--no-sync] [--no-app] [--yes]
#
#   --no-sync   skip the session sync (no Node.js needed)
#   --no-app    skip the menu bar app (no Xcode tools needed)
#   --yes       do not ask for confirmation
#
# Running it again updates to the latest version.
set -euo pipefail

REPO="https://github.com/5eanxlee/claude-desktop-accounts.git"
DIR="${CDA_DIR:-$HOME/.claude-desktop-accounts}"
want_sync=1; want_app=1; assume_yes=0
for arg in "$@"; do
  case "$arg" in
    --no-sync) want_sync=0 ;;
    --no-app) want_app=0 ;;
    --yes|-y) assume_yes=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
[ $want_sync = 1 ] || [ $want_app = 1 ] || { echo "Nothing to install." >&2; exit 2; }

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Prerequisites, all checked before anything is changed.
[ "$(uname -s)" = Darwin ] || fail "This only works on macOS."
claude=$(mdfind "kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'" 2>/dev/null | head -1 || true)
[ -n "$claude" ] || [ -d /Applications/Claude.app ] || fail "Claude Desktop is not installed. Get it from https://claude.ai/download"
command -v git >/dev/null || fail "git is required. Run: xcode-select --install"
if [ $want_sync = 1 ]; then
  command -v node >/dev/null || fail "Node.js 22 or newer is needed for the session sync (e.g. brew install node), or rerun with --no-sync."
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || fail "Node.js 22 or newer is needed for the session sync; found $(node -v)."
fi
if [ $want_app = 1 ]; then
  xcrun --find swiftc >/dev/null 2>&1 || fail "The Swift compiler is needed for the menu bar app. Run: xcode-select --install, or rerun with --no-app."
fi

# Run from a checkout, use it; otherwise install into $DIR.
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
if [ -n "$here" ] && [ -d "$here/sync" ] && [ -d "$here/app" ]; then DIR="$here"; fi

say "This will:"
[ $want_sync = 1 ] && say "  - back up Claude's Code session list, copy every session into every account's list, and keep them in step from login"
[ $want_app = 1 ] && say "  - build the Claude Accounts menu bar app and install it"
say "  using the code in $DIR"
if [ $assume_yes = 0 ]; then
  if ( : < /dev/tty ) 2>/dev/null; then
    printf 'Continue? [y/N] '
    read -r answer < /dev/tty
  else
    fail "No terminal to confirm on. Rerun with --yes to proceed."
  fi
  case "$answer" in y|Y|yes|YES) ;; *) say "Nothing was installed."; exit 0 ;; esac
fi

if [ "$DIR" != "$here" ]; then
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR…"
    git -C "$DIR" pull --ff-only --quiet
  else
    say "Downloading to $DIR…"
    git clone --quiet --depth 1 "$REPO" "$DIR"
  fi
fi

if [ $want_sync = 1 ]; then
  say ""
  say "Session sync:"
  node "$DIR/sync/bin/claude-session-sync.js" install
fi
if [ $want_app = 1 ]; then
  say ""
  say "Claude Accounts app (compiling takes a minute):"
  "$DIR/app/build.sh" install
fi

say ""
say "Installed. Next:"
[ $want_sync = 1 ] && say "  - Quit and reopen Claude once so it reloads its session list."
[ $want_app = 1 ] && say "  - In the menu bar, Claude > Save Current Account. For each other account use Add Account…"
[ $want_app = 1 ] && say "     When macOS asks about \"Claude Safe Storage\", choose Always Allow so usage can be shown."
say "  - Update by running the install command again. Remove with $DIR/uninstall.sh"
