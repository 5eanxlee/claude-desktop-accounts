import fs from 'node:fs'
import { runPass } from './sync.js'

const count = (actions, type) => actions.filter((a) => a.type === type).length

export function describePass(summary) {
  if (summary.locked) return 'skipped: another pass is running'
  if (summary.abort) return `stopped without changes: ${summary.notes.join('; ') || summary.abort}`
  const done = summary.results.done
  const parts = [
    `${count(done, 'create')} created`,
    `${count(done, 'overwrite')} updated`,
    `${count(done, 'trash')} trashed`
  ]
  if (summary.deferred.length) parts.push(`${summary.deferred.length} deferred until the active folder is free`)
  const held = Object.values(summary.held).reduce((n, ids) => n + ids.length, 0)
  if (held) parts.push(`${held} held for review`)
  if (summary.results.skipped.length) parts.push(`${summary.results.skipped.length} skipped (changed during the pass)`)
  for (const { action, error } of summary.results.errors) parts.push(`error ${error} on ${action.type} ${action.folder}/${action.id ?? 'hint'}`)
  if (summary.backup) parts.push(`backup ${summary.backup} taken`)
  return parts.join(', ')
}

// Runs a pass on start, shortly after any change under the sessions root, and on a fixed interval.
export function startWatch({ paths, running, debounceMs = 500, intervalMs = 15_000, log = () => {} }) {
  let pending = null
  let watcher = null
  let stopped = false
  let lastReport = null

  const run = () => {
    if (stopped) return
    let summary
    try {
      summary = runPass({ paths, ...(running ? { running } : {}) })
    } catch (error) {
      log(`pass failed: ${error.message}`)
      return
    }
    // A standing situation (deferred work, a hold) is reported once, not every interval.
    const changed = summary.results.done.length > 0 || summary.results.errors.length > 0
    const standing = JSON.stringify([summary.abort, summary.deferred, summary.held])
    const quiet = !changed && !summary.abort && summary.deferred.length === 0 && Object.keys(summary.held).length === 0
    if (changed || (!quiet && standing !== lastReport)) log(describePass(summary))
    lastReport = standing
  }

  // Events during the wait are coalesced, so a busy session cannot postpone the pass forever.
  const onEvent = () => {
    if (stopped || pending) return
    pending = setTimeout(() => {
      pending = null
      run()
    }, debounceMs)
  }

  const attach = () => {
    if (watcher || stopped) return
    try {
      watcher = fs.watch(paths.sessionsRoot, { recursive: true }, onEvent)
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }

  const tick = setInterval(() => {
    attach()
    run()
  }, intervalMs)
  attach()
  run()

  return () => {
    stopped = true
    clearTimeout(pending)
    clearInterval(tick)
    watcher?.close()
    watcher = null
  }
}
