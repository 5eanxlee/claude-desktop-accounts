import fs from 'node:fs'
import path from 'node:path'
import { HINT_FILE } from './scan.js'

let counter = 0

// Content is prepared in our own staging folder and renamed into place, so Claude's
// folders only ever see a complete, ordinary file and never a temporary one.
function stage(paths, bytes, mtimeMs) {
  fs.mkdirSync(paths.stagingDir, { recursive: true })
  const tmp = path.join(paths.stagingDir, `${process.pid}-${counter++}.tmp`)
  fs.writeFileSync(tmp, bytes, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  if (mtimeMs !== undefined) fs.utimesSync(tmp, new Date(mtimeMs), new Date(mtimeMs))
  return tmp
}

const statOrNull = (file) => {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A target that no longer matches what the scan saw was touched by the app in the meantime.
function unchangedSinceScan(target, scannedRecord) {
  const stat = statOrNull(target)
  if (!stat) return 'vanished-since-scan'
  if (stat.mtimeMs !== scannedRecord.mtimeMs || stat.size !== scannedRecord.size) return 'changed-since-scan'
  return null
}

function applyOne(action, byKey, paths, stamp) {
  const folder = byKey.get(action.folder)
  if (action.type === 'hint') {
    const target = path.join(folder.dir, HINT_FILE)
    if (!statOrNull(target)) return 'vanished-since-scan'
    fs.renameSync(stage(paths, JSON.stringify({ v: 1, archived: action.ids })), target)
    return null
  }
  const target = path.join(folder.dir, `${action.id}.json`)
  if (action.type === 'trash') {
    const changed = unchangedSinceScan(target, folder.records.get(action.id))
    if (changed) return changed
    const dest = path.join(paths.trashDir, stamp, action.folder, `${action.id}.json`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(target, dest)
    return null
  }
  const winner = byKey.get(action.from).records.get(action.id)
  if (action.type === 'create') {
    if (statOrNull(target)) return 'appeared-since-scan'
  } else {
    const changed = unchangedSinceScan(target, folder.records.get(action.id))
    if (changed) return changed
  }
  const tmp = stage(paths, winner.bytes, winner.mtimeMs)
  try {
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  return null
}

export function applyActions({ actions, scanned, paths, stamp }) {
  const byKey = new Map(scanned.folders.map((f) => [f.key, f]))
  const results = { done: [], skipped: [], errors: [] }
  for (const action of actions) {
    try {
      const reason = applyOne(action, byKey, paths, stamp)
      if (reason) results.skipped.push({ action, reason })
      else results.done.push(action)
    } catch (error) {
      results.errors.push({ action, error: error.code ?? error.message })
    }
  }
  return results
}

export function listBackups(paths) {
  try {
    return fs.readdirSync(paths.backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function takeBackup(paths, name) {
  const dest = path.join(paths.backupsDir, name)
  fs.mkdirSync(paths.backupsDir, { recursive: true })
  fs.cpSync(paths.sessionsRoot, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
  return name
}

// Current folders are moved to trash, not erased, so a restore can itself be undone by hand.
export function restoreBackup(paths, name, stamp) {
  const source = path.join(paths.backupsDir, name)
  if (!fs.statSync(source).isDirectory()) throw new Error(`no backup named ${name}`)
  const aside = path.join(paths.trashDir, `${stamp}-pre-restore`)
  fs.mkdirSync(aside, { recursive: true })
  for (const entry of fs.readdirSync(paths.sessionsRoot)) {
    fs.renameSync(path.join(paths.sessionsRoot, entry), path.join(aside, entry))
  }
  fs.cpSync(source, paths.sessionsRoot, { recursive: true, preserveTimestamps: true })
  fs.rmSync(paths.stateFile, { force: true })
}
