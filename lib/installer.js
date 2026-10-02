import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// What gets copied to the permanent folder. The background agent runs from there,
// so it keeps working after npx clears its cache.
const PAYLOAD = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'bin', 'lib', 'sync/package.json', 'sync/bin', 'sync/src', 'app']
const LEFT_OUT = [/^app\/build(\/|$)/, /^app\/README\.md$/]

export const defaultDest = (home = os.homedir()) => path.join(home, '.claude-desktop-accounts')

export function detect({ wantApp = true } = {}) {
  const claudeFound = spawnSync('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'"], { encoding: 'utf8' }).stdout?.trim()
  return {
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    // Only probed when the app is wanted: on a Mac without the tools, xcrun offers to install them.
    hasSwift: wantApp ? spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0 : false,
    hasClaude: Boolean(claudeFound) || ['/Applications', path.join(os.homedir(), 'Applications')].some((dir) => fs.existsSync(path.join(dir, 'Claude.app')))
  }
}

export function problems(found, { wantSync, wantApp }) {
  const list = []
  if (found.platform !== 'darwin') list.push('This only works on macOS.')
  if (!found.hasClaude) list.push('Claude Desktop is not installed. Get it from https://claude.ai/download')
  if (wantSync && found.nodeMajor < 22) list.push('The session sync needs Node.js 22 or newer (for example: brew install node), or use --no-sync.')
  if (wantApp && !found.hasSwift) list.push('The menu bar app is compiled on your Mac and needs the Xcode command line tools: xcode-select --install, or use --no-app.')
  return list
}

const same = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}

// Copies into a staging folder, then swaps it in, so an interrupted copy never leaves a half install.
export function copyPayload(src, dest) {
  if (same(src, dest)) return false
  const staging = `${dest}.new`
  const old = `${dest}.old`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  for (const item of PAYLOAD) {
    const from = path.join(src, item)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(staging, item), {
      recursive: true,
      filter: (file) => !LEFT_OUT.some((pattern) => pattern.test(path.relative(src, file).split(path.sep).join('/')))
    })
  }
  fs.rmSync(old, { recursive: true, force: true })
  if (fs.existsSync(dest)) fs.renameSync(dest, old)
  fs.renameSync(staging, dest)
  fs.rmSync(old, { recursive: true, force: true })
  return true
}

export const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1

export function install({ src, dest, wantSync, wantApp, run, out }) {
  out(copyPayload(src, dest) ? `Copied to ${dest}` : `Using ${dest}`)
  if (wantSync) {
    out('')
    out('Session sync:')
    const status = run(process.execPath, [path.join(dest, 'sync/bin/claude-session-sync.js'), 'install'])
    if (status !== 0) return status
  }
  if (wantApp) {
    out('')
    out('Claude Accounts app (compiling takes a minute):')
    const status = run('/bin/zsh', [path.join(dest, 'app/build.sh'), 'install'])
    if (status !== 0) return status
  }
  out('')
  out('Installed. Next:')
  if (wantSync) out('  - Quit and reopen Claude once so it reloads its session list.')
  if (wantApp) {
    out('  - In the menu bar, Claude > Save Current Account. For each other account use Add Account…')
    out('    When macOS asks about "Claude Safe Storage", choose Always Allow so usage can be shown.')
  }
  out('  - Update: npx claude-desktop-accounts@latest   Remove: npx claude-desktop-accounts uninstall')
  return 0
}

export function uninstall({ home, dest, purge, appDirs = ['/Applications', path.join(home, 'Applications')], run, out }) {
  const sync = path.join(dest, 'sync/bin/claude-session-sync.js')
  if (fs.existsSync(sync)) {
    run(process.execPath, [sync, 'uninstall'])
  } else {
    run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/local.claude-session-sync`])
    fs.rmSync(path.join(home, 'Library/LaunchAgents/local.claude-session-sync.plist'), { force: true })
  }
  run('/usr/bin/pkill', ['-f', 'Claude Accounts.app/Contents/MacOS/ClaudeAccounts'])
  for (const dir of appDirs) {
    const app = path.join(dir, 'Claude Accounts.app')
    if (fs.existsSync(app)) {
      fs.rmSync(app, { recursive: true, force: true })
      out(`Removed ${app}`)
    }
  }
  if (purge) {
    const support = path.join(home, 'Library/Application Support')
    for (const dir of ['Claude Accounts', 'claude-session-sync']) fs.rmSync(path.join(support, dir), { recursive: true, force: true })
    for (const log of ['claude-session-sync.log', 'claude-session-sync.log.1', 'claude-session-sync.err.log']) {
      fs.rmSync(path.join(home, 'Library/Logs', log), { force: true })
    }
    out('Deleted saved accounts, sync state, backups, trash and logs.')
    if (dest === defaultDest(home)) {
      fs.rmSync(dest, { recursive: true, force: true })
      out(`Deleted ${dest}`)
    }
  }
  out('Done. Claude itself was not changed.')
  return 0
}
