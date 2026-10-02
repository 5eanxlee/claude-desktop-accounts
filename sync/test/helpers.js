import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const ORG_A = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0'
export const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const ORG_B = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0'
export const ACCT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const ORG_C = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'
export const KEY_A = `${ACCT_A}/${ORG_A}`
export const KEY_B = `${ACCT_B}/${ORG_B}`
export const KEY_C = `${ACCT_C}/${ORG_C}`

export const sid = (n) => `local_${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

// A throwaway layout mirroring the real one: sessions root, Claude log, tool state.
export function makeEnv(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'css-test-')))
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = path.join(root, 'state')
  const paths = {
    sessionsRoot: path.join(root, 'claude-code-sessions'),
    mainLog: path.join(root, 'logs', 'main.log'),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    stagingDir: path.join(stateDir, 'staging'),
    backupsDir: path.join(stateDir, 'backups'),
    trashDir: path.join(stateDir, 'trash'),
    lockFile: path.join(stateDir, 'lock'),
    logFile: path.join(root, 'logs', 'claude-session-sync.log'),
    launchAgent: path.join(root, 'LaunchAgents', 'local.claude-session-sync.plist')
  }
  fs.mkdirSync(paths.sessionsRoot, { recursive: true })
  fs.mkdirSync(path.dirname(paths.mainLog), { recursive: true })
  return { root, paths }
}

export function folderDir(paths, key) {
  return path.join(paths.sessionsRoot, ...key.split('/'))
}

export function makeFolder(paths, key) {
  const dir = folderDir(paths, key)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function recordJson(id, fields = {}) {
  return JSON.stringify({ sessionId: id, cliSessionId: `cli-${id}`, lastActivityAt: 1000, isArchived: false, title: id, ...fields })
}

// Writes a record file; mtime in ms lets tests control the tie-break.
export function writeRecord(paths, key, id, fields = {}, mtimeMs) {
  const dir = makeFolder(paths, key)
  const file = path.join(dir, `${id}.json`)
  fs.writeFileSync(file, recordJson(id, fields), { mode: 0o600 })
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

export function readRecord(paths, key, id) {
  return JSON.parse(fs.readFileSync(path.join(folderDir(paths, key), `${id}.json`), 'utf8'))
}

export function hasRecord(paths, key, id) {
  return fs.existsSync(path.join(folderDir(paths, key), `${id}.json`))
}

export function writeHint(paths, key, ids) {
  fs.writeFileSync(path.join(makeFolder(paths, key), 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: ids }), { mode: 0o600 })
}

export function readHint(paths, key) {
  return JSON.parse(fs.readFileSync(path.join(folderDir(paths, key), 'archived-sessions.idx'), 'utf8'))
}

export function writeLog(paths, lines) {
  fs.writeFileSync(paths.mainLog, lines.join('\n') + '\n')
}

export const initLine = (account, org) =>
  `2026-09-30 02:35:34 [info] [LocalSessionManager] Initialization succeeded — accountId=${account}, orgId=${org}, existingSessions=0`

export function listAll(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(dir, p))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}
