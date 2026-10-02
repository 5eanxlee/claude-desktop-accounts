# Claude Accounts

A menu bar app for switching Claude Desktop between accounts without
signing out and in, with each account's live usage, and a button that runs
the [session sync](../sync/README.md) installed alongside it.

Unofficial. It relies on how Claude Desktop stores its sign-in, which is
undocumented and can change with an update.

## Build and install

The [installer](../README.md#install) does this for you. By hand, from this folder:

```bash
./build.sh           # compile, run the self-tests, make build/Claude Accounts.app
./build.sh install   # also install it (/Applications, or ~/Applications) and open it
```

Needs the Xcode command line tools (`xcode-select --install`).

## Use

1. With Claude signed in, choose **Save Current Account**. For each other
   account, choose **Add Account…**: Claude reopens signed out, you sign in,
   and the account is saved as soon as it loads. Don't use Claude's own
   **Log Out**, which most likely ends the session on Anthropic's side and
   breaks the saved copy.
2. Pick an account in the menu. Claude quits, reopens signed in to it, and
   the app waits for Claude to confirm. Running Code sessions stop; with the
   session sync installed they stay listed under every account.
3. Usage shows as percent used for the 5-hour and weekly limits, refreshed
   every two minutes. Hover a row for reset times.

The first quota check asks for Keychain access to "Claude Safe Storage".
Choose **Always Allow**. Rebuilding the app changes its signature, so macOS
asks again after each rebuild.

## What it touches

| What | When |
|---|---|
| `~/Library/Application Support/Claude/config.json`: `oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid` | Read on save; written on switch, with Claude closed |
| `~/Library/Application Support/Claude/Cookies`: rows for `claude.ai` | Read on save; replaced on switch, in one transaction |
| `~/Library/Logs/Claude/main.log` | Read to see which account is signed in |
| Keychain item "Claude Safe Storage" | Read once per launch, kept in memory, to decrypt session cookies for usage checks |
| `https://claude.ai/api/organizations/<org>/usage` and `/api/account` | Usage and account labels |
| `~/Library/Application Support/Claude Accounts/` | Saved accounts (still encrypted with Claude's key), `previous.json` from the last switch |

Decrypted cookies are never written to disk or logged.

## Command line

The app binary also has test modes:

```bash
"Claude Accounts.app/Contents/MacOS/ClaudeAccounts" --list    # saved accounts, who is signed in
"Claude Accounts.app/Contents/MacOS/ClaudeAccounts" --save    # save the signed-in account
"Claude Accounts.app/Contents/MacOS/ClaudeAccounts" --quota   # check usage once for every account
```

## If a switch goes wrong

The app offers to put the previous account back. The sign-in that was in
place before the last switch is also kept in
`~/Library/Application Support/Claude Accounts/previous.json`.
If Claude opens to a sign-in screen, sign in normally and save the account
again.

How it works: [docs/how-it-works.md](../docs/how-it-works.md).
