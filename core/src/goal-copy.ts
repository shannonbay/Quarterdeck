/**
 * Copying a goal to another folder (#208): the rewrite of the old folder and repo
 * in its instructions and watches (pure, so the server's copy_goal and the plugin's
 * confirm show the same result), and the copy itself.
 */

import type { Database } from './sqlite.js'
import type { Goal, Watch, WatchSpec, WatchSpecCommon } from './types.js'
import { createGoal, getGoal, updateGoal } from './goals.js'
import { listWatches } from './watches.js'
import { getSchedule, setSchedule } from './schedule.js'
import { applyGoalChanges, type GoalChanges } from './goal-changes.js'

export interface CopyRewrite {
  /** The goal's folder now, and the folder it is copied to. */
  fromDir: string
  toDir: string
  /** owner/name of each folder's forge remote; the repo is left alone when either is missing. */
  fromRepo?: string | null
  toRepo?: string | null
  /** Folder paths match in any case (default: on Windows). */
  caseInsensitive?: boolean
}

export interface Replacement {
  from: string
  to: string
  count: number
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The folder without trailing separators, split into its parts. */
function dirParts(dir: string): string[] {
  let end = dir.length
  while (end > 1 && (dir[end - 1] === '/' || dir[end - 1] === '\\')) end--
  return dir.slice(0, end).split(/[\\/]/)
}

/** A pattern for the folder in either slash form; it doesn't match the start of a longer folder name. */
function dirPattern(dir: string, flags: string): RegExp | null {
  const parts = dirParts(dir)
  if (!parts.join('')) return null
  return new RegExp(`${parts.map(escapeRegExp).join('[\\\\/]')}(?![\\w.-])`, flags)
}

/** Rewrites one string, adding what it replaced to `made`. */
function rewriteString(text: string, opts: CopyRewrite, made: Map<string, Replacement>): string {
  const ci = opts.caseInsensitive ?? process.platform === 'win32'
  const toParts = dirParts(opts.toDir)
  let out = text
  const dir = dirPattern(opts.fromDir, ci ? 'gi' : 'g')
  if (dir && dirParts(opts.fromDir).join('/') !== toParts.join('/')) {
    out = out.replace(dir, (m) => {
      // Keep the slash form the text used
      const to = m.includes('\\') ? toParts.join('\\') : toParts.join('/')
      note(made, m, to)
      return to
    })
  }
  const { fromRepo, toRepo } = opts
  if (fromRepo && toRepo && fromRepo.toLowerCase() !== toRepo.toLowerCase()) {
    const repo = new RegExp(`(?<![\\w.-])${escapeRegExp(fromRepo)}(?![\\w-]|\\.[\\w-])`, 'gi')
    out = out.replace(repo, (m) => {
      note(made, m, toRepo)
      return toRepo
    })
  }
  return out
}

function note(made: Map<string, Replacement>, from: string, to: string) {
  const key = `${from}\u0000${to}`
  const r = made.get(key)
  if (r) r.count++
  else made.set(key, { from, to, count: 1 })
}

/**
 * Rewrites the old folder and repo in a value: a string, or every string inside
 * an array or object (a watch's command, tool input, steps and finally).
 * Returns the new value and the replacements made.
 */
export function rewriteForCopy<T>(value: T, opts: CopyRewrite): { value: T; replacements: Replacement[] } {
  const made = new Map<string, Replacement>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return rewriteString(v, opts, made)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return { value: walk(value) as T, replacements: [...made.values()] }
}

/** A stored watch as the spec that sets it up again (in full, not describeWatch's clipped text). */
export function watchSpecOf(w: Watch): WatchSpec {
  const common: WatchSpecCommon = {
    ...(w.match !== null && { match: w.match }),
    ...(w.ignore !== null && { ignore: w.ignore }),
    ...(w.urgent && { urgent: true }),
    every_minutes: w.every_minutes,
    fires: w.fires,
    ...(w.status_rules && { status: w.status_rules }),
  }
  if (w.kind === 'command') return { ...common, command: w.command ?? '' }
  if (w.steps) return { ...common, steps: w.steps, ...(w.finally && { finally: w.finally }) }
  return { ...common, tool: w.tool ?? '', input: w.tool_input }
}

export interface CopyGoalInput {
  /** The new goal's id and name, and the folder it works in. */
  id: string
  name: string
  working_dir: string
  /** The instructions and watches to save (the rewritten text the person confirmed); left out: the source's. */
  instructions?: string
  watches?: Record<string, WatchSpec>
}

/**
 * Copies a goal's set-up to a new goal (#208): objective, instructions, autonomy,
 * auto_after_outside, every limit, tool map, watches (each with a fresh baseline),
 * schedule, model and one_off. Nothing about runs, items, questions, to-dos,
 * memory or status. The copy starts paused with no next run due.
 */
export function copyGoal(db: Database, sourceId: string, input: CopyGoalInput): Goal {
  const src = getGoal(db, sourceId)
  if (!src) throw new Error(`Goal ${sourceId} not found.`)
  const watches = input.watches ?? Object.fromEntries(listWatches(db, sourceId).map((w) => [w.name, watchSpecOf(w)]))
  const schedule = getSchedule(db, sourceId)
  const now = new Date().toISOString()
  db.transaction(() => {
    createGoal(db,
      { id: input.id, name: input.name, description: src.objective, status: 'active', working_dir: input.working_dir, created_at: now, updated_at: now },
      { objective: src.objective, instructions: input.instructions ?? src.instructions, status: 'paused', autonomy: src.autonomy, limits: src.limits, item_retention_days: src.item_retention_days, one_off: src.one_off, model: src.model },
    )
    const changes: GoalChanges = {}
    if (Object.keys(src.tool_map).length) changes.tool_map = src.tool_map
    if (src.auto_after_outside.length) changes.auto_after_outside = Object.fromEntries(src.auto_after_outside.map((c) => [c, true]))
    if (Object.keys(watches).length) changes.watches = watches
    if (Object.keys(changes).length) applyGoalChanges(db, input.id, changes)
    if (schedule) setSchedule(db, input.id, schedule)
    // Paused, with nothing due: it runs only once the person resumes it
    updateGoal(db, input.id, { status: 'paused', next_run_at: null })
  })()
  return getGoal(db, input.id)!
}

/** owner/name from a git remote URL (https, ssh or scp-like); null for a local path or anything else. */
export function repoOfRemote(url: string): string | null {
  let u = url.trim()
  if (!u.includes('://') && !/^[\w.-]+@[\w.-]+:/.test(u)) return null
  if (u.endsWith('.git')) u = u.slice(0, -4)
  while (u.endsWith('/')) u = u.slice(0, -1)
  const parts = u.split(/[/:]/)
  const [owner, name] = parts.slice(-2)
  if (parts.length < 3 || !owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return `${owner}/${name}`
}
