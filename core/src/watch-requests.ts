/**
 * A run proposes a watch; the person approves it. A watch is a command or tool call that runs
 * unattended, so a run can never set one itself: propose_watch writes a request under Needs you,
 * and the server applies exactly the spec the person saw when they Approve (the way memory
 * curation works).
 */
import type { Database } from './sqlite.js'
import { getTask, insertTask, nextChildId, getAllTasks, updateTask } from './queries.js'
import { approveTask, rejectTask } from './gates.js'
import { getRun } from './goals.js'
import { GoalError } from './goal-engine.js'
import type { WatchCall, WatchStep } from './types.js'
import { describeStatusRules, describeWatch, listWatches, setWatch, validateWatchSpec } from './watches.js'
import type { Task, Watch, WatchSpec } from './types.js'

/** A watch request's external_ref starts with this, then the watch's name, the run's id and the item's id. */
export const WATCH_REF = 'watch:'

export interface WatchRequestState {
  name: string
  spec: WatchSpec
  reason: string | null
  /** The watch this replaces, as it was when proposed; null for a new one. */
  replaces: WatchSpec | null
  run_id: string
}

/** A watch in the shape of the spec that sets it. */
function specOf(w: Watch): WatchSpec {
  // ignore and urgent only when set, so a watch without them reads as it did before they existed
  const base = { every_minutes: w.every_minutes, fires: w.fires, status: w.status_rules, ...(w.ignore ? { ignore: w.ignore } : {}), ...(w.urgent ? { urgent: true } : {}) }
  if (w.kind === 'tool' && w.steps) return { steps: w.steps, ...(w.finally ? { finally: w.finally } : {}), ...(w.match ? { match: w.match } : {}), ...base }
  return w.kind === 'tool'
    ? { tool: w.tool!, input: w.tool_input, ...(w.match ? { match: w.match } : {}), ...base }
    : { command: w.command!, ...(w.match ? { match: w.match } : {}), ...base }
}

function describeSpec(spec: WatchSpec): string {
  const s = spec as { command?: string; tool?: string; steps?: WatchStep[]; finally?: WatchCall; input?: Record<string, unknown>; match?: string; ignore?: string | null; urgent?: boolean; every_minutes?: number; fires?: string; status?: never }
  const isTool = s.tool !== undefined || s.steps !== undefined
  const what = describeWatch({ kind: isTool ? 'tool' : 'command', command: s.command ?? null, tool: s.tool ?? null, tool_input: s.input ?? {}, steps: s.steps ?? null, finally: s.finally ?? null, match: s.match ?? null, ignore: s.ignore ?? null, urgent: s.urgent === true })
  const rules = (spec as { status?: Parameters<typeof describeStatusRules>[0] | null }).status
  return [`${s.steps !== undefined ? 'Tool sequence' : s.tool !== undefined ? 'Tool' : 'Command'}: ${what}`, `Every ${s.every_minutes ?? 'default'} min, fires on ${s.fires ?? 'new'} lines`, ...(rules ? [`Status: ${describeStatusRules(rules)}`] : [])].join('\n')
}

export function isWatchRequest(task: Task): boolean {
  return Boolean(task.external_ref?.startsWith(WATCH_REF) && (task.state as { watch?: unknown } | null)?.watch)
}

/** Writes the request. Refuses what update_goal's watches refuses, or a name with a request already waiting. */
export function proposeWatch(db: Database, planId: string, runId: string | null, input: { name: string; spec: WatchSpec; reason?: string }): Task {
  const run = runId ? getRun(db, runId) : undefined
  if (!run || run.plan_id !== planId || run.status !== 'running') throw new GoalError('propose_watch needs an open run of this goal.')
  if (run.trigger === 'curate') throw new GoalError("A memory curation run does none of the goal's work: propose your cleanup with propose_curation.")
  const { label, warnings } = validateWatchSpec(db, planId, input.name, input.spec)
  const waiting = getAllTasks(db, planId).find((t) => isWatchRequest(t) && (t.state as { watch: WatchRequestState }).watch.name === label && t.review_requested_at)
  if (waiting) throw new GoalError(`A request for the watch "${label}" is already waiting (item ${waiting.id}).`)
  const existing = listWatches(db, planId).find((w) => w.name === label)
  const state: WatchRequestState = { name: label, spec: input.spec, reason: input.reason?.trim() || null, replaces: existing ? specOf(existing) : null, run_id: run.id }
  const notes = [
    ...(state.replaces ? [`Now:\n${describeSpec(state.replaces)}`, `Proposed:\n${describeSpec(state.spec)}`] : [describeSpec(state.spec)]),
    ...(state.reason ? [`Why: ${state.reason}`] : []),
    ...warnings.map((w) => `Warning: ${w}`),
  ].join('\n\n')
  const now = new Date().toISOString()
  const id = nextChildId(db, planId, null)
  insertTask(db, {
    id, plan_id: planId, goal: `${state.replaces ? 'Replace' : 'Add'} the watch "${label}"`,
    result: null, abandon_reason: null, depends_on: null, notes, run_id: run.id, external_ref: `${WATCH_REF}${label}:${run.id}:${id}`,
    created_by: 'agent', created_at: now, updated_at: now, status: 'active', state: { watch: state }, requires_approval: true, review_requested_at: now,
  })
  return getTask(db, planId, id)!
}

/** Approve: sets the watch as proposed. Refused whole (item left waiting) when the watch changed since, or the spec no longer validates. */
export function applyWatchRequest(db: Database, planId: string, taskId: string): Watch {
  const task = getTask(db, planId, taskId)
  if (!task || !isWatchRequest(task)) throw new GoalError(`Item ${taskId} is not a watch request.`)
  if (!task.review_requested_at) throw new GoalError(`Item ${taskId} is not waiting for review.`)
  const state = (task.state as { watch: WatchRequestState }).watch
  const now = listWatches(db, planId).find((w) => w.name === state.name)
  if (JSON.stringify(now ? specOf(now) : null) !== JSON.stringify(state.replaces)) {
    throw new GoalError(`The watch "${state.name}" changed since it was proposed: reject this request and ask for a new one.`)
  }
  return db.transaction(() => {
    const watch = setWatch(db, planId, state.name, state.spec)
    approveTask(db, planId, taskId)
    updateTask(db, planId, taskId, { status: 'completed', result: 'Watch set', updated_at: new Date().toISOString() })
    return watch
  })()
}

/** Reject: no watch; the item completes with the feedback, which also becomes feedback memory. */
export function rejectWatchRequest(db: Database, planId: string, taskId: string, feedback: string): void {
  const task = getTask(db, planId, taskId)
  if (!task || !isWatchRequest(task)) throw new GoalError(`Item ${taskId} is not a watch request.`)
  db.transaction(() => {
    rejectTask(db, planId, taskId, feedback)
    updateTask(db, planId, taskId, { status: 'abandoned', abandon_reason: `Rejected: ${feedback.trim()}`, updated_at: new Date().toISOString() })
  })()
}
