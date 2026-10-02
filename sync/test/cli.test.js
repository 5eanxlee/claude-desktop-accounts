import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'
import { defaultPaths } from '../src/paths.js'
import { loadState } from '../src/state.js'
import { listBackups } from '../src/apply.js'
import { stableNodePath } from '../src/launchd.js'
import { makeEnv, makeFolder, folderDir, writeRecord, readRecord, hasRecord, writeLog, initLine, listAll, sid, ACCT_A, ORG_A, KEY_A, KEY_B } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/claude-session-sync.js', import.meta.url))

// Runs the CLI in-process with its outside world (launchd, process list) replaced.
function cli(paths, argv, { running = false, agent = {} } = {}) {
  const out = []
  const calls = []
  const deps = {
    paths,
    out: (line) => out.push(line),
    running: () => running,
    agent: {
      install: (args) => calls.push(['install', args.node, args.script]),
      uninstall: () => calls.push(['uninstall']),
      agentStatus: () => ({ installed: false, loaded: false }),
      ...agent
    }
  }
  const code = main(argv, deps)
  return { code, text: out.join('\n'), calls }
}

test('sync --dry-run lists what would change, by title, and changes nothing', (t) => {
  const { paths, root } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { title: 'Fix the login bug' })
  makeFolder(paths, KEY_B)
  const before = listAll(root)
  const { code, text } = cli(paths, ['sync', '--dry-run'])
  assert.equal(code, 0)
  assert.match(text, /Dry run: nothing was written/)
  assert.match(text, /create\s+bbbbbbbb\/b0b0b0b0\s+Fix the login bug/)
  assert.match(text, /1 to create/)
  assert.deepEqual(listAll(root), before)
})

test('sync makes the change and says what it did', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const { code, text } = cli(paths, ['sync'])
  assert.equal(code, 0)
  assert.match(text, /1 created/)
  assert.match(text, /backup .* taken/)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
})

test('sync reports deferred work with the reason', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { lastActivityAt: 100, title: 'Older copy' })
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 200, title: 'Newer copy' })
  writeLog(paths, [initLine(ACCT_A, ORG_A)])
  const { text } = cli(paths, ['sync'], { running: true })
  assert.match(text, /Claude is running; active folder aaaaaaaa\/a0a0a0a0/)
  assert.match(text, /1 deferred/)
  assert.equal(readRecord(paths, KEY_A, sid(1)).title, 'Older copy')
})

test('sync exits non-zero when the layout looks unfamiliar', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  for (const n of [2, 3, 4]) fs.writeFileSync(path.join(folderDir(paths, KEY_A), `${sid(n)}.json`), 'garbage')
  const { code, text } = cli(paths, ['sync'])
  assert.equal(code, 1)
  assert.match(text, /Stopped without changes/)
})

test('sync --held=restore brings held sessions back', (t) => {
  const { paths } = makeEnv(t)
  const ids = [1, 2, 3, 4, 5, 6].map(sid)
  for (const id of ids) writeRecord(paths, KEY_A, id)
  makeFolder(paths, KEY_B)
  cli(paths, ['sync'])
  for (const id of ids) fs.rmSync(path.join(folderDir(paths, KEY_A), `${id}.json`))
  assert.match(cli(paths, ['sync']).text, /6 held/)
  cli(paths, ['sync', '--held=restore'])
  assert.equal(ids.every((id) => hasRecord(paths, KEY_A, id)), true)
})

test('an unknown --held value is a usage error', (t) => {
  const { paths } = makeEnv(t)
  const { code, text } = cli(paths, ['sync', '--held=maybe'])
  assert.equal(code, 2)
  assert.match(text, /Usage/)
})

test('an unknown command is a usage error', (t) => {
  const { paths } = makeEnv(t)
  const { code, text } = cli(paths, ['frobnicate'])
  assert.equal(code, 2)
  assert.match(text, /Usage/)
})

test('status shows each folder, what is out of sync, and the agent state', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  writeRecord(paths, KEY_A, sid(2))
  makeFolder(paths, KEY_B)
  const { code, text } = cli(paths, ['status'])
  assert.equal(code, 0)
  assert.match(text, /aaaaaaaa\/a0a0a0a0\s+2 sessions/)
  assert.match(text, /bbbbbbbb\/b0b0b0b0\s+0 sessions/)
  assert.match(text, /2 to create/)
  assert.match(text, /Agent: not installed/)
  assert.equal(fs.existsSync(paths.stateDir), false)
})

test('install syncs first, then registers the agent with this node and script', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const { code, text, calls } = cli(paths, ['install'])
  assert.equal(code, 0)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
  assert.deepEqual(calls, [['install', stableNodePath(), BIN]])
  assert.match(text, /Restart Claude once/)
})

test('install does not register the agent when the first pass is refused', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  for (const n of [2, 3, 4]) fs.writeFileSync(path.join(folderDir(paths, KEY_A), `${sid(n)}.json`), 'garbage')
  const { code, calls } = cli(paths, ['install'])
  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('uninstall removes the agent and leaves backups and state', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  cli(paths, ['sync'])
  const { code, calls } = cli(paths, ['uninstall'])
  assert.equal(code, 0)
  assert.deepEqual(calls, [['uninstall']])
  assert.equal(listBackups(paths).length, 1)
  assert.deepEqual(loadState(paths).known[KEY_B], [sid(1)])
})

test('restore refuses while the agent is installed', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  cli(paths, ['sync'])
  const { code, text } = cli(paths, ['restore'], { agent: { agentStatus: () => ({ installed: true, loaded: true }) } })
  assert.equal(code, 1)
  assert.match(text, /uninstall/)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
})

test('restore refuses while Claude is running', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  cli(paths, ['sync'])
  const { code, text } = cli(paths, ['restore'], { running: true })
  assert.equal(code, 1)
  assert.match(text, /Quit Claude/)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
})

test('restore puts the first backup back', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  cli(paths, ['sync'])
  const { code, text } = cli(paths, ['restore'])
  assert.equal(code, 0)
  assert.match(text, /Restored/)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
  assert.equal(hasRecord(paths, KEY_A, sid(1)), true)
})

test('restore with nothing backed up says so', (t) => {
  const { paths } = makeEnv(t)
  const { code, text } = cli(paths, ['restore'])
  assert.equal(code, 1)
  assert.match(text, /No backup/)
})

test('the installed command runs end to end against a relocated home', (t) => {
  const { root } = makeEnv(t)
  const paths = defaultPaths({ env: { CSS_HOME: root } })
  writeRecord(paths, KEY_A, sid(1), { title: 'End to end' })
  makeFolder(paths, KEY_B)
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, CSS_HOME: root }, encoding: 'utf8' })
  const dry = run('sync', '--dry-run')
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /End to end/)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
  const bad = run('nonsense')
  assert.equal(bad.status, 2)
  assert.equal(bad.stderr, '')
})
