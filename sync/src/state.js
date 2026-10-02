import fs from 'node:fs'

const LOCK_STALE_MS = 10 * 60 * 1000

export const emptyState = () => ({ version: 1, known: {}, tombstones: {}, held: {}, firstBackup: null, lastChange: null })

// readOnly is for dry runs, which must not touch disk even to set a corrupt file aside.
export function loadState(paths, { readOnly = false } = {}) {
  let text
  try {
    text = fs.readFileSync(paths.stateFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
  try {
    const data = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
    return { ...emptyState(), ...data }
  } catch {
    // Starting over is safe: with nothing remembered, nothing counts as deleted.
    if (!readOnly) fs.renameSync(paths.stateFile, `${paths.stateFile}.corrupt-${Date.now()}`)
    return emptyState()
  }
}

export function saveState(paths, state) {
  fs.mkdirSync(paths.stateDir, { recursive: true })
  const tmp = `${paths.stateFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, paths.stateFile)
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Returns a release function, or null when another live pass holds the lock.
export function acquireLock(paths) {
  fs.mkdirSync(paths.stateDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(paths.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 })
      return () => fs.rmSync(paths.lockFile, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let holder = NaN
    let age = Infinity
    try {
      holder = Number(fs.readFileSync(paths.lockFile, 'utf8').trim())
      age = Date.now() - fs.statSync(paths.lockFile).mtimeMs
    } catch {
      continue
    }
    if (alive(holder) && age < LOCK_STALE_MS) return null
    fs.rmSync(paths.lockFile, { force: true })
  }
  return null
}
