import { getTask, updateTask, touchPlan, recordItemAttempt, stageProposalCalls, clearProposalCalls, proposalCallsProblem, proposalHasCalls } from '../db.js'
import type { ProposalCall } from '@quarterdeck/core'
import { getOpenPlan, getOpenRun } from '../session.js'
import { buildContext } from '../context.js'
import { UpdateTaskSchema } from '../schema.js'
import { record } from '../history.js'
import { gateFieldsFrom } from '../gates.js'

export async function update_task(args: unknown) {
  const input = UpdateTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)
  if (input.goal !== undefined && task.status !== 'pending') {
    throw new Error(`Cannot rename task: goal can only be changed while the task is pending (current status: ${task.status})`)
  }

  // Gates are agreed before work starts. Once a task has started, an agent may
  // only make it stricter (add approval) — otherwise it could delete a failing
  // check and then complete. Humans can still edit gates in the web UI.
  const gates = gateFieldsFrom(input)
  const changedGates = Object.keys(gates).filter((k) => !(k === 'requires_approval' && gates.requires_approval === true))
  if (changedGates.length > 0 && task.status !== 'pending') {
    throw new Error(
      `Cannot change ${changedGates.join(', ')}: verification gates can only be changed while the task is pending ` +
      `(current status: ${task.status}). Ask a human to edit them in the web UI if they are wrong.`)
  }

  // A goal run may not work on an item that waits on the person's answer to its attempt limit. Updating
  // notes, result or state isn't an attempt: an item kept open and checked each run isn't being retried.
  recordItemAttempt(planId, input.task_id, getOpenRun(), false)

  // Rewording a proposal's action restages its exact calls (#167): the old ones are dropped, so an old
  // approval can't be reused. An approved item's staged calls can't be swapped for others.
  const patchedAction = input.state_patch?.action as { category?: string; calls?: unknown } | undefined
  let restage: ProposalCall[] | null = null
  if (patchedAction !== undefined) {
    if (task.approved_at && proposalHasCalls(planId, task.id)) {
      throw new Error("This proposal was approved for its staged calls; they can't be changed. Complete or abandon it and propose again.")
    }
    const calls = Array.isArray(patchedAction?.calls) ? patchedAction.calls as ProposalCall[] : []
    if (calls.some((c) => typeof c !== 'object' || c === null || typeof c.command !== 'string')) {
      throw new Error('action.calls must be a list of {command, files?: [{path, contents}]}')
    }
    const problem = proposalCallsProblem(calls)
    if (problem) throw new Error(problem)
    restage = calls
  }
  const newState = { ...task.state, ...(input.state_patch ?? {}) }
  if (restage) {
    const { calls: _calls, ...action } = patchedAction as Record<string, unknown>
    newState.action = action
  }

  const now = new Date().toISOString()
  const fields: Parameters<typeof updateTask>[2] = { state: newState, updated_at: now, ...gates }
  if (input.result !== undefined) fields.result = input.result
  if (input.notes !== undefined) fields.notes = input.notes
  if (input.goal !== undefined) fields.goal = input.goal

  updateTask(planId, input.task_id, fields)
  if (restage) {
    const category = typeof patchedAction?.category === 'string' ? patchedAction.category : String((task.state.action as { category?: unknown } | undefined)?.category ?? '')
    if (restage.length > 0) stageProposalCalls({ id: task.id, plan_id: planId, run_id: getOpenRun() }, category, restage)
    else clearProposalCalls(planId, task.id)
  }
  touchPlan(planId)

  // Record old and new values of what changed, so the change can be reviewed (or undone later).
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of ['goal', 'result', 'notes'] as const) {
    if (input[key] !== undefined && input[key] !== task[key]) {
      before[key] = task[key]
      after[key] = input[key]
    }
  }
  for (const [key, value] of Object.entries(gates) as [keyof typeof gates, unknown][]) {
    if (JSON.stringify(value ?? null) !== JSON.stringify(task[key] ?? null)) {
      before[key] = task[key]
      after[key] = value
    }
  }
  if (input.state_patch && Object.keys(input.state_patch).length > 0) {
    before.state = Object.fromEntries(Object.keys(input.state_patch).map((k) => [k, task.state[k] ?? null]))
    after.state = input.state_patch
  }
  if (Object.keys(after).length > 0) {
    record(planId, input.task_id, 'task_updated', { fields: Object.keys(after), before, after })
  }

  return buildContext(planId, input.task_id)
}
