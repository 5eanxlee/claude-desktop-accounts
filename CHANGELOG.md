# Changelog

## 0.2.0 — 2026-11-11

- Session sync: archiving or unarchiving a session in one account now
  reaches every other account. Before, a copy that Claude had rewritten
  with a newer file time could win and undo the archive.
- Session sync: SSH environments (Claude's saved machine and folder, such
  as a workstation) are mirrored into every account's environment list,
  so SSH sessions can be continued, and new ones started, from any
  account. Deletes and edits follow.
- Claude Accounts: the menu shows when each limit resets directly in the
  account's row instead of only on hover.
- Claude Accounts: accounts whose plan has only a weekly limit show that
  limit alone, without the "5h" and "week" names, in the menu and the
  window.

## 0.1.0 — 2026-10-02

First release.

- Session sync: mirrors Claude Desktop's Code-tab session list across every
  account folder, continuously, from a background agent. Backups, trash
  instead of deletion, a hold on bulk removals, and `restore`.
- Claude Accounts menu bar app: save accounts, switch in one click by
  swapping the saved sign-in while Claude is closed, Add Account without
  ending the current session, live 5-hour and weekly usage, Sync Sessions.
- `npx claude-desktop-accounts` installer and a curl alternative.
