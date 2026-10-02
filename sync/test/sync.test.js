import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPass } from '../src/sync.js'
import { applyActions, takeBackup, restoreBackup, listBackups } from '../src/apply.js'
import { loadState, acquireLock } from '../src/state.js'
import { scan } from '../src/scan.js'
import {
  makeEnv, makeFolder, folderDir, writeRecord, readRecord, hasRecord, writeHint, readHint, writeLog, initLine, listAll, sid,
  ACCT_A, ORG_A, KEY_A, KEY_B, KEY_C
} from './helpers.js'

const stopped = () => false
const runningClaude = () => true
const pass = (paths, extra = {}) => runPass({ paths, running: stopped, ...extra })

test('a pass copies a record into every other folder byte for byte', (t) => {
  const { paths } = makeEnv(t)
  const source = writeRecord(paths, KEY_A, sid(1), { title: 'hello' }, 1_700_000_000_000)
  makeFolder(paths, KEY_B)
  makeFolder(paths, KEY_C)
  const result = pass(paths)
  assert.equal(result.results.done.length, 2)
  for (const key of [KEY_B, KEY_C]) {
    const copy = path.join(folderDir(paths, key), `${sid(1)}.json`)
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(source))
    const stat = fs.statSync(copy)
    assert.equal(stat.mode & 0o777, 0o600)
    assert.equal(stat.nlink, 1)
    assert.equal(stat.mtimeMs, 1_700_000_000_000)
  }
})

test('a second pass finds nothing to do', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  writeRecord(paths, KEY_B, sid(2))
  pass(paths)
  const again = pass(paths)
  assert.deepEqual(again.actions, [])
  assert.deepEqual(again.deferred, [])
})

test('a dry run reports the plan and writes nothing at all', (t) => {
  const { paths, root } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const before = listAll(root)
  const result = pass(paths, { dryRun: true })
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_B, id: sid(1), from: KEY_A }])
  assert.deepEqual(listAll(root), before)
  assert.equal(fs.existsSync(paths.stateDir), false)
})

test('the first pass that changes anything takes one backup of the original layout', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const first = pass(paths)
  assert.ok(first.backup)
  assert.deepEqual(listAll(path.join(paths.backupsDir, first.backup)), [`${KEY_A}/${sid(1)}.json`])
  writeRecord(paths, KEY_A, sid(2))
  const second = pass(paths)
  assert.equal(second.backup, null)
  assert.equal(listBackups(paths).length, 1)
})

test('no backup is taken when there is nothing to change', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  const result = pass(paths)
  assert.equal(result.backup, null)
  assert.deepEqual(listBackups(paths), [])
})

test('an overwrite waits while the folder is active and lands once Claude stops', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { lastActivityAt: 100, title: 'stale' })
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 200, title: 'fresh' })
  writeLog(paths, [initLine(ACCT_A, ORG_A)])
  const during = pass(paths, { running: runningClaude })
  assert.deepEqual(during.deferred, [{ type: 'overwrite', folder: KEY_A, id: sid(1), from: KEY_B }])
  assert.equal(readRecord(paths, KEY_A, sid(1)).title, 'stale')
  pass(paths)
  assert.equal(readRecord(paths, KEY_A, sid(1)).title, 'fresh')
})

test('every folder is left unmodified when Claude runs and the active account is unknown', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { lastActivityAt: 100 })
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 200 })
  const result = pass(paths, { running: runningClaude })
  assert.deepEqual(result.actions, [])
  assert.equal(result.deferred.length, 1)
})

test('deleting a session in one folder moves the other copies to trash and keeps it deleted', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  pass(paths)
  fs.rmSync(path.join(folderDir(paths, KEY_A), `${sid(1)}.json`))
  pass(paths)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
  assert.equal(hasRecord(paths, KEY_A, sid(1)), false)
  assert.equal(listAll(paths.trashDir).filter((f) => f.endsWith(`${KEY_B}/${sid(1)}.json`)).length, 1)
  const third = pass(paths)
  assert.deepEqual(third.actions, [])
  assert.equal(hasRecord(paths, KEY_A, sid(1)), false)
})

test('a bulk disappearance is held and both resolutions work', (t) => {
  const { paths } = makeEnv(t)
  const ids = [1, 2, 3, 4, 5, 6].map(sid)
  for (const id of ids) writeRecord(paths, KEY_A, id)
  makeFolder(paths, KEY_B)
  pass(paths)
  for (const id of ids) fs.rmSync(path.join(folderDir(paths, KEY_A), `${id}.json`))
  const heldPass = pass(paths)
  assert.deepEqual(heldPass.held, { [KEY_A]: ids })
  assert.equal(ids.every((id) => hasRecord(paths, KEY_B, id)), true)
  assert.equal(ids.some((id) => hasRecord(paths, KEY_A, id)), false)
  pass(paths, { heldResolution: 'restore' })
  assert.equal(ids.every((id) => hasRecord(paths, KEY_A, id)), true)
  assert.deepEqual(loadState(paths).held, {})
})

test('resolving a hold as delete trashes the remaining copies', (t) => {
  const { paths } = makeEnv(t)
  const ids = [1, 2, 3, 4, 5, 6].map(sid)
  for (const id of ids) writeRecord(paths, KEY_A, id)
  makeFolder(paths, KEY_B)
  pass(paths)
  for (const id of ids) fs.rmSync(path.join(folderDir(paths, KEY_A), `${id}.json`))
  pass(paths)
  pass(paths, { heldResolution: 'delete' })
  assert.equal(ids.some((id) => hasRecord(paths, KEY_B, id)), false)
  assert.equal(listAll(paths.trashDir).length, 6)
})

test('session folders never contain anything but what the app expects', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 9999 })
  makeFolder(paths, KEY_C)
  pass(paths)
  assert.deepEqual(listAll(paths.sessionsRoot), [KEY_A, KEY_B, KEY_C].map((key) => `${key}/${sid(1)}.json`))
  assert.deepEqual(listAll(paths.stagingDir), [])
})

test('an existing archived hint is rewritten on disk', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { isArchived: true })
  writeHint(paths, KEY_B, [])
  pass(paths)
  assert.deepEqual(readHint(paths, KEY_B), { v: 1, archived: [sid(1)] })
  assert.equal(fs.existsSync(path.join(folderDir(paths, KEY_A), 'archived-sessions.idx')), false)
})

test('an unfamiliar layout stops the pass before anything is written', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  for (const n of [2, 3, 4]) fs.writeFileSync(path.join(folderDir(paths, KEY_A), `${sid(n)}.json`), 'garbage')
  makeFolder(paths, KEY_B)
  const result = pass(paths)
  assert.equal(result.abort, 'layout')
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
  assert.deepEqual(listBackups(paths), [])
})

test('a failure on one folder does not stop the others, and is retried next pass', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  const lockedDir = makeFolder(paths, KEY_B)
  makeFolder(paths, KEY_C)
  fs.chmodSync(lockedDir, 0o500)
  let result
  try {
    result = pass(paths)
  } finally {
    fs.chmodSync(lockedDir, 0o700)
  }
  assert.equal(result.results.errors.length, 1)
  assert.equal(result.results.errors[0].action.folder, KEY_B)
  assert.equal(hasRecord(paths, KEY_C, sid(1)), true)
  pass(paths)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
})

test('an overwrite is skipped when the target changed after the scan', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { lastActivityAt: 200, title: 'winner' })
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 100, title: 'old' }, 1000)
  const scanned = scan(paths.sessionsRoot)
  writeRecord(paths, KEY_B, sid(1), { lastActivityAt: 300, title: 'app wrote this meanwhile' }, 2000)
  const results = applyActions({
    actions: [{ type: 'overwrite', folder: KEY_B, id: sid(1), from: KEY_A }],
    scanned, paths, stamp: 'test'
  })
  assert.deepEqual(results.done, [])
  assert.equal(results.skipped[0].reason, 'changed-since-scan')
  assert.equal(readRecord(paths, KEY_B, sid(1)).title, 'app wrote this meanwhile')
})

test('a create is skipped when the target appeared after the scan', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { title: 'winner' })
  makeFolder(paths, KEY_B)
  const scanned = scan(paths.sessionsRoot)
  writeRecord(paths, KEY_B, sid(1), { title: 'app created this meanwhile' })
  const results = applyActions({
    actions: [{ type: 'create', folder: KEY_B, id: sid(1), from: KEY_A }],
    scanned, paths, stamp: 'test'
  })
  assert.equal(results.skipped[0].reason, 'appeared-since-scan')
  assert.equal(readRecord(paths, KEY_B, sid(1)).title, 'app created this meanwhile')
})

test('a pass does nothing while another live process holds the lock', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  const release = acquireLock(paths)
  const result = pass(paths)
  assert.equal(result.locked, true)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), false)
  release()
  assert.equal(pass(paths).locked, false)
})

test('a lock left by a dead process is replaced', (t) => {
  const { paths } = makeEnv(t)
  fs.mkdirSync(paths.stateDir, { recursive: true })
  fs.writeFileSync(paths.lockFile, '999999999')
  const release = acquireLock(paths)
  assert.equal(typeof release, 'function')
  release()
  assert.equal(fs.existsSync(paths.lockFile), false)
})

test('a corrupt state file is set aside and the pass behaves like a first pass', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  makeFolder(paths, KEY_B)
  fs.mkdirSync(paths.stateDir, { recursive: true })
  fs.writeFileSync(paths.stateFile, '{broken')
  pass(paths)
  assert.equal(hasRecord(paths, KEY_B, sid(1)), true)
  assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.startsWith('state.json.corrupt-')), true)
  assert.deepEqual(loadState(paths).known[KEY_B], [sid(1)])
})

test('restore puts a backup back and clears remembered state', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { title: 'original' })
  makeFolder(paths, KEY_B)
  const before = listAll(paths.sessionsRoot)
  const name = takeBackup(paths, 'snapshot')
  pass(paths)
  writeRecord(paths, KEY_A, sid(1), { title: 'changed' })
  restoreBackup(paths, name, 'restore-stamp')
  assert.deepEqual(listAll(paths.sessionsRoot), before)
  assert.equal(readRecord(paths, KEY_A, sid(1)).title, 'original')
  assert.equal(fs.existsSync(paths.stateFile), false)
  assert.ok(listAll(paths.trashDir).some((f) => f.includes('restore-stamp') && f.endsWith(`${KEY_B}/${sid(1)}.json`)))
})
