import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get_goal_brief, add_item } from '../../tools/goals.js'
import { update_task } from '../../tools/update_task.js'
import { delete_goal, purge_goal } from '../../tools/goal_runner.js'
import { createGoal, queueRun, approveTask, getTask, setGuardedDataDir, endRun } from '../../db.js'
import { setOpenPlan } from '../../session.js'

const now = new Date().toISOString()
let dir: string

function makeGoal(id: string) {
  createGoal(
    { id, name: 'Fixer', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now },
    { objective: 'Fix issues', instructions: '', autonomy: { 'github.review': 'propose', 'code.edit': 'auto' } },
  )
  return id
}

async function startRun(goalId: string) {
  const run = queueRun(goalId)
  await get_goal_brief({ goal_id: goalId, run_id: run.id })
  return run.id
}

beforeEach(() => {
  setOpenPlan(null)
  dir = mkdtempSync(join(tmpdir(), 'qd-staged-'))
  setGuardedDataDir(dir)
})
afterEach(() => {
  setGuardedDataDir(null)
  rmSync(dir, { recursive: true, force: true })
})

const review = {
  command: 'gh api repos/o/r/pulls/12/reviews --input review.json',
  files: [{ path: 'review.json', contents: '{"event":"COMMENT"}' }],
}

describe('a proposal\'s exact calls (#167)', () => {
  it('add_item stages the calls and returns the staged commands', async () => {
    const goal = makeGoal('goal_calls_add')
    await startRun(goal)
    const out = await add_item({ goal: 'Post review', action: { category: 'github.review', summary: 'Post it', calls: [review] } })
    expect(out.mode).toBe('propose')
    expect(out.staged_calls).toHaveLength(1)
    const staged = out.staged_calls![0]!
    expect(staged).not.toContain(' review.json')
    const path = staged.split('--input ')[1]!
    expect(path.startsWith(dir)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('{"event":"COMMENT"}')
    const task = getTask(goal, out.item.id)!
    expect((task.state.action as { calls?: string[] }).calls).toEqual([staged])
  })

  it('add_item stages nothing for an auto action', async () => {
    const goal = makeGoal('goal_calls_auto')
    await startRun(goal)
    const out = await add_item({ goal: 'Edited', action: { category: 'code.edit', summary: 'Edit', calls: [review] } })
    expect(out.staged_calls).toBeUndefined()
  })

  it('update_task restages the calls of a changed proposal and drops the old files', async () => {
    const goal = makeGoal('goal_calls_restage')
    await startRun(goal)
    const out = await add_item({ goal: 'Post review', action: { category: 'github.review', summary: 'Post it', calls: [review] } })
    const oldPath = out.staged_calls![0]!.split('--input ')[1]!
    await update_task({
      task_id: out.item.id,
      state_patch: { action: { category: 'github.review', summary: 'Post it, changed', calls: [{ ...review, files: [{ path: 'review.json', contents: '{"event":"APPROVE"}' }] }] } },
    })
    const action = getTask(goal, out.item.id)!.state.action as { summary: string; calls?: string[] }
    expect(action.summary).toBe('Post it, changed')
    expect(action.calls).toHaveLength(1)
    expect(readFileSync(action.calls![0]!.split('--input ')[1]!, 'utf8')).toBe('{"event":"APPROVE"}')
    // No calls at all: the staged files go too
    await update_task({ task_id: out.item.id, state_patch: { action: { category: 'github.review', summary: 'Post it, no calls', calls: [] } } })
    expect(existsSync(oldPath)).toBe(false)
    expect((getTask(goal, out.item.id)!.state.action as { calls?: string[] }).calls).toBeUndefined()
  })

  it('update_task refuses to swap the calls of an approved proposal', async () => {
    const goal = makeGoal('goal_calls_approved')
    await startRun(goal)
    const out = await add_item({ goal: 'Post review', action: { category: 'github.review', summary: 'Post it', calls: [review] } })
    approveTask(goal, out.item.id)
    await expect(update_task({
      task_id: out.item.id,
      state_patch: { action: { category: 'github.review', summary: 'Other', calls: [{ command: 'gh api user' }] } },
    })).rejects.toThrow(/staged calls/)
  })
})

describe('purging a goal with staged calls', () => {
  it('purge_goal erases its guarded checks too', async () => {
    const goal = makeGoal('goal_calls_purge')
    const runId = await startRun(goal)
    await add_item({ goal: 'Post review', action: { category: 'github.review', summary: 'Post it', calls: [review] } })
    endRun(runId, 'done')
    await delete_goal({ goal_id: goal })
    await expect(purge_goal({ goal_id: goal })).resolves.toBeDefined()
  })
})
