import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

// Claude Desktop logs this each time an account finishes loading its Code sessions.
const INIT_LINE = /\[LocalSessionManager\] Initialization succeeded — accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})/g

export function activePairFromLog(text) {
  let last = null
  for (const match of text.matchAll(INIT_LINE)) last = match
  return last ? { account: last[1], org: last[2] } : null
}

export function readActivePair(mainLog, { tailBytes = 512 * 1024 } = {}) {
  let fd
  try {
    fd = fs.openSync(mainLog, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - tailBytes)
    const tail = Buffer.alloc(size - start)
    fs.readSync(fd, tail, 0, tail.length, start)
    const fromTail = activePairFromLog(tail.toString('utf8'))
    if (fromTail || start === 0) return fromTail
    const head = Buffer.alloc(start)
    fs.readSync(fd, head, 0, head.length, 0)
    return activePairFromLog(head.toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
}

export function claudeInProcessList(text) {
  return text.split('\n').some((line) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(line.trim()))
}

// ps, not pgrep: pgrep leaves out its own ancestors, so it misses Claude when run from a session inside it.
export function isClaudeRunning() {
  const result = spawnSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' })
  // If the process list cannot be read, assume Claude is running: that only makes the pass more careful.
  return result.status !== 0 || claudeInProcessList(result.stdout)
}

// The folder Claude currently holds in memory must not have records overwritten or removed.
export function protectedKeys({ running, pair, folderKeys }) {
  if (!running) return new Set()
  if (!pair) return new Set(folderKeys)
  return new Set([`${pair.account}/${pair.org}`])
}
