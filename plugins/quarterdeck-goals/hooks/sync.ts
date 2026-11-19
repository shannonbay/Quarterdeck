/**
 * Keeps the snapshot current: one read at a time, adaptive polling, and the
 * shared wrapper every button and tool uses to run an action then re-read.
 */
import type { EngineInterface } from 'claude-code'

import type { Snapshot } from '../types'
import { announce, showStatus, savePoll } from './alerts'
import { fetchOverview, fetchTodos, settings } from './api'
import { planModeBlocked, toCard } from './model'
import { kick } from './runner'
import { getNotice, getSnapshot, setBusy, setNotice, setSnapshot, setTodos, getExpanded } from './state'

type Engine = EngineInterface

const FAST_MS = 5_000
const MAX_BACKOFF_MS = 60_000

let inFlight: Promise<Snapshot> | null = null
let failures = 0
let timer: { cancel: () => void } | null = null

/** Reads the overview once; a read already under way is shared, not repeated. */
export function refresh($: Engine): Promise<Snapshot> {
  // The to-do lists are re-read every time, even when the goals overview is unchanged
  inFlight ??= load($).then(async (s) => {
    await refreshTodos($)
    return s
  }).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function load($: Engine): Promise<Snapshot> {
  const previous = await getSnapshot($)
  const now = await $.clock.now()
  let next: Snapshot
  try {
    // Expanded goals come with their detail; if that ever makes the answer too large to read, cards alone still work
    const res = await fetchOverview($, previous.reachable ? previous.etag : null, await getExpanded($))
      .catch((err: unknown) => {
        if (err instanceof Error && /too large/.test(err.message)) return fetchOverview($, null, [])
        throw err
      })
    failures = 0
    if (!res.changed) {
      // Unchanged: keep the stored value so nothing redraws, unless it was offline.
      if (previous.reachable) return previous
      next = { ...previous, reachable: true, error: null, fetchedAt: now }
    } else {
      const goals = res.goals.map(toCard)
      next = { reachable: true, error: null, goals, fetchedAt: now, etag: res.etag, hold: res.hold, ...(res.outdated ? { outdated: true } : {}), ...(res.standing ? { standing: true } : {}), ...(res.update ? { update: res.update } : {}), ...(res.deleted.length ? { deleted: res.deleted.map((d) => ({ id: d.id, name: d.name, deletedAt: d.deleted_at, purgeAt: d.purge_at })) } : {}) }
      await announce($, goals, now)
    }
  } catch (err) {
    failures += 1
    // fetchedAt stays: it dates the goals still shown, not this failed read
    next = { ...previous, reachable: false, error: err instanceof Error ? err.message : String(err), etag: null }
  }
  await setSnapshot($, next)
  showStatus($, next)
  return next
}

/** How long until the next poll: quicker while a run is open, backing off while offline. */
export function nextDelay(s: Snapshot): number {
  const base = settings.pollSeconds * 1000
  if (!s.reachable) return Math.min(base * 2 ** Math.max(failures - 1, 0), Math.max(MAX_BACKOFF_MS, base))
  if (s.goals.some((g) => g.openRun)) return Math.min(FAST_MS, base)
  return base
}

/** Polls until `stopPolling`; each poll schedules the next. */
export function startPolling($: Engine, first: Snapshot): void {
  timer?.cancel()
  timer = $.clock.after(nextDelay(first), () => {
    void $.clock.now().then((t) => savePoll($, t))
    void refresh($).then((s) => startPolling($, s))
  })
}

export function stopPolling(): void {
  timer?.cancel()
  timer = null
}

/** The act() keys (before the colon) of the pane's and Claude's goal changes, which the server refuses while outdated. */
export const OUTDATED_REFUSES = new Set([
  'approve', 'reject', 'answer', 'auto', 'delete', 'cancel', 'schedule', 'run', 'pause', 'resume', 'goal-pause', 'goal-resume', 'trust', 'forget', 'model', 'update', 'restore', 'purge',
])
export const OUTDATED_NOTICE = 'Quarterdeck was updated in another session, and this session still runs the older version: press Reload now (above), or run /reload-plugins, first.'

/** Why the last act() failed (its notice), for a tool's answer to Claude; `fallback` when there is none. */
export async function actFailure($: Engine, fallback: string): Promise<string> {
  const notice = await getNotice($)
  return notice ?? fallback
}

/**
 * Runs one action for a button or tool: marks it busy under `key`, records
 * its error (or clears the last one), then re-reads. Resolves whether it worked.
 * While the overview says outdated, a goal change (OUTDATED_REFUSES) is refused
 * up front with OUTDATED_NOTICE, without calling the server.
 */
export async function act($: Engine, key: string, label: string, run: () => Promise<void>): Promise<boolean> {
  // A newer Quarterdeck upgraded the database: this session's server refuses changes it could
  // misread (#60), so say so before the press goes anywhere. Reads and to-dos carry on
  if (OUTDATED_REFUSES.has(key.split(':')[0]!) && (await getSnapshot($)).outdated) {
    await setNotice($, `Couldn't ${label}: ${OUTDATED_NOTICE}`)
    return false
  }
  await setBusy($, key)
  let ok = false
  try {
    await run()
    await setNotice($, null)
    ok = true
    await kick($) // an approval or "Run now" queued a run: start it now
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await setNotice($, planModeBlocked(message)
      ? `Couldn't ${label}: plan mode is on, and Claude Code doesn't let Quarterdeck change anything until it ends (Shift+Tab to leave it).`
      : `Couldn't ${label}: ${message}`)
  }
  await setBusy($, null)
  await refresh($)
  return ok
}

/** Re-reads this project's to-do lists (a failed read keeps the last one). The project is the session's root: a shell `cd` into a subfolder doesn't move it. */
export async function refreshTodos($: Engine): Promise<void> {
  try {
    const dir = await $.session.root()
    await setTodos($, { dir, lists: await fetchTodos($, dir) })
  } catch {
    // not connected: the pane says so for the goals
  }
}
