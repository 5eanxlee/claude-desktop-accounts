import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { activePairFromLog, readActivePair, protectedKeys, claudeInProcessList, isClaudeRunning } from '../src/active.js'
import { makeEnv, writeLog, initLine, ACCT_A, ORG_A, ACCT_B, ORG_B, KEY_A, KEY_B } from './helpers.js'

test('takes the last initialization line as the active pair', () => {
  const text = [initLine(ACCT_A, ORG_A), 'noise', initLine(ACCT_B, ORG_B), 'more noise'].join('\n')
  assert.deepEqual(activePairFromLog(text), { account: ACCT_B, org: ORG_B })
})

test('returns null when the log has no initialization line', () => {
  assert.equal(activePairFromLog('2026-09-30 [info] something else\n'), null)
})

test('ignores initialization lines from other managers', () => {
  const other = `2026-09-30 [info] [LocalAgentModeSessionManager] Initialization succeeded — accountId=${ACCT_B}, orgId=${ORG_B}, existingSessions=0`
  assert.deepEqual(activePairFromLog([initLine(ACCT_A, ORG_A), other].join('\n')), { account: ACCT_A, org: ORG_A })
})

test('finds the line even when it is far above the tail of a long log', (t) => {
  const { paths } = makeEnv(t)
  writeLog(paths, [initLine(ACCT_A, ORG_A), ...Array(2000).fill('x'.repeat(100))])
  assert.deepEqual(readActivePair(paths.mainLog, { tailBytes: 1024 }), { account: ACCT_A, org: ORG_A })
})

test('prefers a line in the tail over an older one above it', (t) => {
  const { paths } = makeEnv(t)
  writeLog(paths, [initLine(ACCT_A, ORG_A), ...Array(2000).fill('x'.repeat(100)), initLine(ACCT_B, ORG_B)])
  assert.deepEqual(readActivePair(paths.mainLog, { tailBytes: 1024 }), { account: ACCT_B, org: ORG_B })
})

test('a missing log gives no active pair', (t) => {
  const { paths } = makeEnv(t)
  assert.equal(fs.existsSync(paths.mainLog), false)
  assert.equal(readActivePair(paths.mainLog), null)
})

test('Claude is recognised by its main executable in the process list', () => {
  const list = [
    '/sbin/launchd',
    '/Applications/Claude.app/Contents/MacOS/Claude',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'
  ].join('\n')
  assert.equal(claudeInProcessList(list), true)
})

test('helpers, the claude CLI and look-alike apps do not count as Claude running', () => {
  const list = [
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
    '/Users/x/.local/bin/claude',
    '/Applications/NotClaude.app/Contents/MacOS/NotClaude',
    'claude'
  ].join('\n')
  assert.equal(claudeInProcessList(list), false)
})

const insideDesktop = process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
test('the live check sees Claude when run from inside the desktop app', { skip: !insideDesktop }, () => {
  // pgrep hides its own ancestors on macOS, so a check made from a session inside Claude would miss it.
  assert.equal(isClaudeRunning(), true)
})

test('nothing is protected while Claude is not running', () => {
  const keys = protectedKeys({ running: false, pair: { account: ACCT_A, org: ORG_A }, folderKeys: [KEY_A, KEY_B] })
  assert.deepEqual([...keys], [])
})

test('the active folder is protected while Claude is running', () => {
  const keys = protectedKeys({ running: true, pair: { account: ACCT_A, org: ORG_A }, folderKeys: [KEY_A, KEY_B] })
  assert.deepEqual([...keys], [KEY_A])
})

test('every folder is protected when Claude is running and the active pair is unknown', () => {
  const keys = protectedKeys({ running: true, pair: null, folderKeys: [KEY_A, KEY_B] })
  assert.deepEqual([...keys].sort(), [KEY_A, KEY_B])
})
