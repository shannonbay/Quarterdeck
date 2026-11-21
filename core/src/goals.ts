/**
 * Persistent goals — storage. A goal is a plan with kind = 'goal' plus a row
 * in `goals`; its work items are ordinary tasks. See specs/persistent-goals.md.
 */
import type { Database } from './sqlite.js'
import { randomUUID } from 'crypto'
import { insertPlan, getPlan } from './queries.js'
import {
  DEFAULT_GOAL_LIMITS,
  type Goal, type GoalLimits, type GoalMemory, type GoalRun, type GoalTrigger, type IntervalConfig,
  type MemoryKind, type MemorySource, type NewGoal, type NewPlan, type PlanRow, type RunStatus, type TriggerKind,
} from './types.js'

type Row = Record<string, unknown>

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

// ── Goals ─────────────────────────────────────────────────────────────────────

function deserializeGoal(r: Row): Goal {
  return {
    ...r,
    autonomy: JSON.parse((r.autonomy as string) || '{}'),
    limits: { ...DEFAULT_GOAL_LIMITS, ...JSON.parse((r.limits as string) || '{}') },
    tool_map: JSON.parse((r.tool_map as string) || '{}'),
    health_command: (r.health_command as string | null | undefined) ?? null,
    health_every_minutes: (r.health_every_minutes as number | undefined) ?? 60,
    health_triggers_run: r.health_triggers_run === undefined ? true : Boolean(r.health_triggers_run),
    last_health_at: (r.last_health_at as string | null | undefined) ?? null,
    one_off: Boolean(r.one_off),
    model: (r.model as string | null | undefined) ?? null,
    status_note: (r.status_note as string | null | undefined) ?? null,
    status_note_at: (r.status_note_at as string | null | undefined) ?? null,
    status_note_untrusted: (r.status_note_untrusted as string | null | undefined) ?? null,
    status_check: r.status_check ? JSON.parse(r.status_check as string) : null,
    status_check_at: (r.status_check_at as string | null | undefined) ?? null,
    status_check_failures: (r.status_check_failures as number | undefined) ?? 0,
    status_tone: (r.status_tone as Goal['status_tone'] | undefined) ?? null,
    status_source: (r.status_source as string | null | undefined) ?? null,
    resumed_at: (r.resumed_at as string | null | undefined) ?? null,
    curated_at: (r.curated_at as string | null | undefined) ?? null,
    deleted_at: (r.deleted_at as string | null | undefined) ?? null,
  } as Goal
}

/** Creates the plan (kind 'goal') and its goal row together. */
export function createGoal(db: Database, plan: NewPlan, goal: Omit<NewGoal, 'plan_id'>, interval?: IntervalConfig): Goal {
  db.transaction(() => {
    insertPlan(db, { ...plan, kind: 'goal' })
    db.prepare(`
      INSERT INTO goals (plan_id, objective, instructions, status, autonomy, limits, item_retention_days, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      goal.objective,
      goal.instructions ?? '',
      goal.status ?? 'active',
      JSON.stringify(goal.autonomy ?? {}),
      JSON.stringify({ ...DEFAULT_GOAL_LIMITS, ...goal.limits }),
      goal.item_retention_days ?? 7,
      null,
      interval ? new Date().toISOString() : null,
    )
    if (interval) setIntervalTrigger(db, plan.id, interval)
    if (goal.one_off) db.prepare('UPDATE goals SET one_off = 1 WHERE plan_id = ?').run(plan.id)
    if (goal.model) db.prepare('UPDATE goals SET model = ? WHERE plan_id = ?').run(normalizeModel(goal.model), plan.id)
  })()
  return getGoal(db, plan.id)!
}

/** The aliases a goal's model may be, besides a full id. */
export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const

/**
 * A model as stored: an alias in lower case, a full id as given, or null for
 * "the session's model" (null, "", "inherit", "default"). Throws on anything
 * that can't be a model name.
 */
export function normalizeModel(model: string | null | undefined): string | null {
  const m = (model ?? '').trim()
  if (!m || /^(inherit|default|session)$/i.test(m)) return null
  if ((MODEL_ALIASES as readonly string[]).includes(m.toLowerCase())) return m.toLowerCase()
  if (m.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:@/\[\]-]*$/.test(m)) {
    throw new Error(`"${m}" isn't a model: use haiku, sonnet, opus, fable, a full model id, or null for the session's model.`)
  }
  return m
}

export function getGoal(db: Database, planId: string): Goal | undefined {
  const row = db.prepare('SELECT * FROM goals WHERE plan_id = ?').get(planId) as Row | undefined
  return row ? deserializeGoal(row) : undefined
}

/** Which goals a list shows by whether they are deleted: hide them (the default), only them, or all. */
export type DeletedFilter = 'exclude' | 'only' | 'include'

export interface GoalFilter {
  status?: Goal['status']
  deleted?: DeletedFilter
}

/** Lists goals; deleted goals are left out unless `deleted` asks for them. */
export function listGoals(db: Database, filter?: Goal['status'] | GoalFilter): { plan: PlanRow; goal: Goal }[] {
  const { status, deleted = 'exclude' }: GoalFilter = typeof filter === 'string' ? { status: filter } : (filter ?? {})
  const where: string[] = []
  const args: string[] = []
  if (status) { where.push('status = ?'); args.push(status) }
  if (deleted === 'exclude') where.push('deleted_at IS NULL')
  else if (deleted === 'only') where.push('deleted_at IS NOT NULL')
  const rows = db.prepare(`SELECT * FROM goals${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).all(...args) as Row[]
  return rows
    .map((r) => ({ plan: getPlan(db, r.plan_id as string)!, goal: deserializeGoal(r) }))
    .filter((g) => g.plan)
}

export function updateGoal(
  db: Database,
  planId: string,
  fields: Partial<Omit<Goal, 'plan_id' | 'limits'>> & { limits?: Partial<GoalLimits> },
): void {
  const current = getGoal(db, planId)
  if (!current) throw new Error(`Goal ${planId} not found`)
  if (current.deleted_at && fields.status === 'active') throw new Error(DELETED_GOAL_MESSAGE)
  const serialized: Row = { ...fields }
  if (fields.autonomy) serialized.autonomy = JSON.stringify(fields.autonomy)
  if (fields.tool_map) serialized.tool_map = JSON.stringify(fields.tool_map)
  if ('status_check' in fields) serialized.status_check = fields.status_check ? JSON.stringify(fields.status_check) : null
  if ('health_triggers_run' in fields) serialized.health_triggers_run = fields.health_triggers_run ? 1 : 0
  if ('one_off' in fields) serialized.one_off = fields.one_off ? 1 : 0
  if (fields.limits) serialized.limits = JSON.stringify({ ...current.limits, ...fields.limits })
  // Every resume comes through here (pane, /goal-resume, update_goal, the web page, Run again)
  const resuming = fields.status === 'active' && current.status !== 'active'
  const now = new Date().toISOString()
  if (resuming) serialized.resumed_at = now
  const entries = Object.entries(serialized)
  if (!entries.length) return
  db.prepare(`UPDATE goals SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE plan_id = ?`)
    .run(...entries.map(([, v]) => v), planId)
  // Resuming answers the runaway breaker's "Resume it?", so it leaves Needs you
  if (resuming) {
    db.prepare("UPDATE tasks SET status = 'completed', result = 'Resumed', updated_at = ? WHERE plan_id = ? AND external_ref = ? AND status IN ('pending', 'active')")
      .run(now, planId, RUNAWAY_REF)
  }
}

/** The external_ref of a goal's one runaway-breaker question (reopened each time the breaker trips). */
export const RUNAWAY_REF = 'runaway-breaker'
/** A memory curation request's external_ref starts with this, then the curation run's id (curation.ts). */
export const CURATION_REF = 'memory-curation:'

// ── Triggers ──────────────────────────────────────────────────────────────────

function deserializeTrigger(r: Row): GoalTrigger {
  return { ...r, config: JSON.parse(r.config as string), enabled: Boolean(r.enabled) } as GoalTrigger
}

export function listTriggers(db: Database, planId: string): GoalTrigger[] {
  return (db.prepare('SELECT * FROM goal_triggers WHERE plan_id = ?').all(planId) as Row[]).map(deserializeTrigger)
}

export function getIntervalTrigger(db: Database, planId: string): (GoalTrigger & { config: IntervalConfig }) | undefined {
  return listTriggers(db, planId).find((t) => t.kind === 'interval') as (GoalTrigger & { config: IntervalConfig }) | undefined
}

/** Phase 1 has at most one interval trigger per goal; null removes it. */
export function setIntervalTrigger(db: Database, planId: string, config: IntervalConfig | null): void {
  const existing = getIntervalTrigger(db, planId)
  if (!config) {
    if (existing) db.prepare('DELETE FROM goal_triggers WHERE id = ?').run(existing.id)
    return
  }
  if (!(config.minutes >= 1)) throw new Error('Interval must be at least 1 minute.')
  if (config.active_hours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.active_hours)) {
    throw new Error('active_hours must look like "08:00-20:00".')
  }
  if (existing) {
    db.prepare('UPDATE goal_triggers SET config = ?, enabled = 1 WHERE id = ?').run(JSON.stringify(config), existing.id)
  } else {
    db.prepare('INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, ?, ?, 1)')
      .run(newId('trg'), planId, 'interval', JSON.stringify(config))
  }
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export function insertRun(db: Database, planId: string, trigger: TriggerKind, status: RunStatus = 'queued', skipReason?: string): GoalRun {
  const now = new Date().toISOString()
  const run: GoalRun = {
    id: newId('run'), plan_id: planId, trigger, status, session_id: null, cc_session_id: null, holder: null, agent_id: null, summary: null,
    skip_reason: skipReason ?? null, items_created: 0, items_resolved: 0, self_caused: 0, watch_rechecked_at: null, started_at: now,
    ended_at: status === 'skipped' ? now : null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, model: null,
    now_tool: null, now_tool_at: null, waiting_tool: null, waiting_since: null, untrusted_at: null, untrusted_source: null, untrusted_root: null,
    request: null, request_untrusted: 0, step: null, step_at: null, step_untrusted: null,
  }
  db.prepare(`
    INSERT INTO goal_runs (id, plan_id, trigger, status, session_id, summary, skip_reason, items_created, items_resolved, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.plan_id, run.trigger, run.status, null, null, run.skip_reason, 0, 0, run.started_at, run.ended_at)
  return run
}

export function getRun(db: Database, runId: string): GoalRun | undefined {
  return db.prepare('SELECT * FROM goal_runs WHERE id = ?').get(runId) as GoalRun | undefined
}

export function updateRun(db: Database, runId: string, fields: Partial<Omit<GoalRun, 'id' | 'plan_id'>>): void {
  // A run that stops running never leaves its step on screen (#146)
  const ended = fields.status !== undefined && fields.status !== 'running' && fields.status !== 'queued'
  const entries = Object.entries(ended ? { step: null, step_at: null, step_untrusted: null, ...fields } : fields)
  if (!entries.length) return
  db.prepare(`UPDATE goal_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), runId)
}

/**
 * The source that marks a run handed watch events. It is the weakest mark: a later
 * read replaces it, and a status set by a run marked only by it shows no ⚠ on the
 * goal's line (the pane's card says so instead).
 */
export const WATCH_EVENTS_SOURCE = 'watch events'
/** How a run marked by an earlier run's summary names it: "run summary <run id> (written after …)" (buildBrief). */
export const RUN_SUMMARY_SOURCE = 'run summary '

/**
 * Marks a run as having read untrusted content. The first source is kept, except
 * that a mark inherited from a run summary gives way to any outside read, and watch
 * events to any other outside read (keeping when the run was first marked): a run
 * whose own summary should pass the mark on must say it read outside content itself.
 * From then on its `auto` categories need approval (guard.ts, addItem).
 * `root` is the original outside read behind the mark (the source itself for a direct
 * read), set with the source so a mark inherited from memory can name it (#52).
 */
export function markRunUntrusted(db: Database, runId: string, source: string, root: string = source): void {
  const summary = `${RUN_SUMMARY_SOURCE}%`
  db.prepare(`UPDATE goal_runs SET untrusted_at = COALESCE(untrusted_at, ?), untrusted_source = ?, untrusted_root = ?
    WHERE id = ? AND (untrusted_at IS NULL
      OR (untrusted_source LIKE ? AND ? NOT LIKE ?)
      OR (untrusted_source = ? AND ? <> ? AND ? NOT LIKE ?))`)
    .run(new Date().toISOString(), source, root, runId, summary, source, summary, WATCH_EVENTS_SOURCE, source, WATCH_EVENTS_SOURCE, source, summary)
}

/** Runs newest first. */
export function listRuns(db: Database, planId: string, limit = 20, opts: { includeSkipped?: boolean } = {}): GoalRun[] {
  const where = opts.includeSkipped === false ? "AND status != 'skipped'" : ''
  return db.prepare(`SELECT * FROM goal_runs WHERE plan_id = ? ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(planId, limit) as GoalRun[]
}

/** The queued or running run for a goal, if any. */
export function getOpenRun(db: Database, planId: string): GoalRun | undefined {
  return db.prepare("SELECT * FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running') ORDER BY started_at LIMIT 1")
    .get(planId) as GoalRun | undefined
}

export function countRunsSince(db: Database, planId: string, sinceIso: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE plan_id = ? AND status != 'skipped' AND started_at >= ?")
    .get(planId, sinceIso) as { n: number }).n
}

// ── Memory ────────────────────────────────────────────────────────────────────

function deserializeMemory(r: Row): GoalMemory {
  return { ...r, pinned: Boolean(r.pinned), active: Boolean(r.active) } as GoalMemory
}

export function insertMemory(
  db: Database,
  m: { plan_id: string; kind: MemoryKind; text: string; source: MemorySource; source_ref?: string | null; pinned?: boolean; untrusted_source?: string | null; untrusted_root?: string | null },
): GoalMemory {
  const text = m.text.trim()
  if (!text) throw new Error('Memory text is required.')
  const row = {
    id: newId('mem'), plan_id: m.plan_id, kind: m.kind, text, source: m.source,
    source_ref: m.source_ref ?? null, pinned: m.pinned ? 1 : 0, active: 1,
    created_at: new Date().toISOString(), last_used_at: null,
    // Only an agent's memory can carry what its run had read
    untrusted_source: m.source === 'agent' ? m.untrusted_source ?? null : null,
    untrusted_root: m.source === 'agent' && m.untrusted_source ? m.untrusted_root ?? m.untrusted_source : null,
  }
  db.prepare(`
    INSERT INTO goal_memory (id, plan_id, kind, text, source, source_ref, pinned, active, created_at, last_used_at, untrusted_source, untrusted_root)
    VALUES (@id, @plan_id, @kind, @text, @source, @source_ref, @pinned, @active, @created_at, @last_used_at, @untrusted_source, @untrusted_root)
  `).run(row)
  return deserializeMemory(row)
}

export function getMemory(db: Database, id: string): GoalMemory | undefined {
  const r = db.prepare('SELECT * FROM goal_memory WHERE id = ?').get(id) as Row | undefined
  return r ? deserializeMemory(r) : undefined
}

export function listMemory(db: Database, planId: string, opts: { activeOnly?: boolean } = {}): GoalMemory[] {
  const rows = db.prepare(`SELECT * FROM goal_memory WHERE plan_id = ? ${opts.activeOnly ? 'AND active = 1' : ''} ORDER BY created_at, rowid`)
    .all(planId) as Row[]
  return rows.map(deserializeMemory)
}

export function updateMemory(db: Database, id: string, fields: Partial<Pick<GoalMemory, 'kind' | 'text' | 'pinned' | 'active' | 'last_used_at' | 'untrusted_source' | 'untrusted_root'>>): void {
  const serialized: Row = { ...fields }
  if ('pinned' in fields) serialized.pinned = fields.pinned ? 1 : 0
  if ('active' in fields) serialized.active = fields.active ? 1 : 0
  if (typeof fields.text === 'string') {
    if (!fields.text.trim()) throw new Error('Memory text is required.')
    serialized.text = fields.text.trim()
  }
  const entries = Object.entries(serialized)
  if (!entries.length) return
  db.prepare(`UPDATE goal_memory SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), id)
}

/** Forgets a memory: it goes inactive (kept, restorable) until its goal is purged. */
export function forgetMemory(db: Database, id: string): void {
  db.prepare(`UPDATE goal_memory SET active = 0, inactive_reason = 'forgotten', inactive_at = ?, inactive_ref = NULL WHERE id = ?`)
    .run(new Date().toISOString(), id)
}

/** @deprecated Forgetting keeps the row; use forgetMemory. */
export const deleteMemory = forgetMemory

/**
 * Puts an inactive memory back to active and clears why it went. A newer memory
 * that merged or rewrote it is left alone: the person decides which to keep.
 */
export function restoreMemory(db: Database, id: string): GoalMemory {
  const m = getMemory(db, id)
  if (!m) throw new Error(`Memory ${id} not found.`)
  if (!m.active) {
    db.prepare('UPDATE goal_memory SET active = 1, inactive_reason = NULL, inactive_at = NULL, inactive_ref = NULL, replaced_by = NULL WHERE id = ?').run(id)
  }
  return getMemory(db, id)!
}

/** Marks a memory inactive and records why (curation merge, retire or rewrite). */
export function retireMemory(
  db: Database, id: string,
  why: { reason: 'merged' | 'retired' | 'rewritten'; ref?: string | null; replaced_by?: string | null },
): void {
  db.prepare('UPDATE goal_memory SET active = 0, inactive_reason = ?, inactive_at = ?, inactive_ref = ?, replaced_by = ? WHERE id = ?')
    .run(why.reason, new Date().toISOString(), why.ref ?? null, why.replaced_by ?? null, id)
}

/** The tables that hold a goal's rows, children before the plan itself. */
const GOAL_TABLES = [
  'goal_item_attempts', 'goal_watch_events', 'goal_watches', 'goal_tool_calls', 'goal_health', 'goal_memory', 'goal_runs', 'goal_triggers', 'verifications',
  'events', 'transcript_messages', 'agent_sessions', 'tasks', 'goals',
]

/** The refusal for anything that would run or resume a deleted goal. */
export const DELETED_GOAL_MESSAGE = 'This goal is deleted: restore it first.'

/** Days a deleted goal is kept before it is purged: QUARTERDECK_DELETED_RETENTION_DAYS, default 30; 0 never purges automatically. */
export function deletedRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.QUARTERDECK_DELETED_RETENTION_DAYS
  if (raw === undefined || raw.trim() === '') return 30
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30
}

/** When a deleted goal will be purged, or null when it isn't deleted or retention is 0. */
export function purgeDate(goal: Pick<Goal, 'deleted_at'>, days = deletedRetentionDays()): string | null {
  if (!goal.deleted_at || days <= 0) return null
  return new Date(new Date(goal.deleted_at).getTime() + days * 86_400_000).toISOString()
}

function goalPlan(db: Database, planId: string): { name: string } {
  const plan = db.prepare("SELECT name, kind FROM plans WHERE id = ?").get(planId) as { name: string; kind: string } | undefined
  if (!plan || plan.kind !== 'goal') throw new Error(`Goal ${planId} not found.`)
  return { name: plan.name }
}

function refuseWhileRunning(db: Database, planId: string): void {
  const running = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running')").get(planId)
  if (running) throw new Error('This goal has a run in progress: cancel it first, then delete the goal.')
}

/**
 * Deletes a goal so it can be restored: it is paused and hidden, keeping its
 * items, runs, memory and history until it is purged (after the retention
 * period, or by purgeGoal). Refused while a run is going (cancel it first).
 */
export function deleteGoal(db: Database, planId: string, now = new Date()): { name: string; deleted_at: string } {
  const plan = goalPlan(db, planId)
  refuseWhileRunning(db, planId)
  const current = getGoal(db, planId)
  if (current?.deleted_at) return { name: plan.name, deleted_at: current.deleted_at }
  const deleted_at = now.toISOString()
  db.prepare("UPDATE goals SET deleted_at = ?, status = 'paused' WHERE plan_id = ?").run(deleted_at, planId)
  db.prepare('UPDATE plans SET revision = revision + 1 WHERE id = ?').run(planId)
  return { name: plan.name, deleted_at }
}

/** Puts a deleted goal back, paused: nothing runs until the person resumes it. */
export function restoreGoal(db: Database, planId: string): { name: string } {
  const plan = goalPlan(db, planId)
  if (!getGoal(db, planId)?.deleted_at) throw new Error('This goal is not deleted.')
  db.prepare("UPDATE goals SET deleted_at = NULL, status = 'paused' WHERE plan_id = ?").run(planId)
  db.prepare('UPDATE plans SET revision = revision + 1 WHERE id = ?').run(planId)
  return plan
}

/**
 * Erases a goal for good: its items, runs, memory, schedule, health checks,
 * guard decisions and history. Refused while a run is going (cancel it first).
 * Outside the retention purge, callers purge only a goal that is already deleted.
 */
export function purgeGoal(db: Database, planId: string): { name: string } {
  const plan = goalPlan(db, planId)
  refuseWhileRunning(db, planId)
  db.transaction(() => {
    for (const table of GOAL_TABLES) db.prepare(`DELETE FROM ${table} WHERE plan_id = ?`).run(planId)
    db.prepare('DELETE FROM plans WHERE id = ?').run(planId)
  })()
  return plan
}

/** Purges deleted goals older than the retention period; returns the ids purged. */
export function purgeExpiredGoals(db: Database, now = new Date(), days = deletedRetentionDays()): string[] {
  if (days <= 0) return []
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
  const ids = (db.prepare('SELECT plan_id FROM goals WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff) as { plan_id: string }[]).map((r) => r.plan_id)
  const purged: string[] = []
  for (const id of ids) {
    try { purgeGoal(db, id); purged.push(id) } catch { /* a run still going: a later pass tries again */ }
  }
  return purged
}
