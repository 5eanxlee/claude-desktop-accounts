# claude-session-sync

Claude Desktop lists Code-tab sessions per account, so switching accounts
hides every session started under another one. This tool keeps a copy of
every session record in every account's folder, so each account shows the
same list. The conversations themselves are already shared between
accounts; only the sidebar records are per account.

macOS only. No dependencies, no network access, nothing read from Keychain.
Unofficial: it relies on an undocumented file layout and does nothing when
that layout stops looking familiar.

## Use

The [installer](../README.md#install) sets this up. To run it by hand
(from `~/.claude-desktop-accounts/sync`, or this folder in a clone):

```bash
node bin/claude-session-sync.js sync --dry-run   # show what would change
node bin/claude-session-sync.js install          # sync now, then keep syncing from login
node bin/claude-session-sync.js status
```

After the first `install`, restart Claude once. The account that was open
reads its folder only when it loads, so the backfilled sessions appear
after that restart. From then on, a session started under one account is
in the other accounts' lists when you switch.

| Command | Effect |
|---|---|
| `sync [--dry-run]` | One pass over every account folder |
| `sync --held=delete` | Treat held bulk removals as real deletions |
| `sync --held=restore` | Put held sessions back where they vanished from |
| `status` | Folders, what is out of sync, agent state, backups |
| `install` | Sync, then install and start the background agent |
| `uninstall` | Stop and remove the agent; backups, trash and state stay |
| `restore [backup]` | Put a backup back (Claude closed, agent uninstalled) |
| `watch` | The sync loop in the foreground; this is what the agent runs |

## How it behaves

- **Newest activity wins.** For each session the copy with the latest
  `lastActivityAt` is written to the other folders; ties go to the newest
  file.
- **The open account is add-only.** While Claude is running, the folder of
  the signed-in account only receives missing records. Updates and removals
  there wait until you switch away or quit, because Claude rewrites its
  records from memory.
- **Deletes follow.** A session deleted in one account is moved out of the
  others into the tool's trash folder. If more than five vanish at once, or
  a whole folder disappears, nothing is removed; `status` shows them as
  held until you resolve them.
- **Ordinary files only.** Copies are staged in the tool's own folder and
  renamed into place with the same permissions the app uses. No links and
  no temporary files inside Claude's folders.

## Where things are

| What | Where |
|---|---|
| State, backups, trash | `~/Library/Application Support/claude-session-sync/` |
| Log | `~/Library/Logs/claude-session-sync.log` |
| Agent | `~/Library/LaunchAgents/local.claude-session-sync.plist` |

The agent runs the script from this folder, so moving or deleting the
folder breaks it; run `install` again from the new location. The repository
installer keeps it in `~/.claude-desktop-accounts/sync`.

A backup of the session folders is taken before the first change. To undo
everything: `uninstall`, quit Claude, then `restore`.

## Limits

- Cowork sessions, cloud sessions, Remote Control, artifacts and scheduled
  tasks stay with the account that created them.
- Continuing a session sends its whole conversation through whichever
  account is signed in.
- Per-tool connector switches may reset when a session is resumed under
  another account.
- If Claude loads a folder in the instant before an update lands, that
  account shows a slightly stale title or turn count until the session is
  used again. The conversation is never affected.

## Development

```bash
npm test
```

`CSS_HOME=/some/dir` points every path at another home directory, which is
how to try the tool against a copy of the real folders. How it works:
[docs/how-it-works.md](../docs/how-it-works.md).
