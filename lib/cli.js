import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, problems, install, uninstall, run, defaultDest } from './installer.js'
import { main as syncMain } from '../sync/src/cli.js'
import { defaultPaths } from '../sync/src/paths.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const USAGE = `claude-desktop-accounts ${VERSION}
Session sync and account switching for Claude Desktop on macOS (unofficial).

Usage: npx claude-desktop-accounts [command]

  install [--no-sync] [--no-app] [--yes]   set up both tools (the default command)
  uninstall [--purge]                      remove them; --purge also deletes saved data
  status                                   show the session sync's state
  sync [--dry-run] [--held=delete|restore] run the session sync once
  restore [backup]                         put the session folders back from a backup

  --no-sync   skip the session sync        --no-app   skip the menu bar app
  --yes       do not ask for confirmation  --version  print the version`

function ttyAvailable() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'r'))
    return true
  } catch {
    return false
  }
}

// Reads the answer from the terminal even when stdin is a pipe (curl | bash).
function askTTY(question) {
  process.stdout.write(question)
  const fd = fs.openSync('/dev/tty', 'r')
  try {
    const buffer = Buffer.alloc(256)
    const n = fs.readSync(fd, buffer, 0, buffer.length, null)
    return buffer.toString('utf8', 0, n).trim()
  } finally {
    fs.closeSync(fd)
  }
}

function installCommand(args, deps) {
  if (args.includes('--help') || args.includes('-h')) {
    deps.out(USAGE)
    return 0
  }
  const known = ['--no-sync', '--no-app', '--yes', '-y']
  if (args.some((arg) => !known.includes(arg))) {
    deps.out(USAGE)
    return 2
  }
  const wantSync = !args.includes('--no-sync')
  const wantApp = !args.includes('--no-app')
  const yes = args.includes('--yes') || args.includes('-y')
  if (!wantSync && !wantApp) {
    deps.out('Nothing to install: both tools were left out.')
    return 2
  }
  const missing = problems(deps.detect({ wantApp }), { wantSync, wantApp })
  if (missing.length > 0) {
    for (const problem of missing) deps.out(`Cannot install: ${problem}`)
    return 1
  }
  deps.out('This will:')
  if (wantSync) deps.out("  - back up Claude's Code session list, copy every session into every account's list, and keep them in step from login")
  if (wantApp) deps.out('  - build the Claude Accounts menu bar app on this Mac and install it')
  deps.out(`  - keep the program in ${deps.dest}`)
  if (!yes) {
    if (!deps.isTTY) {
      deps.out('There is no terminal to ask on. Rerun with --yes to install.')
      return 1
    }
    if (!/^y(es)?$/i.test(deps.ask('Continue? [y/N] '))) {
      deps.out('Nothing was installed.')
      return 0
    }
  }
  return install({ src: deps.src, dest: deps.dest, wantSync, wantApp, run: deps.run, out: deps.out })
}

function uninstallCommand(args, deps) {
  if (args.some((arg) => arg !== '--purge')) {
    deps.out(USAGE)
    return 2
  }
  return uninstall({ home: deps.home, dest: deps.dest, purge: args.includes('--purge'), run: deps.run, out: deps.out })
}

// Returns an exit code.
export function main(argv, overrides = {}) {
  const deps = {
    out: (line) => console.log(line),
    isTTY: ttyAvailable(),
    ask: askTTY,
    detect,
    run,
    env: process.env,
    home: os.homedir(),
    src: ROOT,
    ...overrides
  }
  deps.dest ??= deps.env.CDA_DIR || defaultDest(deps.home)
  const [first, ...rest] = argv
  if (first === '--version' || first === '-v') {
    deps.out(VERSION)
    return 0
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    deps.out(USAGE)
    return 0
  }
  const implicit = first === undefined || first.startsWith('-')
  const command = implicit ? 'install' : first
  const args = implicit ? argv : rest
  switch (command) {
    case 'install':
      return installCommand(args, deps)
    case 'uninstall':
      return uninstallCommand(args, deps)
    case 'status':
    case 'sync':
    case 'restore':
      return syncMain([command, ...args], { paths: defaultPaths({ env: deps.env }), out: deps.out })
    default:
      deps.out(USAGE)
      return 2
  }
}
