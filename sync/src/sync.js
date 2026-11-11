import { scan } from './scan.js'
import { plan } from './plan.js'
import { applyActions, takeBackup, stage } from './apply.js'
import { loadState, saveState, acquireLock } from './state.js'
import { isClaudeRunning, readActivePair, protectedKeys } from './active.js'
import { readPresets, planPresets, applyPresets, backupPresets } from './presets.js'

export const stampOf = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-')

const noResults = () => ({ done: [], skipped: [], errors: [] })

// The archive flag each folder holds after this pass: what the scan saw, adjusted by our own writes.
function archivedAfter(scanned, done) {
  const byKey = new Map(scanned.folders.map((f) => [f.key, f]))
  const folders = {}
  for (const f of scanned.folders) {
    const ids = new Set([...f.records].filter(([, record]) => record.isArchived).map(([id]) => id))
    for (const action of done) {
      if (action.folder !== f.key || action.type === 'hint') continue
      const isArchived = action.type !== 'trash' && (action.archived ?? byKey.get(action.from).records.get(action.id).isArchived)
      if (isArchived) ids.add(action.id)
      else ids.delete(action.id)
    }
    folders[f.key] = [...ids].sort()
  }
  return folders
}

// SSH environments, mirrored between accounts. Returns what to remember.
function syncEnvironments({ paths, state, at, dryRun, summary }) {
  if (!paths.presetsFile) return state.presets ?? null
  const read = readPresets(paths.presetsFile)
  const planned = planPresets({ read, memory: state.presets, now: at })
  summary.environments = { changes: planned.changes, notes: planned.notes, written: false, skipped: null, error: null, backup: null }
  if (dryRun || planned.changes.length === 0) return planned.next
  const stamp = stampOf(at)
  try {
    let backup = planned.next.backup
    if (!backup) {
      backup = backupPresets({ file: paths.presetsFile, backupsDir: paths.backupsDir, stamp })
      summary.environments.backup = backup
    }
    const skipped = applyPresets({ file: paths.presetsFile, read, catalogs: planned.catalogs, stage: (text) => stage(paths, text) })
    if (skipped) {
      summary.environments.skipped = skipped
      return { ...planned.unchanged, backup }
    }
    summary.environments.written = true
    return { ...planned.next, backup }
  } catch (error) {
    summary.environments.error = error.code ?? error.message
    return planned.unchanged
  }
}

// One full pass: look at every account folder, decide, and (unless dry) make them agree.
export function runPass({ paths, dryRun = false, heldResolution = null, running = isClaudeRunning, now = Date.now }) {
  const summary = {
    locked: false, abort: null, actions: [], deferred: [], held: {}, notes: [],
    results: noResults(), backup: null, protected: [], running: false, folders: 0, sessions: 0,
    scanned: { folders: [] },
    environments: { changes: [], notes: [], written: false, skipped: null, error: null, backup: null }
  }
  const release = dryRun ? null : acquireLock(paths)
  if (!dryRun && !release) return { ...summary, locked: true }
  try {
    const at = now()
    const scanned = scan(paths.sessionsRoot)
    const state = loadState(paths, { readOnly: dryRun })
    const isRunning = running()
    const guarded = protectedKeys({
      running: isRunning,
      pair: isRunning ? readActivePair(paths.mainLog) : null,
      folderKeys: scanned.folders.map((f) => f.key)
    })
    const planned = plan({ folders: scanned.folders, state, protectedKeys: guarded, now: at, heldResolution })
    Object.assign(summary, {
      abort: planned.abort, actions: planned.actions, deferred: planned.deferred, held: planned.held, notes: planned.notes,
      protected: [...guarded], running: isRunning, scanned, folders: scanned.folders.length,
      sessions: new Set(scanned.folders.flatMap((f) => [...f.records.keys()])).size
    })
    if (planned.abort) return summary
    const presets = syncEnvironments({ paths, state, at, dryRun, summary })
    if (dryRun) return summary

    const stamp = stampOf(at)
    let firstBackup = state.firstBackup
    if (planned.actions.length > 0 && !firstBackup) {
      firstBackup = takeBackup(paths, stamp)
      summary.backup = firstBackup
    }
    if (planned.actions.length > 0) summary.results = applyActions({ actions: planned.actions, scanned, paths, stamp })

    // What each folder held at scan time, adjusted by what we ourselves did. Anything the
    // app removes after the scan is then still "known" and is seen as a deletion next pass.
    const known = {}
    for (const f of scanned.folders) {
      const ids = new Set([...f.records.keys(), ...f.invalid.keys()])
      for (const action of summary.results.done) {
        if (action.folder !== f.key) continue
        if (action.type === 'create') ids.add(action.id)
        if (action.type === 'trash') ids.delete(action.id)
      }
      known[f.key] = [...ids].sort()
    }
    const archive = { consensus: planned.archived, folders: archivedAfter(scanned, summary.results.done) }
    const next = { version: 1, known, tombstones: planned.tombstones, held: planned.held, firstBackup, archive, presets }
    const prior = {
      version: 1, known: state.known, tombstones: state.tombstones, held: state.held, firstBackup: state.firstBackup,
      archive: state.archive, presets: state.presets
    }
    const changed = summary.results.done.length > 0 || summary.environments.written
    if (changed || JSON.stringify(next) !== JSON.stringify(prior)) {
      saveState(paths, { ...next, lastChange: changed ? at : state.lastChange })
    }
    return summary
  } finally {
    release?.()
  }
}
