import { withArchived } from './json.js'

// More than this many sessions vanishing from one folder in one pass looks like a reset, not a user deleting.
export const BULK_LIMIT = 5

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])

// Archiving changes neither lastActivityAt nor anything else the winner is chosen by, and Claude
// rewrites the open account's records from memory with new file times, so the newest copy is
// often one that has not seen an archive yet. The archive flag is therefore decided on its own:
// each folder's flag is compared with what that folder held after the last pass, and a folder
// whose flag changed is where the user archived or unarchived, so that value goes everywhere.
function archiveMemory(state) {
  if (!state.archive) return null
  const sets = (object) => new Map(Object.entries(object ?? {}).map(([key, ids]) => [key, new Set(ids)]))
  const known = sets(state.known)
  return {
    consensus: new Set(state.archive.consensus ?? []),
    folders: sets(state.archive.folders),
    known,
    seen: new Set([...known.values()].flatMap((ids) => [...ids]))
  }
}

function decideArchived(id, copies, memory) {
  if (memory) {
    const changed = copies.filter(({ key, copy }) => {
      const before = memory.folders.get(key)
      return before !== undefined && memory.known.get(key)?.has(id) && before.has(id) !== copy.isArchived
    })
    // Two folders changed in opposite directions since the last pass: the later file is the later change.
    if (changed.length > 0) return changed.reduce((a, b) => (b.copy.mtimeMs > a.copy.mtimeMs ? b : a)).copy.isArchived
    if (memory.seen.has(id)) return memory.consensus.has(id)
  }
  // A session seen for the first time: an archive in any folder is taken as the latest word.
  return copies.some(({ copy }) => copy.isArchived)
}

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

  const memory = archiveMemory(state)
  const archived = []
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
    const copies = folders.filter((f) => f.records.has(id)).map((f) => ({ key: f.key, copy: f.records.get(id) }))
    const isArchived = decideArchived(id, copies, memory)
    if (isArchived) archived.push(id)
    // The winner's content, with the archive flag decided above.
    const patch = winner.copy.isArchived === isArchived ? {} : { archived: isArchived }
    const desired = 'archived' in patch ? withArchived(winner.copy.bytes, isArchived) : winner.copy.bytes
    for (const f of folders) {
      const mine = f.records.get(id)
      if (f.key === winner.key) {
        if (!mine.bytes.equals(desired)) {
          ;(protectedKeys.has(f.key) ? deferred : actions).push({ type: 'overwrite', folder: f.key, id, from: winner.key, ...patch })
        }
        continue
      }
      if (f.invalid.has(id)) {
        notes.push(`${f.key} has an unreadable copy of ${id} (${f.invalid.get(id)}); left alone`)
        continue
      }
      if (held[f.key]?.includes(id)) continue
      if (!mine) {
        actions.push({ type: 'create', folder: f.key, id, from: winner.key, ...patch })
      } else if (!mine.bytes.equals(desired)) {
        ;(protectedKeys.has(f.key) ? deferred : actions).push({ type: 'overwrite', folder: f.key, id, from: winner.key, ...patch })
      }
    }
  }

  for (const f of folders) {
    if (protectedKeys.has(f.key) || !f.hint.exists || !f.hint.known) continue
    const mine = actions.filter((a) => a.folder === f.key)
    if (mine.length === 0) continue
    const flags = new Map([...f.records].map(([id, rec]) => [id, rec.isArchived]))
    for (const action of mine) {
      if (action.type === 'trash') flags.delete(action.id)
      else flags.set(action.id, action.archived ?? byKey.get(action.from).records.get(action.id).isArchived)
    }
    const desired = [...flags].filter(([, isArchived]) => isArchived).map(([id]) => id).sort()
    if (!sameList(desired, f.hint.ids)) actions.push({ type: 'hint', folder: f.key, ids: desired })
  }

  return { abort: null, actions, deferred, tombstones, held, notes, archived }
}
