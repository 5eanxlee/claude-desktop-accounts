import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPass } from '../src/sync.js'
import { planPresets, readPresets, applyPresets } from '../src/presets.js'
import { stage } from '../src/apply.js'
import { main } from '../src/cli.js'
import { makeEnv, listAll, ACCT_A, ACCT_B, ACCT_C } from './helpers.js'

const stopped = () => false
const pass = (paths, extra = {}) => runPass({ paths, running: stopped, ...extra })

const sshEnv = (fields = {}) => ({
  id: 'e5e5e5e5-0000-4000-8000-000000000001',
  name: 'Workstation',
  target: { kind: 'ssh', sshConfigId: 'cfg-1', cwd: '/home/ubuntu' },
  settings: { modelId: 'claude-opus-5-5', effort: 'high', worktree: false },
  createdAt: 1000,
  lastUsedAt: 1000,
  ...fields
})
const localEnv = (id, cwd) => ({ id, name: cwd, target: { kind: 'local', cwd }, settings: {}, createdAt: 1, lastUsedAt: 1 })

// Claude's settings stores are tab-indented JSON with no trailing newline.
function writePresets(paths, byAccount, mtimeMs) {
  fs.writeFileSync(paths.presetsFile, JSON.stringify({ byAccount }, undefined, '\t'), { mode: 0o600 })
  if (mtimeMs !== undefined) fs.utimesSync(paths.presetsFile, mtimeMs / 1000, mtimeMs / 1000)
}
const readFile = (paths) => JSON.parse(fs.readFileSync(paths.presetsFile, 'utf8')).byAccount
const ids = (catalog) => catalog.presets.map((p) => p.id)

test('an SSH environment from one account is added to every other account', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, {
    [ACCT_A]: { presets: [localEnv('local-a', '/a'), sshEnv()], builtIns: { x: 1 }, seededFromDraft: true },
    [ACCT_B]: { presets: [localEnv('local-b', '/b')], seededFromDraft: true },
    [ACCT_C]: { presets: [] }
  })
  const result = pass(paths)
  assert.equal(result.environments.written, true)
  const after = readFile(paths)
  assert.deepEqual(ids(after[ACCT_A]), ['local-a', sshEnv().id])
  assert.deepEqual(ids(after[ACCT_B]), ['local-b', sshEnv().id], 'local environments stay with their account')
  assert.deepEqual(ids(after[ACCT_C]), [sshEnv().id])
  assert.deepEqual(after[ACCT_B].presets[1], sshEnv())
  assert.equal(after[ACCT_B].seededFromDraft, true)
  assert.deepEqual(after[ACCT_A].builtIns, { x: 1 })
  const text = fs.readFileSync(paths.presetsFile, 'utf8')
  assert.match(text, /^\{\n\t"byAccount"/, 'keeps the tab indentation Claude writes')
  assert.equal(text.endsWith('\n'), false)
  const stat = fs.statSync(paths.presetsFile)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(stat.nlink, 1)
  assert.equal(pass(paths).environments.changes.length, 0, 'a second pass finds nothing to do')
})

test('the environments file is backed up once, before the first change', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } })
  const original = fs.readFileSync(paths.presetsFile)
  const first = pass(paths)
  assert.match(first.environments.backup, /^ccd-session-presets-.*\.json$/)
  assert.deepEqual(fs.readFileSync(path.join(paths.backupsDir, first.environments.backup)), original)
  const data = readFile(paths)
  data[ACCT_B].presets = []
  data[ACCT_C] = { presets: [] }
  writePresets(paths, data)
  assert.equal(pass(paths).environments.backup, null)
  assert.equal(listAll(paths.backupsDir).filter((name) => name.startsWith('ccd-session-presets-')).length, 1)
})

test('deleting an SSH environment in one account removes it from the others', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] }, [ACCT_C]: { presets: [] } })
  pass(paths)
  const data = readFile(paths)
  data[ACCT_B].presets = []
  writePresets(paths, data)
  const result = pass(paths)
  assert.deepEqual(result.environments.changes.map((c) => [c.account, c.removed]), [[ACCT_A, ['Workstation']], [ACCT_C, ['Workstation']]])
  const after = readFile(paths)
  for (const account of [ACCT_A, ACCT_B, ACCT_C]) assert.deepEqual(ids(after[account]), [], account)
  assert.equal(pass(paths).environments.changes.length, 0, 'and it is not brought back')
})

test('an edit in one account spreads; when two accounts changed it, the more recently used copy wins', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } })
  pass(paths)
  const data = readFile(paths)
  data[ACCT_B].presets[0].name = 'Renamed'
  data[ACCT_A].presets[0].lastUsedAt = 5000
  data[ACCT_A].presets[0] = { ...data[ACCT_A].presets[0] }
  writePresets(paths, data)
  // Both copies differ from what was synced; the more recently used one is then taken.
  pass(paths)
  assert.equal(readFile(paths)[ACCT_B].presets[0].lastUsedAt, 5000)
  const again = readFile(paths)
  again[ACCT_B].presets[0].name = 'Renamed'
  writePresets(paths, again)
  pass(paths)
  for (const account of [ACCT_A, ACCT_B]) assert.equal(readFile(paths)[account].presets[0].name, 'Renamed', account)
})

test('accounts without a list of their own are not given one', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] } })
  const result = pass(paths)
  assert.deepEqual(result.environments.changes, [])
  assert.deepEqual(Object.keys(readFile(paths)), [ACCT_A])
})

test('an unfamiliar or missing environments file is left alone', (t) => {
  const { paths } = makeEnv(t)
  assert.deepEqual(pass(paths).environments.changes, [])
  fs.writeFileSync(paths.presetsFile, '{"byAccount": [1, 2]}')
  const result = pass(paths)
  assert.match(result.environments.notes[0], /not in a familiar shape/)
  assert.equal(fs.readFileSync(paths.presetsFile, 'utf8'), '{"byAccount": [1, 2]}')
})

test('a dry run writes nothing', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } })
  const before = fs.readFileSync(paths.presetsFile)
  const result = pass(paths, { dryRun: true })
  assert.deepEqual(result.environments.changes, [{ account: ACCT_B, added: ['Workstation'], updated: [], removed: [] }])
  assert.deepEqual(fs.readFileSync(paths.presetsFile), before)
  assert.equal(fs.existsSync(paths.stateDir), false)
})

test('an environment Claude adds after the read is not mistaken for a deletion later', () => {
  // The write was skipped, so only what the accounts really held is remembered.
  const read = { state: 'ok', data: { byAccount: { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } } } }
  const planned = planPresets({ read, memory: null, now: 1 })
  assert.deepEqual(planned.next.known, { [ACCT_A]: [sshEnv().id], [ACCT_B]: [sshEnv().id] })
  assert.deepEqual(planned.unchanged.known, { [ACCT_A]: [sshEnv().id], [ACCT_B]: [] })
})

test('a file Claude changed between the read and the write is left for the next pass', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } }, 1_700_000_000_000)
  const read = readPresets(paths.presetsFile)
  const planned = planPresets({ read, memory: null, now: 1 })
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [localEnv('new', '/n')] } }, 1_700_000_001_000)
  const after = fs.readFileSync(paths.presetsFile)
  const result = applyPresets({ file: paths.presetsFile, read, catalogs: planned.catalogs, stage: (text) => stage(paths, text) })
  assert.equal(result, 'changed-since-scan')
  assert.deepEqual(fs.readFileSync(paths.presetsFile), after)
})

test('sync --dry-run lists SSH environment changes', (t) => {
  const { paths } = makeEnv(t)
  writePresets(paths, { [ACCT_A]: { presets: [sshEnv()] }, [ACCT_B]: { presets: [] } })
  const lines = []
  const code = main(['sync', '--dry-run'], { paths, out: (line) => lines.push(line), running: stopped })
  assert.equal(code, 0)
  assert.ok(lines.some((line) => line.includes('ssh env') && line.includes(ACCT_B.slice(0, 8)) && line.includes('add Workstation')), lines.join('\n'))
  assert.ok(lines.some((line) => line.includes('SSH environments to update in 1 account')), lines.join('\n'))
})
