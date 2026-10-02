// More than this many sessions vanishing from one folder in one pass looks like a reset, not a user deleting.
export const BULK_LIMIT = 5

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])

// Pure decision step: given what is on disk and what we remembered, say what to change.
export function plan({ folders, state, protectedKeys, now, heldResolution = null }) {
  const actions = []
  const deferred = []
  const notes = []
  let tombstones = { ...(state.tombstones ?? {}) }
  let held = Object.fromEntries(Object.entries(state.held ?? {}).map(([key, ids]) => [key, [...ids]]))

  const files = folders.reduce((n, f) => n + f.records.size + f.invalid.size, 0)
  const valid = folders.reduce((n, f) => n + f.records.size, 0)
  if (files > 0 && valid * 2 < files) {
    return { abort: 'layout', actions, deferred, tombstones, held, notes: [`only ${valid} of ${files} record files are readable`] }
  }

  const byKey = new Map(folders.map((f) => [f.key, f]))

  for (const [key, knownIds] of Object.entries(state.known ?? {})) {
    const folder = byKey.get(key)
    const already = new Set(held[key] ?? [])
    const vanished = knownIds.filter(
      (id) => !(folder && (folder.records.has(id) || folder.invalid.has(id))) && !(id in tombstones) && !already.has(id)
    )
    if (vanished.length === 0) continue
    if (!folder || vanished.length > BULK_LIMIT) {
      held[key] = [...already, ...vanished].sort()
      notes.push(`${vanished.length} sessions vanished from ${key} at once; held for review`)
    } else {
      for (const id of vanished) tombstones[id] = now
    }
  }

  if (heldResolution === 'delete') {
    for (const ids of Object.values(held)) for (const id of ids) tombstones[id] ??= now
    held = {}
  } else if (heldResolution === 'restore') {
    held = {}
  }

  for (const [id, deletedAt] of Object.entries(tombstones)) {
    if (folders.some((f) => (f.records.get(id)?.mtimeMs ?? 0) > deletedAt)) delete tombstones[id]
  }

  for (const key of Object.keys(held)) {
    held[key] = held[key].filter((id) => !(id in tombstones))
    if (held[key].length === 0) delete held[key]
  }

  const ids = [...new Set(folders.flatMap((f) => [...f.records.keys()]))].sort()
  for (const id of ids) {
    if (id in tombstones) {
      for (const f of folders) {
        if (!f.records.has(id)) continue
        ;(protectedKeys.has(f.key) ? deferred : actions).push({ type: 'trash', folder: f.key, id })
      }
      continue
    }
    let winner = null
    for (const f of folders) {
      const copy = f.records.get(id)
      if (!copy) continue
      const better =
        !winner ||
        copy.lastActivityAt > winner.copy.lastActivityAt ||
        (copy.lastActivityAt === winner.copy.lastActivityAt && copy.mtimeMs > winner.copy.mtimeMs)
      if (better) winner = { key: f.key, copy }
    }
    for (const f of folders) {
      if (f.key === winner.key) continue
      if (f.invalid.has(id)) {
        notes.push(`${f.key} has an unreadable copy of ${id} (${f.invalid.get(id)}); left alone`)
        continue
      }
      if (held[f.key]?.includes(id)) continue
      const mine = f.records.get(id)
      if (!mine) {
        actions.push({ type: 'create', folder: f.key, id, from: winner.key })
      } else if (!mine.bytes.equals(winner.copy.bytes)) {
        ;(protectedKeys.has(f.key) ? deferred : actions).push({ type: 'overwrite', folder: f.key, id, from: winner.key })
      }
    }
  }

  for (const f of folders) {
    if (protectedKeys.has(f.key) || !f.hint.exists || !f.hint.known) continue
    const mine = actions.filter((a) => a.folder === f.key)
    if (mine.length === 0) continue
    const archived = new Map([...f.records].map(([id, rec]) => [id, rec.isArchived]))
    for (const action of mine) {
      if (action.type === 'trash') archived.delete(action.id)
      else archived.set(action.id, byKey.get(action.from).records.get(action.id).isArchived)
    }
    const desired = [...archived].filter(([, isArchived]) => isArchived).map(([id]) => id).sort()
    if (!sameList(desired, f.hint.ids)) actions.push({ type: 'hint', folder: f.key, ids: desired })
  }

  return { abort: null, actions, deferred, tombstones, held, notes }
}
