import fs from 'node:fs'
import path from 'node:path'
import { stringifyLike } from './json.js'

// Claude Desktop keeps each account's environments (session presets) in one file, keyed by
// account id. An SSH environment names a machine from Claude's SSH connections, which are shared
// by every account, and a folder on it, so it works the same from any account. Those are mirrored
// into every account's list, the way session records are; local and cloud environments stay put.
const SHARED_KINDS = new Set(['ssh'])
// Claude refuses to save a list with more environments than this.
export const MAX_PRESETS = 200

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCatalog = (value) => isObject(value) && Array.isArray(value.presets) && value.presets.every(isObject)
export const isShared = (preset) => typeof preset.id === 'string' && preset.id !== '' && SHARED_KINDS.has(preset.target?.kind)
const usedAt = (preset) => Math.max(Number(preset.lastUsedAt) || 0, Number(preset.createdAt) || 0)
const nameOf = (preset) => (typeof preset.name === 'string' && preset.name ? preset.name : preset.id)

export const emptyPresetState = () => ({ known: {}, tombstones: {}, last: {}, backup: null })

export function readPresets(file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  if (!stat.isFile() || stat.nlink > 1) return { state: 'unfamiliar' }
  const text = fs.readFileSync(file, 'utf8')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { state: 'unfamiliar' }
  }
  if (!isObject(data) || (data.byAccount !== undefined && !isObject(data.byAccount))) return { state: 'unfamiliar' }
  return { state: 'ok', text, data, mtimeMs: stat.mtimeMs, size: stat.size }
}

// Pure decision step, like plan(): which accounts' lists change, and what to remember.
export function planPresets({ read, memory, now }) {
  const prior = { ...emptyPresetState(), ...(memory ?? {}) }
  if (read.state !== 'ok') {
    const notes = read.state === 'unfamiliar' ? ['the environments file is not in a familiar shape; left alone'] : []
    return { changes: [], catalogs: {}, next: prior, unchanged: prior, notes }
  }
  const byAccount = read.data.byAccount ?? {}
  const accounts = Object.keys(byAccount).filter((account) => isCatalog(byAccount[account])).sort()
  const have = new Map(accounts.map((a) => [a, new Map(byAccount[a].presets.filter(isShared).map((p) => [p.id, p]))]))
  const tombstones = { ...prior.tombstones }
  const notes = []

  // An environment that was in an account's list last pass and is gone now was deleted there.
  for (const account of accounts) {
    for (const id of prior.known[account] ?? []) {
      if (!have.get(account).has(id) && !(id in tombstones)) tombstones[id] = now
    }
  }

  // For each environment, a copy edited since the last pass wins; otherwise the most recently used.
  const desired = new Map()
  for (const id of [...new Set(accounts.flatMap((a) => [...have.get(a).keys()]))].sort()) {
    if (id in tombstones) continue
    const copies = accounts.filter((a) => have.get(a).has(id)).map((a) => have.get(a).get(id))
    const edited = copies.filter((p) => id in prior.last && JSON.stringify(p) !== prior.last[id])
    const pool = edited.length > 0 ? edited : copies
    desired.set(id, pool.reduce((best, p) => (usedAt(p) > usedAt(best) ? p : best)))
  }

  const changes = []
  const catalogs = {}
  const known = {}
  const current = {}
  for (const account of accounts) {
    const catalog = byAccount[account]
    current[account] = [...have.get(account).keys()].sort()
    const change = { account, added: [], updated: [], removed: [] }
    const presets = []
    for (const preset of catalog.presets) {
      if (!isShared(preset)) presets.push(preset)
      else if (preset.id in tombstones) change.removed.push(nameOf(preset))
      else {
        const want = desired.get(preset.id)
        if (JSON.stringify(want) !== JSON.stringify(preset)) change.updated.push(nameOf(want))
        presets.push(want)
      }
    }
    for (const [id, want] of desired) {
      if (have.get(account).has(id)) continue
      if (presets.length >= MAX_PRESETS) {
        notes.push(`${account} already has ${MAX_PRESETS} environments; ${nameOf(want)} not added`)
        continue
      }
      presets.push(want)
      change.added.push(nameOf(want))
    }
    known[account] = presets.filter(isShared).map((p) => p.id).sort()
    if (change.added.length + change.updated.length + change.removed.length > 0) {
      changes.push(change)
      catalogs[account] = { ...catalog, presets }
    }
  }

  const last = Object.fromEntries([...desired].map(([id, preset]) => [id, JSON.stringify(preset)]))
  return {
    changes,
    catalogs,
    notes,
    // What to remember once the changes are written, and what to remember if they are not.
    next: { known, tombstones, last, backup: prior.backup },
    unchanged: { known: current, tombstones, last: prior.last, backup: prior.backup }
  }
}

// Writes the planned lists back in one rename, unless Claude changed the file since it was read.
export function applyPresets({ file, read, catalogs, stage }) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat || stat.mtimeMs !== read.mtimeMs || stat.size !== read.size) return 'changed-since-scan'
  const data = { ...read.data, byAccount: { ...read.data.byAccount, ...catalogs } }
  fs.renameSync(stage(stringifyLike(read.text, data)), file)
  return null
}

export function backupPresets({ file, backupsDir, stamp }) {
  const name = `ccd-session-presets-${stamp}.json`
  fs.mkdirSync(backupsDir, { recursive: true })
  fs.copyFileSync(file, path.join(backupsDir, name), fs.constants.COPYFILE_EXCL)
  return name
}
