import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scan } from '../src/scan.js'
import { makeEnv, makeFolder, writeRecord, writeHint, folderDir, sid, KEY_A, KEY_B, ACCT_A } from './helpers.js'

test('finds each account/organization folder and its valid records', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1), { lastActivityAt: 5, isArchived: true }, 2_000_000)
  writeRecord(paths, KEY_B, sid(2))
  const result = scan(paths.sessionsRoot)
  assert.deepEqual(result.folders.map((f) => f.key), [KEY_A, KEY_B])
  const rec = result.folders[0].records.get(sid(1))
  assert.equal(rec.lastActivityAt, 5)
  assert.equal(rec.isArchived, true)
  assert.equal(rec.mtimeMs, 2_000_000)
  assert.equal(JSON.parse(rec.bytes.toString()).sessionId, sid(1))
  assert.equal(result.fileCount, 2)
  assert.equal(result.validCount, 2)
})

test('a missing sessions root scans as empty', (t) => {
  const { paths } = makeEnv(t)
  const result = scan(path.join(paths.sessionsRoot, 'nope'))
  assert.deepEqual(result.folders, [])
  assert.equal(result.fileCount, 0)
})

test('ignores directories that are not UUID-named and files that are not records', (t) => {
  const { paths } = makeEnv(t)
  const dir = makeFolder(paths, KEY_A)
  fs.mkdirSync(path.join(paths.sessionsRoot, 'imported-staging'))
  fs.mkdirSync(path.join(paths.sessionsRoot, ACCT_A, 'not-a-uuid'))
  fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), '{}')
  fs.writeFileSync(path.join(dir, 'local_short.json'), '{}')
  const result = scan(paths.sessionsRoot)
  assert.deepEqual(result.folders.map((f) => f.key), [KEY_A])
  assert.equal(result.folders[0].records.size, 0)
  assert.equal(result.fileCount, 0)
})

test('ignores a symlinked folder', (t) => {
  const { paths, root } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  const [acctB, orgB] = KEY_B.split('/')
  fs.mkdirSync(path.join(paths.sessionsRoot, acctB))
  fs.symlinkSync(folderDir(paths, KEY_A), path.join(paths.sessionsRoot, acctB, orgB))
  assert.ok(root)
  assert.deepEqual(scan(paths.sessionsRoot).folders.map((f) => f.key), [KEY_A])
})

test('marks unusable record files invalid with a reason', (t) => {
  const { paths } = makeEnv(t)
  const dir = makeFolder(paths, KEY_A)
  const good = writeRecord(paths, KEY_A, sid(1))
  fs.writeFileSync(path.join(dir, `${sid(2)}.json`), '{not json')
  fs.writeFileSync(path.join(dir, `${sid(3)}.json`), JSON.stringify({ sessionId: sid(9) }))
  fs.writeFileSync(path.join(dir, `${sid(4)}.json`), '[]')
  fs.symlinkSync(good, path.join(dir, `${sid(5)}.json`))
  const linked = writeRecord(paths, KEY_A, sid(6))
  fs.linkSync(linked, path.join(paths.sessionsRoot, 'extra-link'))
  fs.writeFileSync(path.join(dir, `${sid(7)}.json`), JSON.stringify({ sessionId: sid(7), pad: 'x'.repeat(500) }))
  const folder = scan(paths.sessionsRoot, { maxBytes: 300 }).folders[0]
  assert.deepEqual([...folder.records.keys()], [sid(1)])
  assert.deepEqual(Object.fromEntries(folder.invalid), {
    [sid(2)]: 'bad-json',
    [sid(3)]: 'id-mismatch',
    [sid(4)]: 'not-object',
    [sid(5)]: 'not-regular',
    [sid(6)]: 'hardlink',
    [sid(7)]: 'oversized'
  })
})

test('counts record files and valid records across folders', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  fs.writeFileSync(path.join(folderDir(paths, KEY_A), `${sid(2)}.json`), 'nope')
  const result = scan(paths.sessionsRoot)
  assert.equal(result.fileCount, 2)
  assert.equal(result.validCount, 1)
})

test('reads the archived hint when it has the known shape', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  writeHint(paths, KEY_A, [sid(1)])
  makeFolder(paths, KEY_B)
  fs.writeFileSync(path.join(folderDir(paths, KEY_B), 'archived-sessions.idx'), JSON.stringify({ v: 2, things: [] }))
  const [a, b] = scan(paths.sessionsRoot).folders
  assert.deepEqual(a.hint, { exists: true, known: true, ids: [sid(1)] })
  assert.deepEqual(b.hint, { exists: true, known: false, ids: [] })
})

test('reports no hint when the file is absent', (t) => {
  const { paths } = makeEnv(t)
  writeRecord(paths, KEY_A, sid(1))
  assert.deepEqual(scan(paths.sessionsRoot).folders[0].hint, { exists: false, known: false, ids: [] })
})
