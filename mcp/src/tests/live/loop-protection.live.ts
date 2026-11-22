/**
 * Loop protection, played out against the bundled server: the runaway breaker and per-item
 * attempt limits (issue 35). Each test plays the parts Claude Code plays: the scheduler's tick,
 * a run's agent (get_goal_brief … end_run, with run_scope as the guard plugin sets it) and the
 * person (decide_item, set_goal_status).
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GOAL_LIMITS, SCHEMA_VERSION } from '@quarterdeck/core'
import { PRINT_LINES, startLiveServer, type LiveServer } from './server.js'

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

const HOLDER = 'live-test-session'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
interface Claimed { run_id: string; goal_id: string; trigger: string }

/** One scheduler pass, as the goals plugin makes every 30 s. */
const tick = (): Promise<{ claimed?: Claimed[] }> => server.call('goals_tick', { holder: HOLDER })

/** Ticks until the scheduler hands out a run of this goal (a queued run can take a second pass). */
async function claim(goalId: string, passes = 4): Promise<Claimed | null> {
  for (let i = 0; i < passes; i++) {
    const run = (await tick()).claimed?.find((c) => c.goal_id === goalId)
    if (run) return run
  }
  return null
}

/** The watch_events lines a brief carried, as end_run's `handled` takes them; undefined when it had none. */
const handledLines = (brief: Any): string[] | undefined => {
  const lines = (brief.watch_events ?? []).flatMap((n: Any) => n.new as string[])
  return lines.length ? lines : undefined
}

/** Plays a claimed run's agent: reads the brief, does `work`, ends the run having handled every watch line. */
async function play(run: Claimed, work?: (scope: string, brief: Any) => Promise<void> | void): Promise<void> {
  const brief = await server.call('get_goal_brief', { goal_id: run.goal_id, run_id: run.run_id, run_scope: run.run_id })
  await work?.(run.run_id, brief)
  await server.call('end_run', { summary: 'Live test run.', run_scope: run.run_id, handled: handledLines(brief) })
}

/** The goal as the Goals pane gets it. */
async function overview(goalId: string): Promise<Any> {
  const goal = (await server.call('goals_overview', {})).goals.find((g: Any) => g.id === goalId)
  if (!goal) throw new Error(`Goal ${goalId} is not in the overview`)
  return goal
}

const runRow = (runId: string): { trigger: string; status: string; self_caused: number } =>
  server.db.prepare('SELECT trigger, status, self_caused FROM goal_runs WHERE id = ?').get(runId)

const addLine = (dir: string, line: string) => appendFileSync(join(dir, 'lines.txt'), `${line}\n`)

/**
 * Makes the goal's watches due now. A watch waits at least a minute between its ordinary
 * checks, and no tool moves that clock, so the test moves it in the database.
 */
function makeWatchesDue(goalId: string): void {
  server.db.prepare('UPDATE goal_watches SET last_checked_at = ? WHERE plan_id = ?').run(new Date(Date.now() - 120_000).toISOString(), goalId)
}

describe('the bundled server', () => {
  it('migrates a new database to the current schema and gives a goal the default limits', async () => {
    expect(server.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const made = await server.call('create_goal', { name: 'Defaults', objective: 'Nothing', working_dir: server.workDir('defaults') })
    const limits = JSON.parse(server.db.prepare('SELECT limits FROM goals WHERE plan_id = ?').get(made.id).limits)
    expect(limits).toEqual(DEFAULT_GOAL_LIMITS)
  })
})

describe('runaway breaker', () => {
  it('pauses a goal that keeps triggering its own watch, and the person resumes or leaves it', async () => {
    const dir = server.workDir('self-trigger')
    const made = await server.call('create_goal', {
      name: 'Triggers itself', objective: 'Each run changes what its own watch sees', working_dir: dir,
      schedule: { kind: 'interval', minutes: 60 },
      watches: { lines: { command: PRINT_LINES, every_minutes: 1 } },
    })
    const goalId: string = made.id
    let n = 0
    /** Runs that each add a line their own watch lists, until the goal is no longer active. */
    async function loopUntilPaused(most: number): Promise<{ trigger: string; self_caused: number }[]> {
      const runs: { trigger: string; self_caused: number }[] = []
      while (runs.length < most && (await overview(goalId)).status === 'active') {
        const run = await claim(goalId)
        if (!run) break
        await play(run, () => addLine(dir, `by-run-${++n}`))
        runs.push(runRow(run.run_id))
      }
      return runs
    }

    // A new interval goal is due at once: its first run is the schedule's, and it adds the first line
    const first = await loopUntilPaused(10)
    expect(first.map((r) => r.trigger)).toEqual(['interval', 'watch', 'watch', 'watch', 'watch', 'watch'])
    expect(first.slice(1).every((r) => r.self_caused === 1)).toBe(true)

    let goal = await overview(goalId)
    expect(goal.status).toBe('paused')
    // The breaker keeps the schedule, as an ordinary Pause does
    const nextRunAt: string = goal.next_run_at
    expect(nextRunAt).toBeTruthy()
    expect(goal.needs_you).toHaveLength(1)
    const request = goal.needs_you[0]
    expect(request.goal).toMatch(/Resume it\?/)
    expect(request.asks_person).toBe(false)

    // A request, not a question: there is no free text to misread
    expect(await server.refused('decide_item', { goal_id: goalId, item_id: request.id, decision: 'answer', feedback: 'yes' })).toMatch(/approve or reject/)

    await server.call('decide_item', { goal_id: goalId, item_id: request.id, decision: 'approve' })
    goal = await overview(goalId)
    expect(goal.status).toBe('active')
    expect(goal.next_run_at).toBe(nextRunAt)
    expect(goal.needs_you).toHaveLength(0)

    // The count starts afresh at the resume, and the same request is asked again
    const second = await loopUntilPaused(10)
    expect(second.length).toBeGreaterThanOrEqual(DEFAULT_GOAL_LIMITS.max_idle_runs - 1)
    goal = await overview(goalId)
    expect(goal.status).toBe('paused')
    expect(goal.needs_you.map((i: Any) => i.id)).toEqual([request.id])

    await server.call('decide_item', { goal_id: goalId, item_id: request.id, decision: 'reject', feedback: 'Leave it for now' })
    goal = await overview(goalId)
    expect(goal.status).toBe('paused')
    expect(goal.needs_you).toHaveLength(0)

    // Resume in the pane: the schedule is still there
    await server.call('set_goal_status', { goal_id: goalId, status: 'active' })
    goal = await overview(goalId)
    expect(goal.status).toBe('active')
    expect(goal.next_run_at).toBeTruthy()
  })

  it("leaves a report-only goal alone when its watch fires on other people's changes", async () => {
    const dir = server.workDir('report-only')
    const made = await server.call('create_goal', {
      name: 'Report only', objective: 'Reports what its watch saw and resolves no item', working_dir: dir,
      watches: { lines: { command: PRINT_LINES, every_minutes: 1 } },
    })
    const goalId: string = made.id
    let n = 0
    /**
     * One run started by someone else's change. `during`: they change something again while the
     * run is going, which the re-check at the run's end sees, so the run after counts as self-caused.
     */
    async function otherPersonsChange(during: boolean): Promise<number> {
      // The pass after a run re-checks the watch; a change made during that run starts a run here
      let run = (await tick()).claimed?.find((c) => c.goal_id === goalId) ?? null
      if (!run) {
        addLine(dir, `by-someone-${++n}`)
        makeWatchesDue(goalId)
        run = await claim(goalId)
      }
      if (!run) throw new Error('The watch saw a new line, but no run was claimed')
      await play(run, () => { if (during) addLine(dir, `by-someone-during-${++n}`) })
      return runRow(run.run_id).self_caused
    }

    // Changes between runs: more runs in a row, and in the hour, than either limit
    for (let i = 0; i < DEFAULT_GOAL_LIMITS.max_runs_per_hour + 2; i++) expect(await otherPersonsChange(false)).toBe(0)
    expect((await overview(goalId)).status).toBe('active')

    // A person committing while the goal reports: every other run now looks self-caused,
    // but an uncounted run between two of them breaks the streak
    let counted = 0
    for (let i = 0; i < 14; i++) counted += await otherPersonsChange(i % 2 === 0)
    expect(counted).toBeGreaterThanOrEqual(DEFAULT_GOAL_LIMITS.max_idle_runs)
    const goal = await overview(goalId)
    expect(goal.status).toBe('active')
    expect(goal.needs_you).toHaveLength(0)
  })

  it('pauses a goal whose runs keep failing', async () => {
    const made = await server.call('create_goal', { name: 'Crashes', objective: 'Every run fails', working_dir: server.workDir('crashes') })
    const goalId: string = made.id
    const insert = server.db.prepare("INSERT INTO goal_runs (id, plan_id, trigger, status, items_created, items_resolved, started_at) VALUES (?, ?, 'health', 'running', 0, 0, ?)")
    for (let i = 1; i <= DEFAULT_GOAL_LIMITS.max_idle_runs; i++) {
      // A run started by a failing health check, which create_goal can't set up: put straight into the database
      insert.run(`run_crash_${i}`, goalId, new Date().toISOString())
      await server.call('fail_run', { run_id: `run_crash_${i}`, reason: 'The agent crashed.' })
      expect((await overview(goalId)).status).toBe(i < DEFAULT_GOAL_LIMITS.max_idle_runs ? 'active' : 'paused')
    }
    expect((await overview(goalId)).needs_you).toHaveLength(1)
  })
})

describe('per-item attempt limits', () => {
  it('blocks an item after 3 runs changed its status, until the person answers', async () => {
    const made = await server.call('create_goal', { name: 'Attempts', objective: 'Works on items', working_dir: server.workDir('attempts') })
    const goalId: string = made.id
    /** A run the person starts (Run now), which the breaker never counts. */
    async function run(work: (scope: string, brief: Any) => Promise<void>): Promise<void> {
      const claimed = await claim(goalId) ?? (await server.call('run_goal', { goal_id: goalId }), await claim(goalId))
      if (!claimed) throw new Error('Run now queued a run, but none was claimed')
      await play(claimed, work)
    }

    let tracking = '', fix = ''
    await run(async (scope) => {
      tracking = (await server.call('add_item', { goal: 'PR 31 waiting for review', external_ref: 'github-pr:31', status: 'active', run_scope: scope })).item.id
      fix = (await server.call('add_item', { goal: 'Fix the flaky test', status: 'active', run_scope: scope })).item.id
    })

    // Each run checks the tracking item (notes only) and has another go at the fix (a status change)
    let status: 'pending' | 'active' = 'active'
    const tryFix = (scope: string) => {
      status = status === 'active' ? 'pending' : 'active'
      return { task_id: fix, status, run_scope: scope }
    }
    for (let i = 1; i <= DEFAULT_GOAL_LIMITS.max_item_attempts; i++) {
      await run(async (scope) => {
        await server.call('update_task', { task_id: tracking, notes: `Check ${i}: still waiting`, run_scope: scope })
        await server.call('set_status', tryFix(scope))
      })
    }
    await run(async (scope) => {
      await server.call('update_task', { task_id: tracking, notes: 'Check 4: still waiting', run_scope: scope })
      expect(await server.refused('set_status', tryFix(scope))).toMatch(/limit of 3 attempts/)
      status = status === 'active' ? 'pending' : 'active' // the refused change didn't happen
    })

    // The person is asked, and the pane and the next brief both show the item blocked
    let goal = await overview(goalId)
    expect(goal.needs_you).toHaveLength(1)
    const question = goal.needs_you[0]
    expect(question.goal).toMatch(/Fix the flaky test.*3 times/)
    expect(question.asks_person).toBe(true)
    const open = (id: string) => goal.open_items.find((i: Any) => i.id === id)
    expect(open(fix).blocked).toBe(true)
    expect(open(tracking)).not.toHaveProperty('blocked')

    await run(async (scope, brief) => {
      expect(brief.open_items.find((i: Any) => i.id === fix).blocked).toBe(true)
      // Nothing gets through on a blocked item, giving up on it included
      expect(await server.refused('update_task', { task_id: fix, notes: 'One more idea', run_scope: scope })).toMatch(/blocked/)
      expect(await server.refused('set_status', { task_id: fix, status: 'abandoned', reason: "Can't do it", run_scope: scope })).toMatch(/blocked/)
      // The tracking item was never an attempt
      await server.call('update_task', { task_id: tracking, notes: 'Check 5: still waiting', run_scope: scope })
    })

    // Rejecting the question answers it: the block lifts and the feedback is kept
    await server.call('decide_item', { goal_id: goalId, item_id: question.id, decision: 'reject', feedback: 'Try a different approach' })
    goal = await overview(goalId)
    expect(goal.needs_you).toHaveLength(0)
    expect(open(fix)).not.toHaveProperty('blocked')
    const memory = server.db.prepare('SELECT text FROM goal_memory WHERE plan_id = ?').all(goalId).map((m: Any) => m.text).join('\n')
    expect(memory).toMatch(/Try a different approach/)

    // A fresh count of 3, then the same question again
    for (let i = 1; i <= DEFAULT_GOAL_LIMITS.max_item_attempts; i++) await run(async (scope) => { await server.call('set_status', tryFix(scope)) })
    await run(async (scope) => { expect(await server.refused('set_status', tryFix(scope))).toMatch(/limit of 3 attempts/) })
    goal = await overview(goalId)
    expect(goal.needs_you.map((i: Any) => i.id)).toEqual([question.id])

    // The answer queues a run, which may now drop the item
    const answered = await server.call('decide_item', { goal_id: goalId, item_id: question.id, decision: 'answer', feedback: 'Drop it' })
    expect(answered.queued_run).toBeTruthy()
    await run(async (scope) => {
      await server.call('set_status', { task_id: fix, status: 'abandoned', reason: 'The person said to drop it', run_scope: scope })
    })
    goal = await overview(goalId)
    expect(goal.needs_you).toHaveLength(0)
    expect(open(fix)).toBeUndefined()
    expect(open(tracking)).toBeDefined()
  })
})
