import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, queueRun, getRun, updateRun, addItem, getTask, listMemory, listRuns,
  takeLease, releaseLease, leaseHolder, claimRun, schedulerPass, expireStaleRuns, decideItem, attachAgent, guardToolCallForRun,
  buildOverview, overviewWithEtag, LEASE_MS, insertRun, endRun, updateTask, reviveIfDone, insertMemory,
  SCHEMA_VERSION, dbSchemaVersion, schemaOutdated, runMigrations, setSchedule, cronNext,
  buildBrief, deleteGoal, restoreGoal, queueRunWithRequest, setRunHold, startRun,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp/inbox', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } })
})

describe('scheduler lease', () => {
  it('lets one holder at a time take it, and another once it expires or is released', () => {
    const t = new Date()
    expect(takeLease(db, 'A', t)).toBe(true)
    expect(takeLease(db, 'B', t)).toBe(false)
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000))).toBe(true) // renew
    expect(takeLease(db, 'B', new Date(t.getTime() + 1000 + LEASE_MS + 1))).toBe(true)
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000 + LEASE_MS + 2))).toBe(false)
    releaseLease(db, 'B')
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000 + LEASE_MS + 3))).toBe(true)
  })

  it('the overview says when the standing session is the one starting runs', () => {
    expect(leaseHolder(db)).toBeNull()
    takeLease(db, 'standing')
    expect(leaseHolder(db)).toBe('standing')
    expect(buildOverview(db, 'all', 'standing')).toMatchObject({ standing: true })
    expect(buildOverview(db, 'all', 'another')).not.toHaveProperty('standing')
    expect(buildOverview(db)).not.toHaveProperty('standing')
    // A lease that ran out is nobody's
    expect(leaseHolder(db, new Date(Date.now() + LEASE_MS + 1000))).toBeNull()
  })
})

describe('claimRun', () => {
  it('claims a queued run once, with a prompt naming the goal and run', () => {
    const q = queueRun(db, 'g1')
    const claimed = claimRun(db, 'g1', { holder: 'A', queuedRunId: q.id })
    expect(claimed).toMatchObject({ run_id: q.id, goal_id: 'g1', name: 'Inbox', working_dir: '/tmp/inbox', max_run_minutes: 15 })
    expect(claimed!.prompt).toContain(`run_id "${q.id}"`)
    expect(getRun(db, q.id)).toMatchObject({ status: 'running', holder: 'A' })
    expect(getGoal(db, 'g1')!.last_run_at).not.toBeNull()
    expect(claimRun(db, 'g1', { holder: 'B', queuedRunId: q.id })).toBeNull()
  })

  it('creates and claims a run when none is queued', () => {
    const claimed = claimRun(db, 'g1', { holder: 'A', trigger: 'interval' })
    expect(getRun(db, claimed!.run_id)).toMatchObject({ status: 'running', trigger: 'interval', holder: 'A' })
  })

  it('records the subagent doing the run', () => {
    const claimed = claimRun(db, 'g1', { holder: 'A' })!
    attachAgent(db, claimed.run_id, 'agent-1')
    expect(getRun(db, claimed.run_id)!.agent_id).toBe('agent-1')
  })
})

describe('schedulerPass', () => {
  it('claims queued runs for the lease holder only', async () => {
    const q = queueRun(db, 'g1')
    const other = await schedulerPass(db, { holder: 'B', now: new Date() }).then(() => schedulerPass(db, { holder: 'A' }))
    expect(other).toEqual({ leader: false, claimed: [], expired: [] })
    // B took the lease first and claimed the run
    expect(getRun(db, q.id)).toMatchObject({ status: 'running', holder: 'B' })
  })

  it('claims a due interval run and moves next_run_at forward', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Every half hour' }, { objective: 'x' }, { minutes: 30 })
    const t = new Date(Date.now() + 1000)
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'interval']])
    expect(getGoal(db, 'g2')!.next_run_at! > t.toISOString()).toBe(true)
  })

  it('restarts an interval from a run started any other way', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Hourly' }, { objective: 'x' }, { minutes: 60 })
    const t = new Date()
    updateGoal(db, 'g2', { next_run_at: new Date(t.getTime() + 5 * 60_000).toISOString() })
    queueRun(db, 'g2') // Run now, five minutes before the scheduled run
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'manual']])
    expect(getGoal(db, 'g2')!.next_run_at).toBe(new Date(t.getTime() + 60 * 60_000).toISOString())
  })

  it('keeps a cron slot when a run starts some other way', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Daily' }, { objective: 'x' })
    setSchedule(db, 'g2', { kind: 'cron', expr: '0 8 * * *' })
    const t = new Date()
    const slot = cronNext('0 8 * * *', t).toISOString()
    updateGoal(db, 'g2', { next_run_at: slot })
    queueRun(db, 'g2')
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'manual']])
    expect(getGoal(db, 'g2')!.next_run_at).toBe(slot)
  })

  it('starts no more than maxConcurrent runs at once', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'B' }, { objective: 'x' })
    createGoal(db, { ...plan, id: 'g3', name: 'C' }, { objective: 'x' })
    for (const id of ['g1', 'g2', 'g3']) queueRun(db, id)
    const first = await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })
    expect(first.claimed).toHaveLength(2)
    expect((await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })).claimed).toHaveLength(0)
    updateRun(db, first.claimed[0]!.run_id, { status: 'completed' })
    expect((await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })).claimed).toHaveLength(1)
  })

  it('skips a queued run past the daily limit', async () => {
    updateGoal(db, 'g1', { limits: { max_runs_per_day: 1 } })
    insertRun(db, 'g1', 'manual', 'completed')
    const q = queueRun(db, 'g1')
    expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([])
    expect(getRun(db, q.id)).toMatchObject({ status: 'skipped', skip_reason: expect.stringMatching(/daily run limit/) })
  })
})

describe('expireStaleRuns', () => {
  it('times out runs well past their limit, except ones the caller tracks', () => {
    const a = claimRun(db, 'g1', { holder: 'A' })!
    const later = new Date(Date.now() + 25 * 60_000)
    expect(expireStaleRuns(db, later, { skipRunIds: new Set([a.run_id]) })).toEqual([])
    expect(expireStaleRuns(db, new Date(Date.now() + 5 * 60_000))).toEqual([])
    expect(expireStaleRuns(db, later)).toEqual([a.run_id])
    expect(getRun(db, a.run_id)!.status).toBe('timed_out')
  })
})

describe('decideItem', () => {
  it('a question for the person waits under Needs you; answering it saves the answer and queues a run', () => {
    const q = addItem(db, 'g1', null, { goal: 'Which job sites should I search?', ask_person: true }).task
    expect(q).toMatchObject({ status: 'active', review_requested_at: expect.any(String) })
    expect(buildOverview(db).goals[0]!.needs_you[0]).toMatchObject({ id: q.id, asks_person: true })
    expect(() => decideItem(db, 'g1', q.id, { decision: 'answer', feedback: ' ' })).toThrow(/answer is needed/)
    const r = decideItem(db, 'g1', q.id, { decision: 'answer', feedback: 'Seek and LinkedIn' })
    expect(r.task).toMatchObject({ status: 'completed', result: 'Your answer: Seek and LinkedIn' })
    expect(r.queuedRun).not.toBeNull()
    expect(listMemory(db, 'g1').map((m) => m.text)).toContain('You answered "Which job sites should I search?": Seek and LinkedIn')
  })

  it("an answer keeps the question's options: in the next brief and in memory", () => {
    const notes = 'Options: (a) build 1-3, (b) only 1-2, (c) 1-3 plus merging categories.'
    const q = addItem(db, 'g1', null, { goal: 'Build it this way?', ask_person: true, notes }).task
    const { queuedRun } = decideItem(db, 'g1', q.id, { decision: 'answer', feedback: 'c' })
    expect(buildBrief(db, 'g1', queuedRun!.id).decisions_since_last_run).toEqual([
      expect.objectContaining({ item: q.id, answer: 'c', question_notes: notes }),
    ])
    expect(listMemory(db, 'g1').map((m) => m.text)).toContain(`You answered "Build it this way?": c (the question said: ${notes})`)
  })

  it('a request marked done completes and queues a run; a proposal cannot be answered', () => {
    const q = addItem(db, 'g1', null, { goal: 'Connect Gmail', ask_person: true }).task
    expect(decideItem(db, 'g1', q.id, { decision: 'approve' })).toMatchObject({ task: { status: 'completed' }, queuedRun: expect.anything() })
    const p = addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } }).task
    expect(() => decideItem(db, 'g1', p.id, { decision: 'answer', feedback: 'yes' })).toThrow(/isn't a question/)
  })

  it('a question that carries an action: the answer approves that action until the run completes it', () => {
    updateGoal(db, 'g1', { tool_map: { 'Bash(gh issue edit * --add-label needs-refinement)': 'github.schedule' }, autonomy: { 'github.schedule': 'propose', 'email.delete': 'off' } })
    const asking = insertRun(db, 'g1', 'watch', 'running')
    const added = addItem(db, 'g1', asking.id, { goal: 'Which of these should be refined?', ask_person: true, action: { category: 'github.schedule', summary: 'Label the issues you pick needs-refinement' } })
    expect(added.mode).toBe('propose')
    expect(added.task).toMatchObject({ status: 'active', review_requested_at: expect.any(String), state: { asks_person: true, action: { category: 'github.schedule' } } })
    expect(buildOverview(db).goals[0]!.needs_you[0]).toMatchObject({ id: added.task.id, asks_person: true })
    const label = (run: string) => guardToolCallForRun(db, run, 'Bash', { command: 'gh issue edit 12 --add-label needs-refinement' }).decision
    expect(label(asking.id)).toBe('deny')
    const { task, queuedRun } = decideItem(db, 'g1', added.task.id, { decision: 'answer', feedback: '12' })
    expect(task).toMatchObject({ status: 'active', approved_at: expect.any(String), result: 'Your answer: 12' })
    updateRun(db, asking.id, { status: 'completed', ended_at: new Date().toISOString() })
    const next = claimRun(db, 'g1', { holder: 'A', queuedRunId: queuedRun!.id })!
    const brief = buildBrief(db, 'g1', next.run_id)
    expect(brief.decisions_since_last_run).toEqual([expect.objectContaining({ item: added.task.id, answer: '12', action: expect.objectContaining({ category: 'github.schedule' }) })])
    expect(brief.open_items.find((i) => i.id === added.task.id)).toMatchObject({ approved_to_execute: true })
    expect(label(next.run_id)).toBe('allow')
    updateTask(db, 'g1', added.task.id, { status: 'completed' })
    expect(label(next.run_id)).toBe('deny')
    // An off category is refused, question or not
    expect(() => addItem(db, 'g1', null, { goal: 'Delete these?', ask_person: true, action: { category: 'email.delete', summary: 'x' } })).toThrow(/off/)
  })

  it('an answer or approval during a run queues a run after it, not the run already going', async () => {
    const asking = claimRun(db, 'g1', { holder: 'A' })!
    const q = addItem(db, 'g1', asking.run_id, { goal: 'Build Part 1 first?', ask_person: true }).task
    const p = addItem(db, 'g1', asking.run_id, { goal: 'Push it', action: { category: 'code.pull_request', summary: 'Push' } }).task
    const answered = decideItem(db, 'g1', q.id, { decision: 'answer', feedback: 'a' }).queuedRun!
    expect(answered).toMatchObject({ status: 'queued', trigger: 'manual' })
    expect(answered.id).not.toBe(asking.run_id)
    // A second decision rides on the same queued run
    expect(decideItem(db, 'g1', p.id, { decision: 'approve' }).queuedRun!.id).toBe(answered.id)
    // It waits while the asking run goes on, then starts
    expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([])
    updateRun(db, asking.run_id, { status: 'completed', ended_at: new Date().toISOString() })
    expect((await schedulerPass(db, { holder: 'A' })).claimed.map((c) => c.run_id)).toEqual([answered.id])
  })

  it('approving a proposal keeps it active and queues a run', () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const r = decideItem(db, 'g1', '1', { decision: 'approve' })
    expect(r.task).toMatchObject({ status: 'active', approved_by: 'human' })
    expect(r.queuedRun).toMatchObject({ status: 'queued', trigger: 'manual' })
  })

  it('rejecting saves the feedback as goal memory', () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const r = decideItem(db, 'g1', '1', { decision: 'reject', feedback: 'too formal' })
    expect(getTask(db, 'g1', '1')!.review_requested_at).toBeNull()
    expect(listMemory(db, 'g1').map((m) => m.text)).toContain('Feedback on "Reply to Bob": too formal')
    // A recurring goal runs again to act on the feedback, and the brief shows it
    expect(r.queuedRun).toMatchObject({ status: 'queued', trigger: 'manual' })
    expect(buildBrief(db, 'g1', r.queuedRun!.id).decisions_since_last_run).toEqual([
      expect.objectContaining({ item: '1', decision: 'rejected', feedback: 'too formal', action: expect.objectContaining({ category: 'email.send' }) }),
    ])
  })

  it('a rejection during a run queues a run after it, not the run already going', async () => {
    const going = claimRun(db, 'g1', { holder: 'A' })!
    const p = addItem(db, 'g1', going.run_id, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } }).task
    const q = addItem(db, 'g1', going.run_id, { goal: 'Reply to Ann', action: { category: 'email.send', summary: 'Send reply' } }).task
    const rejected = decideItem(db, 'g1', p.id, { decision: 'reject', feedback: 'shorter' }).queuedRun!
    expect(rejected).toMatchObject({ status: 'queued', trigger: 'manual' })
    expect(rejected.id).not.toBe(going.run_id)
    // A second decision rides on the same queued run
    expect(decideItem(db, 'g1', q.id, { decision: 'reject', feedback: 'warmer' }).queuedRun!.id).toBe(rejected.id)
    expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([])
    updateRun(db, going.run_id, { status: 'completed', ended_at: new Date().toISOString() })
    expect((await schedulerPass(db, { holder: 'A' })).claimed.map((c) => c.run_id)).toEqual([rejected.id])
  })

  it('a rejection on a paused goal queues no run', () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    updateGoal(db, 'g1', { status: 'paused' })
    expect(decideItem(db, 'g1', '1', { decision: 'reject', feedback: 'too formal' }).queuedRun).toBeNull()
    expect(listRuns(db, 'g1').filter((r) => r.status === 'queued')).toEqual([])
  })

  it('the overview lists deleted goals apart, with their purge date, until restored (#105)', () => {
    expect(buildOverview(db)).not.toHaveProperty('deleted')
    deleteGoal(db, 'g1', new Date('2026-11-01T00:00:00Z'))
    const o = buildOverview(db)
    expect(o.goals).toEqual([])
    expect(o.deleted).toEqual([{ id: 'g1', name: 'Inbox', deleted_at: '2026-11-01T00:00:00.000Z', purge_at: '2026-12-01T00:00:00.000Z' }])
    expect(o).not.toHaveProperty('deleted_detail')
    // Named in detail, a deleted goal comes with its full detail, apart from the live goals (goal_detail reads it)
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Bob prefers mornings', source: 'agent' })
    const named = buildOverview(db, ['g1'])
    expect(named.goals).toEqual([])
    expect(named.deleted_detail).toHaveLength(1)
    expect(named.deleted_detail![0]).toMatchObject({ id: 'g1', name: 'Inbox', detail: true, deleted_at: '2026-11-01T00:00:00.000Z', purge_at: '2026-12-01T00:00:00.000Z' })
    expect(named.deleted_detail![0].memory.map((m) => m.text)).toEqual(['Bob prefers mornings'])
    expect(buildOverview(db, ['other'])).not.toHaveProperty('deleted_detail')
    restoreGoal(db, 'g1')
    expect(buildOverview(db)).not.toHaveProperty('deleted')
    expect(buildOverview(db).goals.map((g) => g.id)).toEqual(['g1'])
  })

  it('refuses an unknown item', () => {
    expect(() => decideItem(db, 'g1', '9', { decision: 'approve' })).toThrow(/not found/)
  })
})

describe('guardToolCallForRun', () => {
  it('applies the goal autonomy to a running run, and allows anything outside runs', () => {
    updateGoal(db, 'g1', { tool_map: { 'mcp__gmail__send*': 'email.send', 'mcp__gmail__delete': 'email.delete' } })
    const run = claimRun(db, 'g1', { holder: 'A' })!
    expect(guardToolCallForRun(db, run.run_id, 'mcp__gmail__delete')).toMatchObject({ decision: 'deny', category: 'email.delete' })
    expect(guardToolCallForRun(db, run.run_id, 'mcp__gmail__send_reply')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })
    expect(guardToolCallForRun(db, run.run_id, 'Read')).toEqual({ decision: 'allow', run_id: run.run_id })
    expect(guardToolCallForRun(db, 'run_nope', 'mcp__gmail__delete')).toEqual({ decision: 'allow' })
  })
})

describe('buildOverview', () => {
  it('with only, gives just the goals in detail, whatever other goals there are (#121)', () => {
    const add = (id: string) => createGoal(db, { id, name: `Goal ${id}`, description: null, status: 'active', working_dir: '/tmp', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { objective: 'o'.repeat(500), instructions: 'i'.repeat(5000) })
    add('a1'); add('a2')
    const o = buildOverview(db, ['a1'], null, true, true)
    expect(o.goals.map((g) => g.id)).toEqual(['a1'])
    expect(o.goals[0]).toMatchObject({ detail: true, instructions: 'i'.repeat(5000) })
    const size = JSON.stringify(o).length
    add('a3'); add('a4')
    expect(JSON.stringify(buildOverview(db, ['a1'], null, true, true)).length).toBe(size)
    // Without only, every goal still comes, as a card
    expect(buildOverview(db, ['a1'], null, true).goals).toHaveLength(5)
    // No deleted list; a deleted goal named in detail still comes in deleted_detail
    deleteGoal(db, 'a2')
    expect(buildOverview(db, ['a1'], null, true, true)).not.toHaveProperty('deleted')
    expect(buildOverview(db, ['a1'], null, true)).toHaveProperty('deleted')
    const gone = buildOverview(db, ['a2'], null, true, true)
    expect(gone.goals).toEqual([])
    expect(gone.deleted_detail!.map((g) => g.id)).toEqual(['a2'])
  })

  it('stays small however much runs write: long text is clipped', () => {
    const long = 'x'.repeat(5000)
    for (let i = 0; i < 12; i++) {
      const id = `big${i}`
      createGoal(db, { id, name: `Goal ${i}`, description: null, status: 'active', working_dir: '/tmp', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { objective: long, instructions: long })
      for (let m = 0; m < 10; m++) insertMemory(db, { plan_id: id, kind: 'fact', text: long, source: 'agent' })
      for (let n = 0; n < 15; n++) addItem(db, id, null, { goal: long, notes: long, action: { category: 'email.send', summary: long } })
      for (let r = 0; r < 5; r++) {
        const run = insertRun(db, id, 'manual', 'running')
        db.prepare("UPDATE goal_runs SET status = 'completed', summary = ?, ended_at = ? WHERE id = ?").run(long, new Date().toISOString(), run.id)
      }
    }
    // Cards for all stay well under the ~50 KB a plugin can read; one goal's full detail is bounded too
    expect(JSON.stringify(buildOverview(db, [])).length).toBeLessThan(45_000)
    expect(JSON.stringify(buildOverview(db, ['big0']).goals.find((g) => g.id === 'big0')).length).toBeLessThan(30_000)
    const o = buildOverview(db, ['big0'])
    expect(o.goals.find((g) => g.id === 'big0')).toMatchObject({ detail: true, needs_you_count: 15 })
    expect(o.goals.find((g) => g.id === 'big0')!.runs[0]!.summary!.length).toBeLessThanOrEqual(300)
    expect(o.goals.find((g) => g.id === 'big1')).toMatchObject({ detail: false, needs_you_count: 15, memory: [], open_items: [] })
    expect(o.goals.find((g) => g.id === 'big1')!.needs_you).toHaveLength(5)
  })

  it('a question carries its context (notes) on a card and in detail, within bounds', () => {
    const context = 'Two ways: (a) stop the agent once its handback is answered; (b) let the handback through. I would do (a).'
    addItem(db, 'g1', null, { goal: 'Issue #8: which approach?', notes: context, ask_person: true })
    expect(buildOverview(db).goals[0]!.needs_you[0]).toMatchObject({ asks_person: true, notes: context })
    expect(buildOverview(db, []).goals[0]!.needs_you[0]).toMatchObject({ asks_person: true, notes: context })
    const long = 'x'.repeat(5000)
    for (let i = 0; i < 12; i++) {
      const id = `q${i}`
      createGoal(db, { id, name: `Goal ${i}`, description: null, status: 'active', working_dir: '/tmp', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { objective: long, instructions: long })
      for (let n = 0; n < 15; n++) addItem(db, id, null, { goal: long, notes: long, ask_person: true })
    }
    expect(JSON.stringify(buildOverview(db, [])).length).toBeLessThan(45_000)
    expect(JSON.stringify(buildOverview(db, ['q0']).goals.find((g) => g.id === 'q0')).length).toBeLessThan(30_000)
    const card = buildOverview(db, []).goals.find((g) => g.id === 'q1')!.needs_you
    expect(card.filter((i) => 'notes' in i)).toHaveLength(1)
  })

  it("leaves the actions params out (the goal page shows them)", () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply', params: { body: 'x'.repeat(5000) } } })
    const item = buildOverview(db).goals[0]!.needs_you[0]!
    expect(item.action).toEqual({ category: 'email.send', summary: 'Send reply' })
  })

  it('lists goals with items waiting for review, and an etag that changes with them', () => {
    const before = overviewWithEtag(db).etag
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const o = buildOverview(db)
    expect(o.goals).toHaveLength(1)
    expect(o.goals[0]).toMatchObject({ id: 'g1', name: 'Inbox', needs_you: [{ id: '1', awaiting_review: true }] })
    expect(overviewWithEtag(db).etag).not.toBe(before)
    expect(listRuns(db, 'g1')).toEqual([])
  })
})

describe('one-off goals', () => {
  const oneOff = (id = 'o1') => createGoal(db, { ...plan, id, name: 'Tidy downloads' }, { objective: 'Delete old installers', one_off: true })

  it('a run that leaves nothing open makes it done, and it can run again', async () => {
    oneOff()
    const run = claimRun(db, 'o1', { holder: 'A' })!
    endRun(db, run.run_id, 'Deleted 12 installers.')
    expect(getGoal(db, 'o1')).toMatchObject({ status: 'retired', one_off: true, next_run_at: null })
    expect(buildOverview(db).goals.find((g) => g.id === 'o1')).toMatchObject({ status: 'retired', one_off: true })
    expect(reviveIfDone(db, 'o1')).toBe(true)
    expect(getGoal(db, 'o1')!.status).toBe('active')
    expect(reviveIfDone(db, 'g1')).toBe(false)
  })

  it('stays while a proposal waits, and finishes after the run that carries it out', async () => {
    oneOff()
    const first = claimRun(db, 'o1', { holder: 'A' })!
    addItem(db, 'o1', first.run_id, { goal: 'Delete ~/Downloads/big.iso', action: { category: 'fs.delete', summary: 'Delete it' } })
    endRun(db, first.run_id, 'Proposed one deletion.')
    expect(getGoal(db, 'o1')!.status).toBe('active')
    const { queuedRun } = decideItem(db, 'o1', '1', { decision: 'approve' })
    const second = claimRun(db, 'o1', { holder: 'A', queuedRunId: queuedRun!.id })!
    updateTask(db, 'o1', '1', { status: 'completed' })
    endRun(db, second.run_id, 'Deleted it.')
    expect(getGoal(db, 'o1')!.status).toBe('retired')
  })

  it('a rejected proposal queues a run to revise it; recurring goals never finish', async () => {
    oneOff()
    const run = claimRun(db, 'o1', { holder: 'A' })!
    addItem(db, 'o1', run.run_id, { goal: 'Delete all of ~/Downloads', action: { category: 'fs.delete', summary: 'Delete everything' } })
    endRun(db, run.run_id, 'Proposed.')
    expect(decideItem(db, 'o1', '1', { decision: 'reject', feedback: 'only installers' }).queuedRun).toMatchObject({ status: 'queued' })

    const g1 = claimRun(db, 'g1', { holder: 'A' })!
    endRun(db, g1.run_id, 'Nothing to do.')
    expect(getGoal(db, 'g1')!.status).toBe('active')
    expect(buildOverview(db).goals.map((g) => g.id)).toContain('g1')
  })

  it('other retired goals stay out of the overview', async () => {
    updateGoal(db, 'g1', { status: 'retired' })
    expect(buildOverview(db).goals.map((g) => g.id)).not.toContain('g1')
  })
})

describe('schema version', () => {
  it('records the schema version and never lowers a newer one', () => {
    expect(dbSchemaVersion(db)).toBe(SCHEMA_VERSION)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    runMigrations(db)
    expect(dbSchemaVersion(db)).toBe(SCHEMA_VERSION + 1)
  })

  it('an outdated session schedules nothing and the overview says so', async () => {
    queueRun(db, 'g1')
    expect(buildOverview(db).outdated).toBeUndefined()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(schemaOutdated(db)).toBe(true)
    const r = await schedulerPass(db, { holder: 'A' })
    expect(r).toEqual({ leader: false, claimed: [], expired: [], outdated: true })
    expect(buildOverview(db).outdated).toBe(true)
  })
})

describe('Run with a prompt (#143)', () => {
  const queued = (r: ReturnType<typeof queueRunWithRequest>) => { if (!('run' in r)) throw new Error(r.reason); return r.run }

  it('starts a run whose brief carries the prompt, trusted, and writes no memory', () => {
    const run = queued(queueRunWithRequest(db, 'g1', '  Look at the invoices first  '))
    startRun(db, run.id, null)
    const brief = buildBrief(db, 'g1', run.id)
    expect(brief.run!.request).toEqual({ text: 'Look at the invoices first' })
    expect(brief.run!.untrusted).toBeNull()
    expect(listMemory(db, 'g1')).toEqual([])
  })

  it('queues a new run behind a running one instead of joining it', () => {
    const running = queueRun(db, 'g1')
    startRun(db, running.id, null)
    const run = queued(queueRunWithRequest(db, 'g1', 'Check the refund'))
    expect(run.id).not.toBe(running.id)
    expect(getRun(db, running.id)!.request).toBeNull()
    expect(buildBrief(db, 'g1', run.id).run!.request).toEqual({ text: 'Check the refund' })
  })

  it('joins a still-queued run, adding each prompt in order', () => {
    const first = queued(queueRunWithRequest(db, 'g1', 'One'))
    const second = queued(queueRunWithRequest(db, 'g1', 'Two'))
    expect(second.id).toBe(first.id)
    expect(second.request).toBe('One\n\nTwo')
  })

  it('marks the run untrusted when any part of its request is', () => {
    queued(queueRunWithRequest(db, 'g1', 'Trusted part'))
    const run = queued(queueRunWithRequest(db, 'g1', 'Outside part', { untrusted: true }))
    startRun(db, run.id, null)
    const brief = buildBrief(db, 'g1', run.id)
    expect(brief.run!.request).toEqual({ text: 'Trusted part\n\nOutside part', untrusted: true })
    expect(brief.run!.untrusted).toMatchObject({ source: 'run request' })
  })

  it('says why and queues nothing when the daily limit is reached or a usage hold is on', () => {
    updateGoal(db, 'g1', { limits: { ...getGoal(db, 'g1')!.limits, max_runs_per_day: 1 } })
    insertRun(db, 'g1', 'manual', 'completed')
    expect(queueRunWithRequest(db, 'g1', 'Again')).toEqual({ reason: 'The daily run limit is reached (1).' })
    updateGoal(db, 'g1', { limits: { ...getGoal(db, 'g1')!.limits, max_runs_per_day: 48 } })
    setRunHold(db, { until: '2099-01-01T00:00:00.000Z', reason: 'usage limit' })
    expect(queueRunWithRequest(db, 'g1', 'Again')).toMatchObject({ reason: expect.stringContaining('on hold') })
    expect(listRuns(db, 'g1').filter((r) => r.status === 'queued')).toEqual([])
  })
})
