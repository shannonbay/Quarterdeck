/**
 * Changing a goal from the conversation (the update_goal tool, which asks the
 * person to confirm first), and holding all goal runs while the person's
 * usage limit is reached.
 */
import type { Database } from './sqlite.js'
import { getPlan, updatePlan } from './queries.js'
import { getGoal, getMemory, getRun, insertMemory, normalizeModel, updateGoal, updateMemory, updateRun } from './goals.js'
import { failRun, GoalError } from './goal-engine.js'
import { UNTRUSTED_CATEGORY } from './guard.js'
import type { AutonomyMode, MemoryKind, WatchSpec } from './types.js'
import { describeStatusRules, describeWatch, listWatches, releaseWatchEvents, removeWatch, setWatch } from './watches.js'

// ── Goal changes ──────────────────────────────────────────────────────────────

export interface GoalChanges {
  name?: string
  objective?: string
  instructions?: string
  /**
   * Replacements in the current instructions, in order, each against the text
   * the ones before it left: `old` must appear exactly once. Cheaper to send
   * than the whole text, and the person reviews only what changes.
   */
  instructions_edits?: InstructionEdit[]
  /** Category → mode; null removes the category (it falls back to "propose"). */
  autonomy?: Record<string, AutonomyMode | null>
  /** Tool name pattern → category; null removes the rule. */
  tool_map?: Record<string, string | null>
  /**
   * Old category → the category to merge it into: past items' actions, the
   * autonomy setting and tool rules take the new name, so earlier approvals
   * count toward the "Switch to auto" suggestion.
   */
  merge_categories?: Record<string, string>
  add_memory?: { kind: MemoryKind; text: string; pinned?: boolean }[]
  /** Memory ids to deactivate. */
  forget_memory?: string[]
  /** Watch name → what it runs; null removes the watch. */
  watches?: Record<string, WatchSpec | null>
  status?: 'active' | 'paused'
  /** The model its runs use (an alias or a full id); null: the model of the session that starts the run. */
  model?: string | null
  /** Minutes after a watch-started run before watch events start another (0: none): events in between share the next run. */
  min_watch_gap_minutes?: number
}

export interface InstructionEdit { old: string; new: string }

/**
 * The instructions after `edits`, each applied to what the ones before it
 * left. Throws when an edit's `old` is empty, missing or there more than once,
 * so a change never lands somewhere nobody meant. The quarterdeck-goals plugin
 * has its own copy (`editInstructions`), to show the person before asking.
 */
export function applyInstructionEdits(text: string, edits: InstructionEdit[]): string {
  let out = text
  edits.forEach((e, i) => {
    const which = edits.length > 1 ? ` (edit ${i + 1})` : ''
    if (!e.old) throw new GoalError(`An instructions edit needs the text to replace${which}.`)
    const at = out.indexOf(e.old)
    if (at < 0) throw new GoalError(`The instructions don't contain the text to replace${which}: "${clipText(e.old)}". Read them again with goal_detail.`)
    if (out.indexOf(e.old, at + 1) >= 0) throw new GoalError(`The text to replace is in the instructions more than once${which}: "${clipText(e.old)}". Give more of it, so it's there once.`)
    out = out.slice(0, at) + e.new + out.slice(at + e.old.length)
  })
  return out
}

const clipText = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** The longest gap between watch-started runs a goal may set: a day. */
export const MAX_WATCH_GAP_MINUTES = 1440

const MODES = new Set(['off', 'propose', 'auto'])

/** Applies a set of changes the person confirmed. Returns one line per change made. */
export function applyGoalChanges(db: Database, planId: string, changes: GoalChanges): string[] {
  const goal = getGoal(db, planId)
  const plan = getPlan(db, planId)
  if (!goal || !plan) throw new GoalError(`Goal ${planId} not found.`)
  for (const [category, mode] of Object.entries(changes.autonomy ?? {})) {
    if (mode !== null && !MODES.has(mode)) throw new GoalError(`"${mode}" isn't a mode for ${category}: use off, propose or auto.`)
  }
  for (const [from, to] of Object.entries(changes.merge_categories ?? {})) {
    if (!from.trim() || !to.trim() || from.trim() === to.trim()) throw new GoalError(`Can't merge "${from}" into "${to}": give two different category names.`)
  }
  const model = changes.model === undefined ? undefined : normalizeModel(changes.model) // throws on a name that can't be a model
  for (const id of changes.forget_memory ?? []) {
    if (getMemory(db, id)?.plan_id !== planId) throw new GoalError(`Memory ${id} isn't this goal's.`)
  }
  if (changes.instructions !== undefined && changes.instructions_edits?.length) {
    throw new GoalError('Give the instructions in full or as edits, not both.')
  }
  const gap = changes.min_watch_gap_minutes
  if (gap !== undefined && (!Number.isInteger(gap) || gap < 0 || gap > MAX_WATCH_GAP_MINUTES)) {
    throw new GoalError(`The gap between watch runs is whole minutes from 0 to ${MAX_WATCH_GAP_MINUTES}, not ${gap}.`)
  }
  const edited = changes.instructions_edits?.length ? applyInstructionEdits(goal.instructions, changes.instructions_edits) : undefined

  const done: string[] = []
  db.transaction(() => {
    if (changes.name?.trim() && changes.name.trim() !== plan.name) {
      updatePlan(db, planId, { name: changes.name.trim(), updated_at: new Date().toISOString() })
      done.push(`renamed to "${changes.name.trim()}"`)
    }
    if (changes.objective?.trim() && changes.objective.trim() !== goal.objective) {
      updateGoal(db, planId, { objective: changes.objective.trim() })
      updatePlan(db, planId, { description: changes.objective.trim() })
      done.push('objective changed')
    }
    if (changes.instructions !== undefined && changes.instructions !== goal.instructions) {
      updateGoal(db, planId, { instructions: changes.instructions })
      done.push(changes.instructions.trim() ? 'instructions changed' : 'instructions cleared')
    }
    if (edited !== undefined && edited !== goal.instructions) {
      updateGoal(db, planId, { instructions: edited })
      const n = changes.instructions_edits!.length
      done.push(`instructions edited (${n} ${n === 1 ? 'change' : 'changes'})`)
    }
    if (changes.autonomy && Object.keys(changes.autonomy).length) {
      const autonomy = { ...goal.autonomy }
      for (const [category, mode] of Object.entries(changes.autonomy)) {
        if (mode === null) delete autonomy[category]
        else autonomy[category] = mode
        done.push(mode === null ? `${category}: back to propose` : `${category}: ${mode}`)
      }
      updateGoal(db, planId, { autonomy })
    }
    if (changes.tool_map && Object.keys(changes.tool_map).length) {
      const toolMap = { ...goal.tool_map }
      for (const [pattern, category] of Object.entries(changes.tool_map)) {
        if (category === null) delete toolMap[pattern]
        else toolMap[pattern] = category
        done.push(category === null ? `tool rule ${pattern} removed` : `tool rule ${pattern} → ${category}${category === UNTRUSTED_CATEGORY ? ' (reads outside content)' : ''}`)
      }
      updateGoal(db, planId, { tool_map: toolMap })
    }
    for (const [rawFrom, rawTo] of Object.entries(changes.merge_categories ?? {})) {
      const from = rawFrom.trim(), to = rawTo.trim()
      const items = db.prepare(`UPDATE tasks SET state = json_set(state, '$.action.category', ?)
        WHERE plan_id = ? AND json_extract(state, '$.action.category') = ?`).run(to, planId, from).changes
      const current = getGoal(db, planId)!
      const autonomy = { ...current.autonomy }
      if (from in autonomy) {
        if (!(to in autonomy)) autonomy[to] = autonomy[from]!
        delete autonomy[from]
      }
      const toolMap = Object.fromEntries(Object.entries(current.tool_map).map(([pattern, c]) => [pattern, c === from ? to : c]))
      updateGoal(db, planId, { autonomy, tool_map: toolMap })
      done.push(`merged ${from} into ${to} (${items} ${items === 1 ? 'item' : 'items'})`)
    }
    for (const m of changes.add_memory ?? []) {
      insertMemory(db, { plan_id: planId, kind: m.kind, text: m.text, source: 'human', pinned: m.pinned ?? false })
      done.push(`remembered (${m.kind}): ${m.text}`)
    }
    for (const id of changes.forget_memory ?? []) {
      updateMemory(db, id, { active: false })
      done.push(`forgot memory ${id}`)
    }
    const watches = listWatches(db, planId)
    for (const [name, spec] of Object.entries(changes.watches ?? {})) {
      if (spec === null) {
        if (removeWatch(db, planId, name)) done.push(`watch "${name.trim()}" removed`)
        continue
      }
      const before = watches.find((w) => w.name === name.trim())
      const after = setWatch(db, planId, name, spec) // throws on a watch with no command
      if (before && describeWatch(before) === describeWatch(after) && before.every_minutes === after.every_minutes && before.fires === after.fires
        && JSON.stringify(before.status_rules) === JSON.stringify(after.status_rules)) continue
      done.push(`watch "${after.name}" ${before ? 'changed' : 'added'}: every ${after.every_minutes} min, ${after.kind === 'tool' ? 'calls' : 'runs'} ${describeWatch(after)}${after.fires === 'change' ? ', starts a run when its output changes' : ''}${after.status_rules ? `, sets the status (${describeStatusRules(after.status_rules)})` : ''}`)
    }
    if (model !== undefined && model !== goal.model) {
      updateGoal(db, planId, { model })
      done.push(model ? `runs use ${model}` : "runs use the session's model")
    }
    if (gap !== undefined && gap !== goal.limits.min_watch_gap_minutes) {
      updateGoal(db, planId, { limits: { min_watch_gap_minutes: gap } })
      done.push(gap ? `watch runs at least ${gap} min apart (urgent watches excepted)` : 'no gap between watch runs')
    }
    if (changes.status && changes.status !== goal.status) {
      if (goal.status === 'retired') throw new GoalError('This goal is done; run it again first.')
      updateGoal(db, planId, { status: changes.status })
      done.push(changes.status === 'paused' ? 'paused' : 'resumed')
    }
  })()
  return done
}

// ── Holding runs while the usage limit is reached ─────────────────────────────

export interface RunHold {
  until: string
  reason: string
}

/** The hold on all goal runs, if one is still in force (an expired one is cleared). */
export function getRunHold(db: Database, now: Date = new Date()): RunHold | null {
  const row = db.prepare('SELECT until, reason FROM goal_run_hold WHERE id = 1').get() as RunHold | undefined
  if (!row) return null
  if (row.until <= now.toISOString()) {
    db.prepare('DELETE FROM goal_run_hold WHERE id = 1').run()
    return null
  }
  return row
}

export function setRunHold(db: Database, hold: RunHold): void {
  db.prepare('INSERT INTO goal_run_hold (id, until, reason) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET until = excluded.until, reason = excluded.reason')
    .run(hold.until, hold.reason)
}

export function clearRunHold(db: Database): void {
  db.prepare('DELETE FROM goal_run_hold WHERE id = 1').run()
}

const LIMIT = /(hit|reached) (your|the) .{0,30}limit|usage limit|rate limit|out of (credits|usage)/i
/** When the limit is lifted and the message doesn't say, try again after this long. */
export const DEFAULT_HOLD_MS = 30 * 60_000

/** Whether an agent's message says the person's usage limit is reached. */
export function isUsageLimit(text: string): boolean {
  return LIMIT.test(text)
}

/** "resets 8:10pm" → the next 8:10pm, local time, after `now`; null if the message names no time. */
export function parseLimitReset(text: string, now: Date = new Date()): Date | null {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const meridiem = m[3]?.toLowerCase()
  if (hour > 23 || minute > 59 || (meridiem && hour > 12)) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return at
}

/**
 * A run's agent finished a turn: if it stopped because the usage limit is
 * reached, the run is skipped (not failed) and all goal runs hold until the
 * reset. If it stopped on another error, the run fails with that message.
 * Otherwise nothing changes (the runner settles the run when its agent ends).
 */
/** A turn's token counts, as Claude Code reports them. */
export type RunUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string }

/** Adds a turn's tokens to its run (a run's agent may take several turns). */
export function addRunUsage(db: Database, runId: string, usage: RunUsage): void {
  db.prepare(`
    UPDATE goal_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?, model = COALESCE(?, model)
    WHERE id = ?
  `).run(usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usage.model ?? null, runId)
}

export function reportRunEnd(
  db: Database, runId: string, input: { answer: string; reason?: string; usage?: RunUsage }, now: Date = new Date(),
): { outcome: 'held' | 'failed' | 'unchanged'; hold?: RunHold } {
  const run = getRun(db, runId)
  if (!run) return { outcome: 'unchanged' }
  // Tokens count whatever the run's state: its last turn can end after end_run
  if (input.usage) addRunUsage(db, runId, input.usage)
  if (run.status !== 'running') return { outcome: 'unchanged' }
  const answer = input.answer.trim()
  if (isUsageLimit(answer)) {
    const until = (parseLimitReset(answer, now) ?? new Date(now.getTime() + DEFAULT_HOLD_MS)).toISOString()
    const hold = { until, reason: answer.split('\n')[0]!.slice(0, 200) }
    updateRun(db, runId, { status: 'skipped', skip_reason: `usage limit reached: ${hold.reason}`, ended_at: now.toISOString() })
    // The run never got to its watches' news: it queues a run again once the hold is over
    releaseWatchEvents(db, runId, { requeue: true })
    setRunHold(db, hold)
    return { outcome: 'held', hold }
  }
  if (input.reason === 'error') {
    failRun(db, runId, 'failed', `The agent stopped on an error: ${answer.slice(0, 300) || 'no message'}`)
    return { outcome: 'failed' }
  }
  return { outcome: 'unchanged' }
}

/**
 * What a running run's agent is doing, reported by the guard plugin as it sees
 * the agent's tool calls: `tool` a call starting, `waiting` a call put to the
 * person for a permission answer, `settled` a call that finished (allowed,
 * refused or answered). Quarterdeck's own tools aren't reported: their events say more.
 */
export type RunProgress = { event: 'tool' | 'waiting' | 'settled'; tool: string }

export function reportRunProgress(db: Database, runId: string, { event, tool }: RunProgress, now: Date = new Date()): { updated: boolean } {
  const run = getRun(db, runId)
  if (!run || run.status !== 'running') return { updated: false }
  const at = now.toISOString()
  if (event === 'tool') updateRun(db, runId, { now_tool: tool, now_tool_at: at })
  else if (event === 'waiting') updateRun(db, runId, { now_tool: tool, now_tool_at: at, waiting_tool: tool, waiting_since: at })
  else if (run.waiting_tool === tool) updateRun(db, runId, { waiting_tool: null, waiting_since: null })
  else return { updated: false }
  return { updated: true }
}
