import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { defaultPaths } from '../src/paths.js'
import { makeLogger } from '../src/log.js'
import { LABEL, plistXml, install, uninstall, stableNodePath } from '../src/launchd.js'
import { startWatch } from '../src/watch.js'
import { makeEnv, makeFolder, writeRecord, hasRecord, sid, KEY_A, KEY_B } from './helpers.js'

const stopped = () => false
const until = async (check, ms = 3000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

test('default paths sit under the home directory', () => {
  const paths = defaultPaths({ home: '/Users/someone', env: {} })
  assert.equal(paths.sessionsRoot, '/Users/someone/Library/Application Support/Claude/claude-code-sessions')
  assert.equal(paths.mainLog, '/Users/someone/Library/Logs/Claude/main.log')
  assert.equal(paths.stateFile, '/Users/someone/Library/Application Support/claude-session-sync/state.json')
  assert.equal(paths.logFile, '/Users/someone/Library/Logs/claude-session-sync.log')
  assert.equal(paths.launchAgent, '/Users/someone/Library/LaunchAgents/local.claude-session-sync.plist')
})

test('CSS_HOME relocates every path, for trying the tool against a copy', () => {
  const paths = defaultPaths({ home: '/Users/someone', env: { CSS_HOME: '/tmp/sandbox' } })
  assert.equal(paths.sessionsRoot, '/tmp/sandbox/Library/Application Support/Claude/claude-code-sessions')
  assert.equal(paths.stagingDir, '/tmp/sandbox/Library/Application Support/claude-session-sync/staging')
})

test('the logger appends timestamped lines', (t) => {
  const { paths } = makeEnv(t)
  const log = makeLogger(paths.logFile, { now: () => Date.UTC(2026, 8, 30, 12, 0, 0) })
  log('first')
  log('second')
  assert.deepEqual(fs.readFileSync(paths.logFile, 'utf8').split('\n'), [
    '2026-09-30T12:00:00.000Z first',
    '2026-09-30T12:00:00.000Z second',
    ''
  ])
})

test('the logger rotates once the file passes its size limit, keeping one old file', (t) => {
  const { paths } = makeEnv(t)
  const log = makeLogger(paths.logFile, { maxBytes: 100 })
  for (let i = 0; i < 10; i++) log(`line ${i} ${'x'.repeat(30)}`)
  assert.ok(fs.statSync(paths.logFile).size <= 200)
  assert.ok(fs.existsSync(`${paths.logFile}.1`))
  assert.equal(fs.existsSync(`${paths.logFile}.2`), false)
  assert.match(fs.readFileSync(paths.logFile, 'utf8'), /line 9/)
})

test('the plist runs the watch command at login and keeps it alive', () => {
  const xml = plistXml({ node: '/opt/homebrew/bin/node', script: '/Users/x/claude-session-sync/bin/claude-session-sync.js', errorLog: '/Users/x/err.log' })
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`))
  assert.match(xml, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/x\/claude-session-sync\/bin\/claude-session-sync\.js<\/string>\s*<string>watch<\/string>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/x\/err\.log<\/string>/)
})

test('the plist escapes characters that are special in XML', () => {
  const xml = plistXml({ node: '/n', script: '/Users/a&b/<x>.js', errorLog: '/e' })
  assert.match(xml, /\/Users\/a&amp;b\/&lt;x&gt;\.js/)
})

test('the agent uses a stable node path that survives a package-manager upgrade', (t) => {
  const { root } = makeEnv(t)
  const versioned = path.join(root, 'Cellar', 'node', '24.5.0', 'bin')
  const stable = path.join(root, 'bin')
  fs.mkdirSync(versioned, { recursive: true })
  fs.mkdirSync(stable)
  fs.writeFileSync(path.join(versioned, 'node'), '')
  fs.symlinkSync(path.join(versioned, 'node'), path.join(stable, 'node'))
  const execPath = path.join(versioned, 'node')
  assert.equal(stableNodePath(execPath, [path.join(root, 'empty'), stable]), path.join(stable, 'node'))
})

test('the agent falls back to the running node when no stable path points at it', (t) => {
  const { root } = makeEnv(t)
  assert.equal(stableNodePath('/some/where/node', [root]), '/some/where/node')
})

test('install writes the plist and loads it; uninstall unloads and removes it', (t) => {
  const { paths } = makeEnv(t)
  const calls = []
  const run = (args) => {
    calls.push(args.join(' '))
    return 0
  }
  install({ paths, node: '/n', script: '/s.js', uid: 501, run })
  assert.match(fs.readFileSync(paths.launchAgent, 'utf8'), /<string>\/s\.js<\/string>/)
  assert.deepEqual(calls, [`bootout gui/501/${LABEL}`, `bootstrap gui/501 ${paths.launchAgent}`])
  uninstall({ paths, uid: 501, run })
  assert.equal(fs.existsSync(paths.launchAgent), false)
  assert.equal(calls.at(-1), `bootout gui/501/${LABEL}`)
})

test('install reports failure when launchd refuses the agent', (t) => {
  const { paths } = makeEnv(t)
  const run = (args) => (args[0] === 'bootstrap' ? 5 : 0)
  assert.throws(() => install({ paths, node: '/n', script: '/s.js', uid: 501, run }), /launchctl bootstrap failed/)
})

test('the watcher mirrors a new record shortly after it appears', async (t) => {
  const { paths } = makeEnv(t)
  makeFolder(paths, KEY_A)
  makeFolder(paths, KEY_B)
  const stop = startWatch({ paths, running: stopped, debounceMs: 20, intervalMs: 60_000 })
  t.after(stop)
  writeRecord(paths, KEY_A, sid(1))
  assert.equal(await until(() => hasRecord(paths, KEY_B, sid(1))), true)
})

test('the periodic pass covers a sessions root that did not exist at start', async (t) => {
  const { paths } = makeEnv(t)
  fs.rmSync(paths.sessionsRoot, { recursive: true })
  const stop = startWatch({ paths, running: stopped, debounceMs: 20, intervalMs: 40 })
  t.after(stop)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  assert.equal(await until(() => hasRecord(paths, KEY_B, sid(1))), true)
})

test('a stopped watcher does no further work', async (t) => {
  const { paths } = makeEnv(t)
  makeFolder(paths, KEY_A)
  makeFolder(paths, KEY_B)
  const stop = startWatch({ paths, running: stopped, debounceMs: 20, intervalMs: 40 })
  stop()
  writeRecord(paths, KEY_A, sid(1))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
})

test('the watcher logs a pass that changed something, and does not repeat an unchanged report', async (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const lines = []
  const stop = startWatch({ paths, running: stopped, debounceMs: 20, intervalMs: 30, log: (line) => lines.push(line) })
  t.after(stop)
  await until(() => hasRecord(paths, KEY_B, sid(1)))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(lines.filter((line) => /1 created/.test(line)).length, 1)
  assert.equal(lines.length, 1)
  assert.ok(path.isAbsolute(paths.sessionsRoot))
})
