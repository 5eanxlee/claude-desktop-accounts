import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { problems, copyPayload, install, uninstall } from '../lib/installer.js'
import { main } from '../lib/cli.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-test-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const files = (dir) => {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(dir, p)) } }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}
const ready = { platform: 'darwin', nodeMajor: 22, hasSwift: true, hasClaude: true }

test('a ready Mac has no problems', () => {
  assert.deepEqual(problems(ready, { wantSync: true, wantApp: true }), [])
})

test('each missing prerequisite is named with how to fix it', () => {
  assert.match(problems({ ...ready, platform: 'linux' }, { wantSync: true, wantApp: true }).join(), /macOS/)
  assert.match(problems({ ...ready, hasClaude: false }, { wantSync: true, wantApp: true }).join(), /claude\.ai\/download/)
  assert.match(problems({ ...ready, nodeMajor: 20 }, { wantSync: true, wantApp: false }).join(), /Node\.js 22/)
  assert.match(problems({ ...ready, hasSwift: false }, { wantSync: false, wantApp: true }).join(), /xcode-select --install/)
})

test('a tool that is not being installed does not need its prerequisite', () => {
  assert.deepEqual(problems({ ...ready, nodeMajor: 18 }, { wantSync: false, wantApp: true }), [])
  assert.deepEqual(problems({ ...ready, hasSwift: false }, { wantSync: true, wantApp: false }), [])
})

test('the package copies itself to a permanent folder, without tests or build output', (t) => {
  const dest = path.join(tmp(t), 'install')
  assert.equal(copyPayload(ROOT, dest), true)
  const copied = files(dest)
  for (const needed of ['package.json', 'bin/cli.js', 'lib/installer.js', 'sync/bin/claude-session-sync.js', 'sync/src/sync.js', 'sync/package.json', 'app/build.sh', 'app/App.swift', 'app/Tests.swift']) {
    assert.ok(copied.includes(needed), `${needed} is copied`)
  }
  assert.equal(copied.some((f) => f.startsWith('sync/test/') || f.startsWith('test/') || f.startsWith('app/build/') || f.startsWith('.git')), false)
})

test('copying over an earlier install replaces it and leaves no staging folders', (t) => {
  const base = tmp(t)
  const dest = path.join(base, 'install')
  fs.mkdirSync(path.join(dest, 'sync', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'sync', 'src', 'removed-in-new-version.js'), 'old')
  copyPayload(ROOT, dest)
  assert.equal(fs.existsSync(path.join(dest, 'sync', 'src', 'removed-in-new-version.js')), false)
  assert.deepEqual(fs.readdirSync(base), ['install'])
})

test('installing from the permanent folder itself copies nothing', () => {
  assert.equal(copyPayload(ROOT, ROOT), false)
})

test('install sets up the sync, then builds the app, from the permanent folder', (t) => {
  const dest = path.join(tmp(t), 'install')
  const calls = []
  const code = install({ src: ROOT, dest, wantSync: true, wantApp: true, run: (cmd, args) => { calls.push([cmd, ...args]); return 0 }, out: () => {} })
  assert.equal(code, 0)
  assert.deepEqual(calls, [
    [process.execPath, path.join(dest, 'sync/bin/claude-session-sync.js'), 'install'],
    ['/bin/zsh', path.join(dest, 'app/build.sh'), 'install']
  ])
})

test('install stops at the first step that fails', (t) => {
  const dest = path.join(tmp(t), 'install')
  const calls = []
  const code = install({ src: ROOT, dest, wantSync: true, wantApp: true, run: (cmd, args) => { calls.push(args[0]); return 3 }, out: () => {} })
  assert.equal(code, 3)
  assert.equal(calls.length, 1)
})

test('install skips the tools that were left out', (t) => {
  const dest = path.join(tmp(t), 'install')
  const calls = []
  install({ src: ROOT, dest, wantSync: false, wantApp: true, run: (cmd, args) => { calls.push(args[0]); return 0 }, out: () => {} })
  assert.deepEqual(calls, [path.join(dest, 'app/build.sh')])
})

test('uninstall removes the agent and the app but keeps data', (t) => {
  const home = tmp(t)
  const dest = path.join(home, '.claude-desktop-accounts')
  copyPayload(ROOT, dest)
  const app = path.join(home, 'Applications', 'Claude Accounts.app')
  fs.mkdirSync(app, { recursive: true })
  const data = path.join(home, 'Library', 'Application Support', 'Claude Accounts')
  fs.mkdirSync(data, { recursive: true })
  const calls = []
  uninstall({ home, dest, purge: false, appDirs: [path.join(home, 'Applications')], run: (cmd, args) => { calls.push([cmd, ...args]); return 0 }, out: () => {} })
  assert.deepEqual(calls[0], [process.execPath, path.join(dest, 'sync/bin/claude-session-sync.js'), 'uninstall'])
  assert.equal(fs.existsSync(app), false)
  assert.equal(fs.existsSync(data), true)
  assert.equal(fs.existsSync(dest), true)
})

test('uninstall --purge also deletes saved data, logs and the permanent folder', (t) => {
  const home = tmp(t)
  const dest = path.join(home, '.claude-desktop-accounts')
  copyPayload(ROOT, dest)
  const support = path.join(home, 'Library', 'Application Support')
  for (const dir of ['Claude Accounts', 'claude-session-sync']) fs.mkdirSync(path.join(support, dir), { recursive: true })
  fs.mkdirSync(path.join(home, 'Library', 'Logs'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Library', 'Logs', 'claude-session-sync.log'), 'x')
  fs.mkdirSync(path.join(support, 'Claude'), { recursive: true })
  uninstall({ home, dest, purge: true, appDirs: [], run: () => 0, out: () => {} })
  assert.deepEqual(fs.readdirSync(support), ['Claude'])
  assert.equal(fs.existsSync(path.join(home, 'Library', 'Logs', 'claude-session-sync.log')), false)
  assert.equal(fs.existsSync(dest), false)
})

// Command line, with the outside world replaced.
function cli(argv, extra = {}) {
  const out = []
  const calls = []
  const code = main(argv, {
    out: (line) => out.push(line),
    isTTY: false,
    detect: () => ready,
    run: (cmd, args) => { calls.push([cmd, ...args]); return 0 },
    dest: path.join(os.tmpdir(), `cda-cli-${process.pid}-${Math.random()}`),
    ...extra
  })
  return { code, text: out.join('\n'), calls }
}

test('--version prints the package version', () => {
  assert.deepEqual([cli(['--version']).code, cli(['--version']).text], [0, VERSION])
})

test('--help lists the commands', () => {
  const { code, text } = cli(['--help'])
  assert.equal(code, 0)
  for (const command of ['install', 'uninstall', 'status', 'sync', 'restore']) assert.match(text, new RegExp(command))
})

test('an unknown command or option is a usage error', () => {
  assert.equal(cli(['frobnicate']).code, 2)
  assert.equal(cli(['install', '--bogus']).code, 2)
})

test('without a terminal, install asks for --yes instead of guessing', () => {
  const { code, text, calls } = cli(['install'])
  assert.equal(code, 1)
  assert.match(text, /--yes/)
  assert.deepEqual(calls, [])
})

test('declining the question installs nothing', () => {
  const { code, text, calls } = cli([], { isTTY: true, ask: () => 'n' })
  assert.equal(code, 0)
  assert.match(text, /Nothing was installed/)
  assert.deepEqual(calls, [])
})

test('missing prerequisites stop the install before anything changes', () => {
  const { code, text, calls } = cli(['install', '--yes'], { detect: () => ({ ...ready, hasSwift: false }) })
  assert.equal(code, 1)
  assert.match(text, /xcode-select --install/)
  assert.deepEqual(calls, [])
})

test('leaving out both tools is a usage error', () => {
  assert.equal(cli(['install', '--yes', '--no-sync', '--no-app']).code, 2)
})

test('agreeing runs the install', (t) => {
  const dest = path.join(tmp(t), 'install')
  const { code, calls } = cli(['install'], { isTTY: true, ask: () => 'y', dest })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.ok(fs.existsSync(path.join(dest, 'sync/bin/claude-session-sync.js')))
})

test('sync commands pass through to the session sync', (t) => {
  const home = tmp(t)
  const { code, text } = cli(['sync', '--dry-run'], { env: { CSS_HOME: home } })
  assert.equal(code, 0)
  assert.match(text, /Dry run: nothing was written/)
})
