# How it works

Everything here is undocumented Claude Desktop behaviour, observed on macOS
with Claude Desktop 2.16 (September 2026). Each tool checks that what it
reads still has the expected shape and stops when it does not.

## Where Claude Desktop keeps things

| What | Where |
|---|---|
| App data | `~/Library/Application Support/Claude/` |
| Code session list, per account | `claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json` |
| Conversations (shared by all accounts) | `~/.claude/projects/…` |
| Code-tab sign-in | `config.json`: `oauth:tokenCache`, `oauth:tokenCacheV2` (encrypted), `lastKnownAccountUuid` |
| claude.ai sign-in | `Cookies` (Chromium SQLite), rows for `claude.ai` and `.claude.ai` (encrypted) |
| Encryption key | login Keychain item "Claude Safe Storage" |
| Which account is loaded | `~/Library/Logs/Claude/main.log`: `[LocalSessionManager] Initialization succeeded — accountId=…, orgId=…` |

The sidebar shows only the records in the signed-in account's folder.
Each record names the shared conversation it belongs to, so a copy of a
record in another account's folder shows the same conversation there.

Claude reads an account's folder when that account loads, then keeps the
records in memory and writes them back from memory. Changes made to that
folder by anything else while it is loaded are not seen, and can be
overwritten.

## Session sync

Claude's file guard refuses symlinked and hard-linked files in its data
folder, and Claude saves a record by writing a new file and renaming it, so
linking the folders together does not work. The sync keeps ordinary copies
instead.

One pass:

1. Find every `<account>/<org>` folder and read every record. Records that
   are not plain, single-link, readable JSON with a matching id are left
   alone. If fewer than half the record files are readable, the pass stops.
2. Work out which folder Claude has loaded: from the process list and the
   last initialization line in the log. That folder is **protected**: it
   only receives records it is missing. If Claude is running and the log
   line cannot be found, every folder is protected.
3. For each session, the copy with the latest `lastActivityAt` wins (ties go
   to the newest file) and is written to every other folder. Writes are
   staged in the tool's own folder and renamed into place, with the
   winner's modification time.
4. A session that was in a folder last pass and is gone now was deleted in
   Claude. Its other copies are moved to the tool's trash and it is not
   recreated. More than five at once, or a whole folder disappearing, is
   held for the user to resolve instead.
5. Each folder's `archived-sessions.idx` (a load-order hint) is updated to
   match its records when it already exists.

The background agent runs a pass shortly after any change in the session
folders and every 15 seconds.

## Account switching

Claude has no switcher, and signing out with Claude's own Log Out most likely
ends the session on the server. The app instead keeps a copy of each
account's sign-in and swaps it in while Claude is closed:

1. Quit Claude normally; if it is still open after 45 seconds, stop.
2. Save the outgoing account's sign-in again from disk, so a token Claude
   refreshed in the meantime is kept. This only happens when the log and
   `lastKnownAccountUuid` agree on who that is.
3. Keep a copy of what is there (`previous.json`).
4. Replace the claude.ai cookie rows in one transaction, refusing if the
   cookie database version differs from the one the account was saved with.
   Then replace the three config entries, writing a temp file and renaming
   it. If the config write fails, the old cookies are put back.
5. Open Claude and wait up to 45 seconds for the log to name the target
   account. If it does not, offer to put the previous account back.

The encrypted values are copied exactly; switching never decrypts anything.
**Add Account…** does the same with an empty sign-in, so Claude reopens
signed out while the previous account's session stays valid.

## Usage

For each account the app decrypts its session cookies in memory (PBKDF2-SHA1
over the Keychain password, salt `saltysalt`, 1003 rounds, AES-128-CBC with
an IV of spaces; from cookie database version 24 the plaintext starts with
the SHA-256 of the cookie's host) and calls
`GET https://claude.ai/api/organizations/<orgId>/usage`. The response's
`five_hour` and `seven_day` buckets give percent used and reset times. Only
session cookies are sent, never Cloudflare or analytics cookies, and
redirects are refused.
