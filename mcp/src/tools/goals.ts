/** MCP tools for persistent goals (specs/persistent-goals.md). */
import {
  listGoals, getGoal, buildBrief, addItem, stageProposalCalls, proposalCallsProblem, insertMemory, getMemory, forgetMemory, getRun, endRun, queueRun, queueRunWithRequest, countItems, touchPlan,
  reviveIfDone, recallMemory, buildCurationBrief, proposeCuration, proposeWatch, setRunStep,
} from '../db.js'
import { purgeDate } from '@quarterdeck/core'
import { getOpenPlan, setOpenPlan, getOpenRun, setOpenRun, scopedRunId } from '../session.js'
import {
  ListGoalsSchema, GetGoalBriefSchema, AddItemSchema, RememberSchema, ForgetSchema, RecallSchema, ProposeCurationSchema, ProposeWatchSchema, EndRunSchema, RunGoalSchema, RequestRunSchema, RunStepSchema,
} from '../schema.js'
import { record } from '../history.js'

function requireOpenGoal(): string {
  const planId = getOpenPlan()
  if (!planId || !getGoal(planId)) {
    throw new Error('No goal is open. Call get_goal_brief with the goal_id first.')
  }
  return planId
}

export async function list_goals(args: unknown) {
  const input = ListGoalsSchema.parse(args)
  const goals = listGoals({ status: input.status === 'all' ? undefined : input.status, deleted: input.deleted })
  return {
    goals: goals.map(({ plan, goal }) => {
      const counts = countItems(plan.id)
      return {
        id: plan.id,
        name: plan.name,
        objective: goal.objective,
        status: goal.status,
        ...(goal.deleted_at ? { deleted_at: goal.deleted_at, purge_at: purgeDate(goal) } : {}),
        open_items: counts.open ?? 0,
        awaiting_review: counts.awaiting_review ?? 0,
        last_run_at: goal.last_run_at,
        next_run_at: goal.next_run_at,
      }
    }),
  }
}

/**
 * The get_goal_brief tool: a memory curation run gets a brief of its own (all memory,
 * a longer run history, curation only); every other call gets the goal's brief.
 */
export async function goal_brief_tool(args: unknown) {
  const input = GetGoalBriefSchema.parse(args)
  if (input.run_id && getGoal(input.goal_id) && getRun(input.run_id)?.trigger === 'curate') {
    const curation = buildCurationBrief(input.goal_id, input.run_id)
    setOpenPlan(input.goal_id)
    setOpenRun(input.run_id)
    return curation
  }
  return get_goal_brief(args)
}

export async function get_goal_brief(args: unknown) {
  const input = GetGoalBriefSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found. Use list_goals.`)
  const brief = buildBrief(input.goal_id, input.run_id)
  setOpenPlan(input.goal_id)
  if (input.run_id) setOpenRun(input.run_id)
  return {
    ...brief,
    how_to_work: [
      'First carry out items with approved_to_execute (their action was approved), then complete them with set_status.',
      'Revise items rejected in decisions_since_last_run using the feedback: update the proposal with update_task state_patch {"action": {category, summary, params}} so the human sees the new version, then set_status completed to send it for review again — or abandon it with a reason.',
      'Look for new work; add each piece with add_item (use external_ref so it is never duplicated).',
      'For an action, reuse a category from known_categories when one fits it; invent a new category only for a different kind of action.',
      'Respect autonomy: "auto" categories you may do and then record with add_item; "propose" categories go through add_item and wait for approval; "off" categories you must not do.',
      'When the goal needs a watch it does not have (or a changed one), propose it with propose_watch for the person to approve, rather than asking them how to watch for it.',
      'Remember only what a later run needs and can find nowhere else: the person\'s answers and preferences, lasting facts and rules, and the state of work still in progress. Keep one entry per thing: when it changes (a running total, a deal\'s state), forget the old entry in the same run. Don\'t remember what you checked, skipped or did this run (your end_run summary keeps that), nor what a watch already tracks (it never shows the same line twice). Every memory is read by every later run. Finish with end_run and a short summary.',
      'memory holds what fits in the brief; memory_index lists the rest (memory_omitted counts them all) by id and how each starts. When one looks relevant to what you are doing, read it in full with recall (several ids in one call).',
      'When the status you set in end_run describes something outside Quarterdeck that can change without this goal running (a PR awaiting review, an open issue), attach a status_check so it updates by itself.',
    ],
  }
}

export async function add_item(args: unknown) {
  const parsed = AddItemSchema.parse(args)
  const calls = parsed.action?.calls
  const problem = calls ? proposalCallsProblem(calls) : null
  if (problem) throw new Error(problem)
  // The files' contents are staged, not stored in the item's state (#167)
  const input = parsed.action ? { ...parsed, action: { category: parsed.action.category, summary: parsed.action.summary, ...(parsed.action.params && { params: parsed.action.params }) } } : parsed
  const planId = requireOpenGoal()
  const result = addItem(planId, getOpenRun(), input)
  const staged = !result.existing && result.mode === 'propose' && calls && calls.length > 0
    ? stageProposalCalls(result.task, parsed.action!.category, calls) : undefined
  if (!result.existing) {
    touchPlan(planId)
    record(planId, result.task.id, 'task_created', {
      goal: result.task.goal,
      status: result.task.status,
      ...(input.external_ref && { external_ref: input.external_ref }),
      ...(input.action && { action: input.action, mode: result.mode }),
    })
    if (result.mode === 'propose') record(planId, result.task.id, 'approval_requested', { action: input.action })
  }
  return {
    item: {
      id: result.task.id,
      goal: result.task.goal,
      status: result.task.status,
      external_ref: result.task.external_ref,
      awaiting_review: result.task.review_requested_at !== null,
    },
    existing: result.existing,
    ...(result.mode && { mode: result.mode }),
    ...(staged && { staged_calls: staged }),
    message: result.existing
      ? 'An item for this external_ref already exists; nothing was created. Update it instead if needed.'
      : result.untrusted
      ? `Proposed instead of done: this run has read untrusted content (${result.untrusted}), so its auto actions need approval for the rest of the run. Do not carry it out until it shows approved_to_execute.`
      : result.mode === 'propose'
      ? 'Proposed:waits for the human to approve. Do not carry out the action until it shows approved_to_execute.'
      : result.mode === 'auto'
      ? 'Recorded as done.'
      : 'Item created.',
    ...(result.similar_categories && {
      note: `"${input.action!.category}" is a new category for this goal, but it already has ${result.similar_categories.map((c) => `"${c}"`).join(', ')}. If this is the same kind of action, use that name next time so approvals count together.`,
    }),
  }
}

export async function remember(args: unknown) {
  const input = RememberSchema.parse(args)
  const planId = requireOpenGoal()
  const runId = getOpenRun()
  if (runId && getRun(runId)?.trigger === 'curate') throw new Error('A memory curation run changes memory only through propose_curation, which the person approves.')
  // A run that has read outside content passes its mark on: the run whose brief hands this out is marked too
  const run = runId ? getRun(runId) : undefined
  const untrusted = run?.untrusted_source ?? null
  const m = insertMemory({ plan_id: planId, kind: input.kind, text: input.text, source: 'agent', source_ref: input.source_ref ?? runId, untrusted_source: untrusted, untrusted_root: run?.untrusted_root ?? null })
  record(planId, planId, 'memory_added', { memory_id: m.id, kind: m.kind, text: m.text })
  return { memory: { id: m.id, kind: m.kind, text: m.text, ...(untrusted && { untrusted: true }) } }
}

/**
 * A running run says which part of the job it is on (#146). Only its own agent:
 * the call's run_scope must name the run. Shown in the Goals pane, the status
 * line and the web goal page while the run goes on; never on the phone or as an alert.
 */
export async function run_step(args: unknown) {
  const { goal_id, run_id, text } = RunStepSchema.parse(args)
  if (scopedRunId() !== run_id) throw new Error('Only the run itself sets its step: pass run_scope set to your run id.')
  const run = getRun(run_id)
  if (!run || run.plan_id !== goal_id) throw new Error(`Run ${run_id} is not a run of goal ${goal_id}.`)
  const r = setRunStep(run_id, text)
  if (r.changed) record(goal_id, goal_id, 'step_set', { run_id, text: r.step })
  return { step: r.step, changed: r.changed, ...(r.untrusted && { untrusted: true }) }
}

/** A run proposes a watch: it waits under Needs you and nothing runs until the person approves it. */
export async function propose_watch(args: unknown) {
  const { name, reason, ...spec } = ProposeWatchSchema.parse(args)
  const planId = requireOpenGoal()
  const task = proposeWatch(planId, getOpenRun(), { name, reason, spec: spec as never })
  touchPlan(planId)
  record(planId, task.id, 'task_created', { goal: task.goal, status: task.status, external_ref: task.external_ref })
  record(planId, task.id, 'approval_requested', { watch: name })
  return { item: { id: task.id, goal: task.goal, awaiting_review: true }, message: 'Proposed: no watch exists until the person approves it. Carry on with what you can, then finish with end_run.' }
}

/** A memory curation run's one proposal: it waits under Needs you, and the server applies it on Approve. */
export async function propose_curation(args: unknown) {
  const input = ProposeCurationSchema.parse(args)
  const planId = requireOpenGoal()
  const task = proposeCuration(planId, getOpenRun(), input.changes)
  touchPlan(planId)
  record(planId, task.id, 'task_created', { goal: task.goal, status: task.status, external_ref: task.external_ref })
  record(planId, task.id, 'approval_requested', { curation: input.changes })
  return {
    item: { id: task.id, goal: task.goal, awaiting_review: true },
    message: 'Proposed: it waits for the person, and the server applies it if they approve. Finish with end_run.',
  }
}

/** A read, like get_goal_brief: it writes no history entry (only last_used_at, and the run's mark). */
export async function recall(args: unknown) {
  const input = RecallSchema.parse(args)
  const planId = requireOpenGoal()
  return { memory: recallMemory(planId, getOpenRun(), input.memory_ids) }
}

export async function forget(args: unknown) {
  const input = ForgetSchema.parse(args)
  const planId = requireOpenGoal()
  const m = getMemory(input.memory_id)
  if (!m || m.plan_id !== planId) throw new Error(`Memory ${input.memory_id} not found in this goal.`)
  if (m.source !== 'agent') {
    throw new Error('You can only forget memories an agent created. Human-written and feedback memories are edited by the human in the web UI.')
  }
  forgetMemory(m.id)
  record(planId, planId, 'memory_forgotten', { memory_id: m.id, text: m.text })
  return { forgotten: m.id }
}

export async function end_run(args: unknown) {
  const input = EndRunSchema.parse(args)
  const planId = requireOpenGoal()
  const runId = input.run_id ?? getOpenRun()
  if (!runId) throw new Error('No run to end: you were not started for a run (get_goal_brief had no run_id).')
  const run = getRun(runId)
  if (!run || run.plan_id !== planId) throw new Error(`Run ${runId} not found in this goal.`)
  const ended = endRun(runId, input.summary, input.status, input.status_check, input.status_tone)
  setOpenRun(null)
  record(planId, planId, 'run_completed', { run_id: runId, summary: ended.summary, items_created: ended.items_created, items_resolved: ended.items_resolved })
  return {
    run: { id: ended.id, status: ended.status, items_created: ended.items_created, items_resolved: ended.items_resolved },
    message: 'Run ended. Finish with a one-line final message (your summary is saved).',
  }
}

/** Queues a run, with the prompt as its request when there is one, and records it. */
function queueRequested(goalId: string, prompt: string | undefined, untrusted: boolean) {
  if (!getGoal(goalId)) throw new Error(`Goal ${goalId} not found.`)
  reviveIfDone(goalId) // a done one-off runs again
  let run
  if (prompt !== undefined) {
    const queued = queueRunWithRequest(goalId, prompt, { untrusted })
    if ('reason' in queued) throw new Error(queued.reason)
    run = queued.run
  } else run = queueRun(goalId)
  record(goalId, goalId, 'run_requested', { run_id: run.id, prompt: prompt ?? null, ...(prompt !== undefined && { untrusted }) })
  return run
}

/** The plugin's Run with a prompt (pane box, or its run_goal once the person confirmed the quoted prompt): a trusted request. */
export async function request_run(args: unknown) {
  const input = RequestRunSchema.parse(args)
  const run = queueRequested(input.goal_id, input.prompt, false)
  return { run: { id: run.id, status: run.status } }
}

export async function run_goal(args: unknown) {
  const input = RunGoalSchema.parse(args)
  // A prompt typed here is one the person doesn't see: stored untrusted, so the run treats it as information
  const run = queueRequested(input.goal_id, input.prompt, true)
  return {
    run: { id: run.id, status: run.status },
    message: run.status === 'queued'
      ? 'Queued. The quarterdeck-goals plugin starts it within about 30 seconds while Claude Code is open (or the web app does, if it runs with QUARTERDECK_WEB_RUNS=1).'
      : 'This goal already has a run in progress.',
  }
}
