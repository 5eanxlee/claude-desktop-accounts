import { fileURLToPath } from 'node:url'
import { defaultPaths } from './paths.js'
import { runPass, stampOf } from './sync.js'
import { loadState } from './state.js'
import { listBackups, restoreBackup } from './apply.js'
import { isClaudeRunning } from './active.js'
import { makeLogger } from './log.js'
import { startWatch, describePass } from './watch.js'
import * as launchd from './launchd.js'

const SCRIPT = fileURLToPath(new URL('../bin/claude-session-sync.js', import.meta.url))

const USAGE = `Usage: claude-session-sync <command>

  sync [--dry-run]        make every account folder hold every session, once
  sync --held=delete      treat held bulk removals as real deletions
  sync --held=restore     put held sessions back where they vanished from
  status                  show folders, what is out of sync, and the agent
  install                 sync now, then keep syncing in the background from login
  uninstall               stop the background agent (backups and state are kept)
  restore [backup]        put a backup of the session folders back
  watch                   run the sync loop in the foreground (what the agent runs)`

const short = (key) => key.split('/').map((part) => part.slice(0, 8)).join('/')
const count = (actions, type) => actions.filter((a) => a.type === type).length
const heldCount = (held) => Object.values(held).reduce((n, ids) => n + ids.length, 0)
const verb = { create: 'create', overwrite: 'update', trash: 'trash' }

function titleOf(summary, action) {
  const source = summary.scanned.folders.find((f) => f.key === (action.from ?? action.folder))
  try {
    const title = JSON.parse(source.records.get(action.id).bytes.toString('utf8')).title
    return typeof title === 'string' && title ? title.slice(0, 60) : '(untitled)'
  } catch {
    return '(untitled)'
  }
}

function describeAction(summary, action, prefix = '') {
  if (action.type === 'hint') return `  ${'hint'.padEnd(9)} ${short(action.folder)}  archived list of ${action.ids.length}`
  const from = action.from ? `  from ${short(action.from)}` : ''
  return `  ${(prefix + verb[action.type]).padEnd(9)} ${short(action.folder)}  ${titleOf(summary, action)} (${action.id.slice(0, 14)})${from}`
}

function header(summary) {
  const claude = !summary.running
    ? 'Claude is not running'
    : summary.protected.length === 1
      ? `Claude is running; active folder ${short(summary.protected[0])}`
      : 'Claude is running; active folder unknown, so no existing record is modified'
  return `${summary.folders} folders, ${summary.sessions} sessions. ${claude}.`
}

function planLine(summary) {
  const a = summary.actions
  return `${count(a, 'create')} to create, ${count(a, 'overwrite')} to update, ${count(a, 'trash')} to trash; ${summary.deferred.length} deferred; ${heldCount(summary.held)} held`
}

function sync(flags, { paths, out, running }) {
  const held = flags.find((f) => f.startsWith('--held='))?.slice('--held='.length) ?? null
  const dryRun = flags.includes('--dry-run')
  const unknown = flags.filter((f) => f !== '--dry-run' && !f.startsWith('--held='))
  if (unknown.length > 0 || (held !== null && held !== 'delete' && held !== 'restore')) {
    out(USAGE)
    return 2
  }
  const summary = runPass({ paths, dryRun, heldResolution: held, running })
  if (summary.locked) {
    out('Another sync pass is running; try again in a moment.')
    return 1
  }
  out(header(summary))
  if (summary.abort) {
    out(`Stopped without changes: ${summary.notes.join('; ')}.`)
    return 1
  }
  if (dryRun) {
    out('Dry run: nothing was written.')
    for (const action of summary.actions) out(describeAction(summary, action))
    for (const action of summary.deferred) out(describeAction(summary, action, 'later: '))
    out(`Plan: ${planLine(summary)}.`)
  } else {
    out(`Done: ${describePass(summary)}.`)
  }
  for (const note of summary.notes) out(`Note: ${note}.`)
  return summary.results.errors.length > 0 ? 1 : 0
}

function status({ paths, out, running, agent }) {
  const summary = runPass({ paths, dryRun: true, running })
  const state = loadState(paths, { readOnly: true })
  out(header(summary))
  for (const folder of summary.scanned.folders) {
    const active = summary.running && summary.protected.length === 1 && summary.protected[0] === folder.key ? '  active' : ''
    out(`  ${short(folder.key)}  ${String(folder.records.size).padStart(3)} sessions${active}`)
  }
  out(summary.abort ? `Layout not recognised: ${summary.notes.join('; ')}.` : `Out of sync: ${planLine(summary)}.`)
  for (const [key, ids] of Object.entries(summary.held)) out(`  held in ${short(key)}: ${ids.length} sessions (resolve with sync --held=delete or --held=restore)`)
  const { installed, loaded } = agent.agentStatus({ paths })
  out(`Agent: ${installed ? (loaded ? 'installed and running' : 'installed but not loaded') : 'not installed'}`)
  out(`Last change: ${state.lastChange ? new Date(state.lastChange).toLocaleString() : 'never'}`)
  const backups = listBackups(paths)
  out(`Backups: ${backups.length === 0 ? 'none' : backups.join(', ')}`)
  out(`Log: ${paths.logFile}`)
  return 0
}

function install(deps) {
  const { paths, out, agent } = deps
  const code = sync([], deps)
  if (code !== 0) {
    out('Not installing the background agent until a sync pass succeeds.')
    return 1
  }
  agent.install({ paths, node: launchd.stableNodePath(), script: SCRIPT })
  out('Background agent installed; it starts at login and is running now.')
  out('Restart Claude once so the account that is open now reloads its session list.')
  return 0
}

function restore(args, { paths, out, running, agent }) {
  if (agent.agentStatus({ paths }).installed) {
    out('The background agent is installed and would undo a restore. Run uninstall first.')
    return 1
  }
  if (running()) {
    out('Quit Claude first; it rewrites session records from memory while it runs.')
    return 1
  }
  const backups = listBackups(paths)
  const name = args[0] ?? loadState(paths, { readOnly: true }).firstBackup ?? backups[0]
  if (!name || !backups.includes(name)) {
    out(name ? `No backup named ${name}. Available: ${backups.join(', ') || 'none'}.` : 'No backup to restore.')
    return 1
  }
  restoreBackup(paths, name, stampOf(Date.now()))
  out(`Restored ${name}. The folders it replaced are in ${paths.trashDir}.`)
  return 0
}

function watch({ paths }) {
  const log = makeLogger(paths.logFile)
  log('watch started')
  const stop = startWatch({ paths, log })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      stop()
      log('watch stopped')
      process.exit(0)
    })
  }
  return null
}

// Returns an exit code, or null when the command keeps the process running.
export function main(argv, overrides = {}) {
  const deps = {
    paths: defaultPaths(),
    out: (line) => console.log(line),
    running: isClaudeRunning,
    agent: launchd,
    ...overrides
  }
  const [command, ...rest] = argv
  switch (command) {
    case 'sync':
      return sync(rest, deps)
    case 'status':
      return status(deps)
    case 'install':
      return install(deps)
    case 'uninstall':
      deps.agent.uninstall({ paths: deps.paths })
      deps.out('Background agent removed. Backups, trash and state are kept.')
      return 0
    case 'restore':
      return restore(rest, deps)
    case 'watch':
      return watch(deps)
    default:
      deps.out(USAGE)
      return 2
  }
}
