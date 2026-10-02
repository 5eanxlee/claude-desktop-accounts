#!/bin/bash
# Removes the background session sync and the Claude Accounts app.
#
#   ~/.claude-desktop-accounts/uninstall.sh [--purge]
#
#   --purge   also delete saved accounts, sync state, backups, trash, logs, and
#             the downloaded code in ~/.claude-desktop-accounts
#
# Session records the sync already copied stay in Claude's folders. To put the
# folders back as they were before the first sync, run this first:
#   node ~/.claude-desktop-accounts/sync/bin/claude-session-sync.js uninstall
#   (quit Claude)
#   node ~/.claude-desktop-accounts/sync/bin/claude-session-sync.js restore
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
purge=0
case "${1:-}" in
  --purge) purge=1 ;;
  "") ;;
  -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

if command -v node >/dev/null && [ -f "$DIR/sync/bin/claude-session-sync.js" ]; then
  node "$DIR/sync/bin/claude-session-sync.js" uninstall
else
  launchctl bootout "gui/$(id -u)/local.claude-session-sync" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/local.claude-session-sync.plist"
  echo "Background agent removed."
fi

pkill -x ClaudeAccounts 2>/dev/null || true
for apps in /Applications "$HOME/Applications"; do
  if [ -d "$apps/Claude Accounts.app" ]; then rm -rf "$apps/Claude Accounts.app"; echo "Removed $apps/Claude Accounts.app"; fi
done

if [ $purge = 1 ]; then
  rm -rf "$HOME/Library/Application Support/claude-session-sync" "$HOME/Library/Application Support/Claude Accounts"
  rm -f "$HOME/Library/Logs/claude-session-sync.log" "$HOME/Library/Logs/claude-session-sync.log.1" "$HOME/Library/Logs/claude-session-sync.err.log"
  echo "Deleted saved accounts, sync state, backups, trash and logs."
  if [ "$DIR" = "$HOME/.claude-desktop-accounts" ]; then rm -rf "$DIR"; echo "Deleted $DIR"; fi
fi
echo "Done. Claude itself was not changed."
