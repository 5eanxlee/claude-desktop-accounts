# claude-desktop-accounts

**Use several Claude accounts in the Claude Desktop app on macOS without
losing your Code sessions or signing out and in.**

[![npm](https://img.shields.io/npm/v/claude-desktop-accounts)](https://www.npmjs.com/package/claude-desktop-accounts)
[![CI](https://github.com/5eanxlee/claude-desktop-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/5eanxlee/claude-desktop-accounts/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

claude-desktop-accounts is a free, open-source pair of tools for people who
have more than one Claude account (for example a personal Pro or Max plan
and a Team seat):

- **Session sync** keeps every Claude Code session visible in the Code tab
  sidebar under every account. Without it, switching accounts makes the
  other account's sessions disappear.
- **Claude Accounts** is a menu bar app that switches Claude Desktop to
  another saved account in one click and shows each account's live usage
  against its 5-hour and weekly limits.

It is unofficial and not affiliated with or endorsed by Anthropic.

## Install

```bash
npx claude-desktop-accounts
```

The installer checks your Mac, shows what it will change, and asks before
doing anything. Without npm:

```bash
curl -fsSL https://raw.githubusercontent.com/5eanxlee/claude-desktop-accounts/main/install.sh | bash
```

| Requirement | Why |
|---|---|
| macOS 13 or newer | Both tools are macOS only |
| [Claude Desktop](https://claude.ai/download) | The app being extended |
| Node.js 22 or newer (`brew install node`) | Runs the installer and the session sync |
| Xcode command line tools (`xcode-select --install`) | The menu bar app is compiled on your Mac |

Options: `--no-sync` or `--no-app` installs one tool only; `--yes` skips the
question.

### After installing

1. Quit and reopen Claude once so it reloads its session list.
2. In the menu bar, choose **Claude › Save Current Account**.
3. For each other account choose **Add Account…**, sign in when Claude
   reopens, and it is saved automatically.
4. When macOS asks whether Claude Accounts may use "Claude Safe Storage",
   choose **Always Allow**. This is how it reads usage.

| Task | Command |
|---|---|
| Update | `npx claude-desktop-accounts@latest` |
| Check the session sync | `npx claude-desktop-accounts status` |
| Sync once now | `npx claude-desktop-accounts sync` |
| Remove | `npx claude-desktop-accounts uninstall` (add `--purge` to delete saved data) |
| Undo the session sync | `npx claude-desktop-accounts restore` (quit Claude and uninstall first) |

## FAQ

### Why do my Claude Code sessions disappear when I switch accounts in Claude Desktop?

Claude Desktop keeps a separate Code-tab session list for each account and
organization, in
`~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/`.
The conversations themselves are stored once in `~/.claude/projects` and
shared by every account, so nothing is lost; the other account's list
simply isn't shown. The session sync copies each session's list entry into
every account's folder, so all accounts show the same sessions.

### How do I switch Claude accounts without logging out?

Save each account once in the Claude Accounts menu bar app, then pick one
from the menu. The app quits Claude, puts that account's saved sign-in back,
reopens Claude and waits until Claude confirms the account. It takes a few
seconds. Avoid Claude's own **Log Out** for accounts you have saved: it most
likely ends that session on Anthropic's side, and the saved copy stops
working. **Add Account…** signs Claude out on your Mac only.

### Can I see the usage limits of all my Claude accounts at once?

Yes. The menu shows each saved account as, for example,
`you@example.com — 5h 14% · week 46%`, which is percent used of the 5-hour
and weekly limits, with reset times on hover. It refreshes every two
minutes, using the same usage endpoint Claude Desktop uses.

### Is it safe? What does it access?

Everything stays on your Mac, except the usage request, which goes only to
claude.ai.

| | Session sync | Claude Accounts |
|---|---|---|
| Claude.app itself | never changed | never changed (it only opens it and reads its version) |
| Session list folders | copies list entries between account folders | — |
| `config.json` and `Cookies` in Claude's data folder | — | swaps the sign-in entries and claude.ai cookies, only while Claude is closed |
| Keychain | — | reads "Claude Safe Storage" to decrypt session cookies in memory |
| Network | none | `claude.ai` usage and account endpoints |
| Its own data | `~/Library/Application Support/claude-session-sync/` | `~/Library/Application Support/Claude Accounts/` |

Saved sign-ins stay encrypted exactly as Claude stored them, and decrypted
values are never written to disk or logged. The session sync takes a backup
before its first change, never deletes a record (removals go to its own
trash), and holds back if many sessions vanish at once.

### Will a Claude Desktop update break it?

Updates install normally, because neither tool modifies the app. An update
can change Claude's internal data formats, which are undocumented. Both
tools check what they read and stop instead of guessing: the session sync
reports "layout not recognised", and Claude Accounts refuses to switch if the
cookie format changed since an account was saved.

### What happens to a running session when I switch?

Switching restarts Claude, so running Code sessions stop, as with any
restart. With the session sync installed they stay listed, and you can
continue them under the new account. Continuing a session sends its whole
conversation through the account you are signed in to; if that account
belongs to a Team or Enterprise organization, its policies apply.

### Does it work on Windows or Linux, or with the claude CLI?

No. Both tools are macOS only and work on Claude Desktop. The `claude`
command line tool doesn't need them: `claude --resume` lists past sessions
for the current folder whichever account is signed in.

### How is this different from claude-transplant?

[claude-transplant](https://github.com/vitaliyhayda/claude-transplant)
**moves** Code sessions from one account to another, so each session is
listed under one account at a time. The session sync here **mirrors** them,
so every account lists every session continuously, with nothing to run when
you switch. claude-desktop-accounts also includes account switching and
usage; claude-transplant does not switch accounts.

### Which data does it rely on?

See [docs/how-it-works.md](docs/how-it-works.md) for the files, the sync
rules, the switching steps and the usage request, as observed in Claude
Desktop 2.16.

## Development

```bash
npm test          # installer and session sync tests
./app/build.sh    # compile the menu bar app and run its self-tests
```

`CSS_HOME=/some/dir` points the session sync at another home folder, for
trying it on a copy of real data. Details per tool:
[sync/README.md](sync/README.md), [app/README.md](app/README.md).

## License

MIT. Claude is a trademark of Anthropic, PBC; this project is independent.
