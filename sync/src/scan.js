import fs from 'node:fs'
import path from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECORD_FILE = /^(local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i
export const HINT_FILE = 'archived-sessions.idx'
// Claude Desktop skips record files above this size, so a larger one is not worth mirroring.
export const MAX_RECORD_BYTES = 10 * 1024 * 1024

const realDirs = (dir) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  // Dirent.isDirectory() is false for a symlink, which is what we want: linked folders are skipped.
  return entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name).sort()
}

function readRecord(file, id, maxBytes) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile()) return { reason: 'not-regular' }
  if (stat.nlink > 1) return { reason: 'hardlink' }
  if (stat.size > maxBytes) return { reason: 'oversized' }
  const bytes = fs.readFileSync(file)
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { reason: 'bad-json' }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { reason: 'not-object' }
  if (data.sessionId !== id) return { reason: 'id-mismatch' }
  return {
    record: {
      id,
      file,
      bytes,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lastActivityAt: typeof data.lastActivityAt === 'number' ? data.lastActivityAt : 0,
      isArchived: data.isArchived === true
    }
  }
}

function readHint(dir) {
  const none = { exists: false, known: false, ids: [] }
  let stat
  try {
    stat = fs.lstatSync(path.join(dir, HINT_FILE))
  } catch {
    return none
  }
  const unknown = { exists: true, known: false, ids: [] }
  if (!stat.isFile() || stat.nlink > 1) return unknown
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, HINT_FILE), 'utf8'))
    if (data?.v !== 1 || !Array.isArray(data.archived) || !data.archived.every((id) => typeof id === 'string')) return unknown
    return { exists: true, known: true, ids: data.archived }
  } catch {
    return unknown
  }
}

export function scan(sessionsRoot, { maxBytes = MAX_RECORD_BYTES } = {}) {
  const folders = []
  let fileCount = 0
  let validCount = 0
  for (const account of realDirs(sessionsRoot)) {
    for (const org of realDirs(path.join(sessionsRoot, account))) {
      const dir = path.join(sessionsRoot, account, org)
      const records = new Map()
      const invalid = new Map()
      for (const name of fs.readdirSync(dir).sort()) {
        const match = RECORD_FILE.exec(name)
        if (!match) continue
        fileCount++
        let result
        try {
          result = readRecord(path.join(dir, name), match[1], maxBytes)
        } catch (error) {
          // The app can remove a record between the listing and the read.
          if (error.code === 'ENOENT') {
            fileCount--
            continue
          }
          result = { reason: `unreadable:${error.code ?? 'unknown'}` }
        }
        if (result.record) {
          records.set(match[1], result.record)
          validCount++
        } else {
          invalid.set(match[1], result.reason)
        }
      }
      folders.push({ key: `${account}/${org}`, account, org, dir, records, invalid, hint: readHint(dir) })
    }
  }
  return { folders, fileCount, validCount }
}
