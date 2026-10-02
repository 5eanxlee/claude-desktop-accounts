import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const LABEL = 'local.claude-session-sync'

const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plistXml({ node, script, errorLog }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(errorLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(errorLog)}</string>
</dict>
</plist>
`
}

// process.execPath is the resolved, versioned location (e.g. a Homebrew Cellar path) that an
// upgrade removes. A PATH entry that links to it keeps working afterwards.
export function stableNodePath(execPath = process.execPath, dirs = (process.env.PATH ?? '').split(path.delimiter)) {
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'node')
    try {
      if (candidate !== execPath && fs.realpathSync(candidate) === fs.realpathSync(execPath)) return candidate
    } catch {}
  }
  return execPath
}

const launchctl = (args) => spawnSync('/bin/launchctl', args, { stdio: 'ignore' }).status ?? 1

// The tool writes its own log; this file only catches a crash before the logger is up.
export const errorLogFor = (paths) => paths.logFile.replace(/\.log$/, '.err.log')

export function install({ paths, node, script, uid = process.getuid(), run = launchctl }) {
  fs.mkdirSync(path.dirname(paths.launchAgent), { recursive: true })
  fs.writeFileSync(paths.launchAgent, plistXml({ node, script, errorLog: errorLogFor(paths) }), { mode: 0o644 })
  run(['bootout', `gui/${uid}/${LABEL}`])
  const status = run(['bootstrap', `gui/${uid}`, paths.launchAgent])
  if (status !== 0) throw new Error(`launchctl bootstrap failed with status ${status}`)
}

export function uninstall({ paths, uid = process.getuid(), run = launchctl }) {
  run(['bootout', `gui/${uid}/${LABEL}`])
  fs.rmSync(paths.launchAgent, { force: true })
}

export function agentStatus({ paths, uid = process.getuid(), run = launchctl }) {
  const installed = fs.existsSync(paths.launchAgent)
  const loaded = run(['print', `gui/${uid}/${LABEL}`]) === 0
  return { installed, loaded }
}
