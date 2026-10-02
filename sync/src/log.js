import fs from 'node:fs'
import path from 'node:path'

export function makeLogger(logFile, { maxBytes = 1024 * 1024, now = Date.now } = {}) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      let size = 0
      try {
        size = fs.statSync(logFile).size
      } catch {}
      if (size >= maxBytes) fs.renameSync(logFile, `${logFile}.1`)
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()} ${line}\n`)
    } catch {
      // Logging must never take the sync loop down.
    }
  }
}
