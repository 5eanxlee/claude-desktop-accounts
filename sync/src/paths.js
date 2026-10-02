import os from 'node:os'
import path from 'node:path'

// CSS_HOME points the whole tool at another home directory, e.g. a copy used for a trial run.
export function defaultPaths({ home = os.homedir(), env = process.env } = {}) {
  const base = env.CSS_HOME || home
  const support = path.join(base, 'Library', 'Application Support')
  const stateDir = path.join(support, 'claude-session-sync')
  return {
    sessionsRoot: path.join(support, 'Claude', 'claude-code-sessions'),
    mainLog: path.join(base, 'Library', 'Logs', 'Claude', 'main.log'),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    stagingDir: path.join(stateDir, 'staging'),
    backupsDir: path.join(stateDir, 'backups'),
    trashDir: path.join(stateDir, 'trash'),
    lockFile: path.join(stateDir, 'lock'),
    logFile: path.join(base, 'Library', 'Logs', 'claude-session-sync.log'),
    launchAgent: path.join(base, 'Library', 'LaunchAgents', 'local.claude-session-sync.plist')
  }
}
