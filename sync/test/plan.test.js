import test from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../src/plan.js'
import { recordJson, sid, KEY_A, KEY_B, KEY_C } from './helpers.js'

const rec = (id, fields = {}, mtimeMs = 1000) => ({
  id,
  bytes: Buffer.from(recordJson(id, fields)),
  mtimeMs,
  lastActivityAt: fields.lastActivityAt ?? 1000,
  isArchived: fields.isArchived === true
})
const noHint = { exists: false, known: false, ids: [] }
const folder = (key, recs = [], extra = {}) => ({
  key,
  records: new Map(recs.map((r) => [r.id, r])),
  invalid: new Map(),
  hint: noHint,
  ...extra
})
const state = (extra = {}) => ({ known: {}, tombstones: {}, held: {}, ...extra })
const run = (folders, extra = {}) => plan({ folders, state: state(), protectedKeys: new Set(), now: 5000, ...extra })

test('a session missing from a folder is created there from the winner', () => {
  const result = run([folder(KEY_A, [rec(sid(1))]), folder(KEY_B)])
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_B, id: sid(1), from: KEY_A }])
  assert.deepEqual(result.deferred, [])
})

test('a missing session is created even in a protected folder', () => {
  const result = run([folder(KEY_A, [rec(sid(1))]), folder(KEY_B)], { protectedKeys: new Set([KEY_B]) })
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_B, id: sid(1), from: KEY_A }])
})

test('the copy with the most recent activity wins over a newer file', () => {
  const result = run([
    folder(KEY_A, [rec(sid(1), { lastActivityAt: 200 }, 1000)]),
    folder(KEY_B, [rec(sid(1), { lastActivityAt: 100 }, 9000)])
  ])
  assert.deepEqual(result.actions, [{ type: 'overwrite', folder: KEY_B, id: sid(1), from: KEY_A }])
})

test('equal activity is decided by the newest file', () => {
  const result = run([
    folder(KEY_A, [rec(sid(1), { title: 'old' }, 1000)]),
    folder(KEY_B, [rec(sid(1), { title: 'new' }, 2000)])
  ])
  assert.deepEqual(result.actions, [{ type: 'overwrite', folder: KEY_A, id: sid(1), from: KEY_B }])
})

test('identical copies need nothing, whatever their file times', () => {
  const result = run([folder(KEY_A, [rec(sid(1), {}, 1000)]), folder(KEY_B, [rec(sid(1), {}, 2000)])])
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.deferred, [])
})

test('an overwrite in a protected folder is deferred', () => {
  const result = run(
    [folder(KEY_A, [rec(sid(1), { lastActivityAt: 200 })]), folder(KEY_B, [rec(sid(1), { lastActivityAt: 100 })])],
    { protectedKeys: new Set([KEY_B]) }
  )
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.deferred, [{ type: 'overwrite', folder: KEY_B, id: sid(1), from: KEY_A }])
})

test('the first pass treats nothing as deleted', () => {
  const result = run([folder(KEY_A, [rec(sid(1))]), folder(KEY_B)])
  assert.deepEqual(result.tombstones, {})
  assert.deepEqual(result.held, {})
})

test('a session that vanished from a folder is tombstoned and trashed elsewhere', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1))])], {
    state: state({ known: { [KEY_A]: [sid(1)], [KEY_B]: [sid(1)] } })
  })
  assert.deepEqual(result.tombstones, { [sid(1)]: 5000 })
  assert.deepEqual(result.actions, [{ type: 'trash', folder: KEY_B, id: sid(1) }])
})

test('trashing from a protected folder is deferred', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1))])], {
    state: state({ known: { [KEY_A]: [sid(1)], [KEY_B]: [sid(1)] } }),
    protectedKeys: new Set([KEY_B])
  })
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.deferred, [{ type: 'trash', folder: KEY_B, id: sid(1) }])
})

test('a tombstoned session is not recreated from an older leftover copy', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1), {}, 1000)])], {
    state: state({ tombstones: { [sid(1)]: 4000 } })
  })
  assert.deepEqual(result.actions, [{ type: 'trash', folder: KEY_B, id: sid(1) }])
  assert.deepEqual(result.tombstones, { [sid(1)]: 4000 })
})

test('a copy newer than its tombstone lifts the tombstone and syncs again', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1), {}, 4500)])], {
    state: state({ tombstones: { [sid(1)]: 4000 } })
  })
  assert.deepEqual(result.tombstones, {})
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_A, id: sid(1), from: KEY_B }])
})

test('more than five sessions vanishing at once are held, not deleted', () => {
  const ids = [1, 2, 3, 4, 5, 6].map(sid)
  const result = run([folder(KEY_A), folder(KEY_B, ids.map((id) => rec(id)))], {
    state: state({ known: { [KEY_A]: ids, [KEY_B]: ids } })
  })
  assert.deepEqual(result.tombstones, {})
  assert.deepEqual(result.held, { [KEY_A]: ids })
  assert.deepEqual(result.actions, [])
})

test('exactly five sessions vanishing are treated as real deletions', () => {
  const ids = [1, 2, 3, 4, 5].map(sid)
  const result = run([folder(KEY_A), folder(KEY_B, ids.map((id) => rec(id)))], {
    state: state({ known: { [KEY_A]: ids, [KEY_B]: ids } })
  })
  assert.deepEqual(Object.keys(result.tombstones).sort(), ids)
  assert.equal(result.actions.filter((a) => a.type === 'trash').length, 5)
})

test('a known folder that disappeared holds its sessions', () => {
  const result = run([folder(KEY_B, [rec(sid(1))])], {
    state: state({ known: { [KEY_A]: [sid(1)], [KEY_B]: [sid(1)] } })
  })
  assert.deepEqual(result.held, { [KEY_A]: [sid(1)] })
  assert.deepEqual(result.tombstones, {})
  assert.deepEqual(result.actions, [])
})

test('held sessions still sync between the other folders', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1))]), folder(KEY_C)], {
    state: state({ held: { [KEY_A]: [sid(1)] } })
  })
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_C, id: sid(1), from: KEY_B }])
  assert.deepEqual(result.held, { [KEY_A]: [sid(1)] })
})

test('resolving held sessions as deletes tombstones and trashes them', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1))])], {
    state: state({ held: { [KEY_A]: [sid(1)] } }),
    heldResolution: 'delete'
  })
  assert.deepEqual(result.held, {})
  assert.deepEqual(result.tombstones, { [sid(1)]: 5000 })
  assert.deepEqual(result.actions, [{ type: 'trash', folder: KEY_B, id: sid(1) }])
})

test('resolving held sessions as restore recreates them', () => {
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1))])], {
    state: state({ held: { [KEY_A]: [sid(1)] } }),
    heldResolution: 'restore'
  })
  assert.deepEqual(result.held, {})
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_A, id: sid(1), from: KEY_B }])
})

test('a folder holding an invalid copy is left alone for that session', () => {
  const result = run([
    folder(KEY_A, [rec(sid(1))]),
    folder(KEY_B, [], { invalid: new Map([[sid(1), 'bad-json']]) }),
    folder(KEY_C)
  ])
  assert.deepEqual(result.actions, [{ type: 'create', folder: KEY_C, id: sid(1), from: KEY_A }])
})

test('an invalid copy still counts as present, so it is not mistaken for a deletion', () => {
  const result = run([folder(KEY_A, [], { invalid: new Map([[sid(1), 'bad-json']]) }), folder(KEY_B, [rec(sid(1))])], {
    state: state({ known: { [KEY_A]: [sid(1)], [KEY_B]: [sid(1)] } })
  })
  assert.deepEqual(result.tombstones, {})
  assert.deepEqual(result.actions, [])
})

test('the pass aborts when fewer than half the record files are valid', () => {
  const result = run([
    folder(KEY_A, [rec(sid(1))], { invalid: new Map([[sid(2), 'bad-json'], [sid(3), 'bad-json']]) }),
    folder(KEY_B)
  ])
  assert.equal(result.abort, 'layout')
  assert.deepEqual(result.actions, [])
})

test('an existing hint is rewritten to match the records after the pass', () => {
  const hint = { exists: true, known: true, ids: [] }
  const result = run([folder(KEY_A, [rec(sid(2), { isArchived: true }), rec(sid(1), { isArchived: true })]), folder(KEY_B, [], { hint })])
  assert.deepEqual(result.actions.filter((a) => a.type === 'hint'), [{ type: 'hint', folder: KEY_B, ids: [sid(1), sid(2)] }])
})

test('a hint is not created where none exists, nor touched when its shape is unknown', () => {
  const unknown = { exists: true, known: false, ids: [] }
  const result = run([folder(KEY_A, [rec(sid(1), { isArchived: true })]), folder(KEY_B), folder(KEY_C, [], { hint: unknown })])
  assert.deepEqual(result.actions.filter((a) => a.type === 'hint'), [])
})

test('a hint in a protected folder is left to the app', () => {
  const hint = { exists: true, known: true, ids: [] }
  const result = run([folder(KEY_A, [rec(sid(1), { isArchived: true })]), folder(KEY_B, [], { hint })], {
    protectedKeys: new Set([KEY_B])
  })
  assert.deepEqual(result.actions.filter((a) => a.type === 'hint'), [])
})

test('a hint is left alone when no record in its folder changes', () => {
  const stale = { exists: true, known: true, ids: [sid(9)] }
  const result = run([folder(KEY_A, [rec(sid(1))], { hint: stale }), folder(KEY_B, [rec(sid(1))])])
  assert.deepEqual(result.actions, [])
})

test('a hint drops a session that is being trashed', () => {
  const hint = { exists: true, known: true, ids: [sid(1)] }
  const result = run([folder(KEY_A), folder(KEY_B, [rec(sid(1), { isArchived: true })], { hint })], {
    state: state({ known: { [KEY_A]: [sid(1)], [KEY_B]: [sid(1)] } })
  })
  assert.deepEqual(result.actions, [
    { type: 'trash', folder: KEY_B, id: sid(1) },
    { type: 'hint', folder: KEY_B, ids: [] }
  ])
})
