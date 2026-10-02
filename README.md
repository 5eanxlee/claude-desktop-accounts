# claude-desktop-accounts

Two small tools for people who use more than one account in the Claude
Desktop app on macOS.

- **Session sync** — your Code-tab sessions show up under every account,
  not only the one that started them.
- **Claude Accounts** — a menu bar app that switches Claude Desktop between
  saved accounts in one click, without signing out and in, and shows each
  account's live usage (5-hour and weekly).

Unofficial and not affiliated with Anthropic. Both tools rely on how Claude
Desktop stores data internally, which is undocumented and can change with an
update. When something no longer looks as expected, they stop instead of
guessing.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/5eanxlee/claude-desktop-accounts/main/install.sh | bash
```

The installer checks the prerequisites, shows what it will do and asks
before changing anything. It downloads the code to
`~/.claude-desktop-accounts`, installs the session sync as a background
agent, and builds the menu bar app from source on your Mac.

Options: `--no-sync` or `--no-app` to install only one tool, `--yes` to skip
the question. To install from a clone instead, run `./install.sh` in it.

**Needs:** macOS 13 or newer, Claude Desktop, Node.js 22+ for the session sync
(`brew install node`), and the Xcode command line tools for the app
(`xcode-select --install`).

**Then:**

1. Quit and reopen Claude once, so it reloads its session list.
2. In the menu bar, **Claude › Save Current Account**. For each other
   account, choose **Add Account…**, sign in when Claude reopens, and it is
   saved automatically.
3. When macOS asks whether Claude Accounts may use "Claude Safe Storage",
   choose **Always Allow**. That is what lets it show usage.

**Update:** run the install command again. **Remove:**
`~/.claude-desktop-accounts/uninstall.sh` (add `--purge` to also delete
saved accounts, backups and logs).

## Why

Claude Desktop keeps one Code session list per account, so switching
accounts hides every session started under the other one, even though the
conversations are stored once on your Mac and shared by all accounts. And
there is no account switcher: changing account means signing out and back
in through the browser.

## Session sync

Keeps a copy of every session's sidebar record in every account's folder,
so each account shows the same list. It runs in the background from login.

- The copy with the most recent activity wins.
- While Claude is running, the folder of the signed-in account only receives
  new records; changes wait until you switch away or quit, because Claude
  rewrites that folder from memory.
- A session you delete in one account is removed from the others too, into
  the tool's trash, not erased. If many disappear at once, nothing is
  removed until you confirm.
- A backup is taken before the first change; `restore` puts it back.

Details and commands: [sync/README.md](sync/README.md).

## Claude Accounts

- **Save Current Account** keeps a copy of Claude's sign-in for the account
  that is signed in. The copy stays encrypted exactly as Claude stored it.
- **Picking an account** quits Claude, puts that account's sign-in back,
  reopens Claude and waits for it to confirm the account. Running Code
  sessions stop, as with any restart.
- **Add Account…** reopens Claude signed out without ending the current
  account's session. Don't use Claude's own Log Out for an account you have
  saved: it most likely ends that session on Anthropic's side and the saved
  copy stops working.
- **Usage** is read from claude.ai with each account's own session, every
  two minutes. Decrypted values stay in memory only.
- **Sync Sessions** runs the session sync immediately.

Details: [app/README.md](app/README.md).

## What they touch

| | Session sync | Claude Accounts |
|---|---|---|
| Claude.app itself | never | never (only opens it and reads its version) |
| `~/Library/Application Support/Claude/claude-code-sessions/` | copies records between account folders | — |
| `config.json`, `Cookies` in the same folder | — | the sign-in entries and claude.ai cookies, only while Claude is closed |
| Keychain | — | reads "Claude Safe Storage" to decrypt session cookies for usage checks |
| Network | none | `claude.ai` usage and account endpoints only |
| Own data | `~/Library/Application Support/claude-session-sync/` | `~/Library/Application Support/Claude Accounts/` |

How it works in more depth: [docs/how-it-works.md](docs/how-it-works.md).

## Things to know

- Continuing a session under another account sends its whole conversation
  through that account. If one of your accounts belongs to a Team or
  Enterprise organization, that organization's policies apply to what you
  send through it.
- Cloud sessions, Remote Control, Cowork and scheduled tasks stay with the
  account that created them.
- Rebuilding the app gives it a new signature, so macOS asks about the
  Keychain again after each update.

## Development

```bash
cd sync && npm test     # session sync tests
./app/build.sh          # compile the app and run its self-tests
```

`CSS_HOME=/some/dir` points the session sync at another home folder, for
trying it on a copy of real data.

## License

MIT
