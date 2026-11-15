import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, insertRun, getRun, updateRun, insertMemory, listMemory, getMemory, updateTask, getTask, getPlan,
  addItem, buildBrief, queueRun, startRun, endRun, failRun, archiveResolved, withinActiveHours, decideTick, nextIntervalRun, recordSkip,
  approveTask, rejectTask, recordAttempt, countAttempts, isAttemptBlocked, decideItem, checkCompletion, GoalError, listRuns, MEMORY_BRIEF_CHARS, STATUS_NOTE_MAX, cleanStatusNote, statusNote, setSchedule,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, {
    objective: 'Inbox zero',
    instructions: 'Archive newsletters.',
    autonomy: { 'email.archive': 'auto', 'email.delete': 'off' },
  })
})

describe('addItem', () => {
  it('creates a plain item as a root-level pending task', () => {
    const r = addItem(db, 'g1', null, { goal: 'Look at invoice', external_ref: 'gmail:1' })
    expect(r).toMatchObject({ existing: false })
    expect(r.task).toMatchObject({ id: '1', status: 'pending', external_ref: 'gmail:1', created_by: 'agent' })
    expect(addItem(db, 'g1', null, { goal: 'next' }).task.id).toBe('2')
  })

  it('returns the existing item for a known external_ref, even if archived', () => {
    addItem(db, 'g1', null, { goal: 'a', external_ref: 'gmail:1' })
    updateTask(db, 'g1', '1', { status: 'completed', archived_at: now })
    const again = addItem(db, 'g1', null, { goal: 'a again', external_ref: 'gmail:1' })
    expect(again.existing).toBe(true)
    expect(again.task.goal).toBe('a')
  })

  it('refuses actions whose category is off', () => {
    expect(() => addItem(db, 'g1', null, { goal: 'delete spam', action: { category: 'email.delete', summary: 'delete' } })).toThrow(/off for this goal/)
  })

  it('turns actions in propose categories (the default) into items awaiting review', () => {
    const r = addItem(db, 'g1', null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'Send reply' } })
    expect(r.mode).toBe('propose')
    expect(r.task).toMatchObject({ status: 'active', requires_approval: true })
    expect(r.task.review_requested_at).not.toBeNull()
    expect(r.task.state.action).toMatchObject({ category: 'email.send', summary: 'Send reply', params: {} })
  })

  it('records auto actions as already done', () => {
    const r = addItem(db, 'g1', null, { goal: 'Archive newsletter', action: { category: 'email.archive', summary: 'Archived' } })
    expect(r.mode).toBe('auto')
    expect(r.task).toMatchObject({ status: 'completed', result: 'Done automatically: Archived' })
  })

  it('enforces the per-run item cap', () => {
    updateGoal(db, 'g1', { limits: { max_items_per_run: 2 } })
    const run = insertRun(db, 'g1', 'manual', 'running')
    addItem(db, 'g1', run.id, { goal: 'a' })
    addItem(db, 'g1', run.id, { goal: 'b' })
    expect(() => addItem(db, 'g1', run.id, { goal: 'c' })).toThrow(/limit 2/)
    expect(() => addItem(db, 'g1', null, { goal: 'outside a run' })).not.toThrow()
  })

  it('only works on goals', () => {
    db.prepare("INSERT INTO plans (id, name, status, working_dir, created_at, updated_at) VALUES ('p', 'P', 'active', '/', ?, ?)").run(now, now)
    expect(() => addItem(db, 'p', null, { goal: 'x' })).toThrow(GoalError)
  })
})

describe('known categories', () => {
  it('lists autonomy keys and used categories, most used first, with an example', () => {
    addItem(db, 'g1', null, { goal: 'a', action: { category: 'github.pr', summary: 'Open PR #1' } })
    addItem(db, 'g1', null, { goal: 'b', action: { category: 'github.pr', summary: 'Open PR #2' } })
    const known = buildBrief(db, 'g1').known_categories
    expect(known[0]).toMatchObject({ category: 'github.pr', mode: 'propose', uses: 2 })
    expect(known[0]!.example).toMatch(/Open PR #/)
    expect(known.map((k) => k.category)).toEqual(['github.pr', 'email.archive', 'email.delete'])
    expect(known.find((k) => k.category === 'email.archive')).toMatchObject({ mode: 'auto', uses: 0 })
  })

  it('notes similar existing categories when a new one shares their first segment', () => {
    addItem(db, 'g1', null, { goal: 'a', action: { category: 'github.pr', summary: 'Open PR' } })
    const r = addItem(db, 'g1', null, { goal: 'b', action: { category: 'github.push', summary: 'Push' } })
    expect(r.similar_categories).toEqual(['github.pr'])
    expect(addItem(db, 'g1', null, { goal: 'c', action: { category: 'github.pr', summary: 'Open PR' } }).similar_categories).toBeUndefined()
    expect(addItem(db, 'g1', null, { goal: 'd', action: { category: 'calendar.add', summary: 'Add' } }).similar_categories).toBeUndefined()
  })
})

describe('proposals and review', () => {
  function propose() {
    return addItem(db, 'g1', null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'Send reply' } }).task
  }

  it('approving a proposal keeps it active so the next run carries it out', async () => {
    propose()
    approveTask(db, 'g1', '1')
    const t = getTask(db, 'g1', '1')!
    expect(t).toMatchObject({ status: 'active', review_requested_at: null, approved_by: 'human' })
    // The agent can now complete it without another review
    expect(await checkCompletion(db, getPlan(db, 'g1')!, t, { actor: 'agent' })).toEqual({ outcome: 'pass' })
  })

  it('rejecting a proposal stores the feedback as memory', () => {
    propose()
    rejectTask(db, 'g1', '1', 'Too formal, keep it casual.')
    const [m] = listMemory(db, 'g1')
    expect(m).toMatchObject({ kind: 'preference', source: 'feedback', source_ref: '1', active: true })
    expect(m.text).toContain('Too formal, keep it casual.')
    expect(m.text).toContain('Reply to Alice')
  })

  it('a rejected proposal goes back to review when re-proposed', async () => {
    const t = propose()
    rejectTask(db, 'g1', '1', 'no')
    const again = await checkCompletion(db, getPlan(db, 'g1')!, getTask(db, 'g1', t.id)!, { actor: 'agent' })
    expect(again).toEqual({ outcome: 'awaiting_review' })
  })

  it('rejection on an ordinary plan does not create memory', async () => {
    db.prepare("INSERT INTO plans (id, name, status, working_dir, created_at, updated_at) VALUES ('p', 'P', 'active', '/', ?, ?)").run(now, now)
    db.prepare("INSERT INTO tasks (id, plan_id, goal, status, state, requires_approval, review_requested_at, created_at, updated_at) VALUES ('1', 'p', 'x', 'active', '{}', 1, ?, ?, ?)").run(now, now, now)
    rejectTask(db, 'p', '1', 'nope')
    expect(db.prepare('SELECT COUNT(*) n FROM goal_memory').get()).toEqual({ n: 0 })
  })
})

describe('buildBrief', () => {
  it('includes goal, autonomy, open items (approved first) and counts', () => {
    addItem(db, 'g1', null, { goal: 'plain', external_ref: 'gmail:1' })
    addItem(db, 'g1', null, { goal: 'proposal', action: { category: 'email.send', summary: 's' } })
    approveTask(db, 'g1', '2')
    addItem(db, 'g1', null, { goal: 'waiting', action: { category: 'email.send', summary: 's2' } })
    const b = buildBrief(db, 'g1')
    expect(b.goal).toMatchObject({ name: 'Inbox', objective: 'Inbox zero', instructions: 'Archive newsletters.' })
    expect(b.autonomy).toEqual({ default: 'propose', categories: { 'email.archive': 'auto', 'email.delete': 'off' } })
    expect(b.open_items.map((i) => i.id)).toEqual(['2', '1', '3'])
    expect(b.open_items[0]).toMatchObject({ approved_to_execute: true, action: { category: 'email.send' } })
    expect(b.counts).toMatchObject({ open: 3, awaiting_review: 1, approved_to_execute: 1 })
  })

  it('reports decisions made since the previous run only', () => {
    // Step a fake clock so each step gets its own timestamp: on a fast machine the
    // rejection could land in the same millisecond the previous run started.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let t = Date.parse('2026-01-01T00:00:00.000Z')
      const tick = () => vi.setSystemTime((t += 1000))
      tick()
      addItem(db, 'g1', null, { goal: 'old', action: { category: 'email.send', summary: 'old' } })
      approveTask(db, 'g1', '1')
      tick()
      const prev = insertRun(db, 'g1', 'manual', 'running')
      endRun(db, prev.id, 'first run')
      tick()
      addItem(db, 'g1', null, { goal: 'new', action: { category: 'email.send', summary: 'new' } })
      rejectTask(db, 'g1', '2', 'casual please')
      tick()
      const run = insertRun(db, 'g1', 'interval', 'running')
      const b = buildBrief(db, 'g1', run.id)
      expect(b.decisions_since_last_run).toEqual([expect.objectContaining({ item: '2', decision: 'rejected', feedback: 'casual please' })])
      expect(b.recent_runs).toEqual([expect.objectContaining({ summary: 'first run' })])
      expect(b.run).toMatchObject({ id: run.id, trigger: 'interval' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('includes pinned memory always and other memory within the budget', () => {
    const pinned = insertMemory(db, { plan_id: 'g1', kind: 'rule', text: 'Never archive the bank.', source: 'human', pinned: true })
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'x'.repeat(MEMORY_BRIEF_CHARS), source: 'agent' })
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Alice is my manager.', source: 'human' })
    const b = buildBrief(db, 'g1')
    expect(b.memory[0]).toMatchObject({ id: pinned.id, pinned: true })
    expect(b.memory.length + b.memory_omitted).toBe(3)
    expect(b.memory_omitted).toBeGreaterThan(0)
    expect(getMemory(db, pinned.id)!.last_used_at).not.toBeNull()
  })

  it("gives the run its deadline and when the schedule next starts one", () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const started = Date.parse(getRun(db, run.id)!.started_at)
    const minutes = getGoal(db, 'g1')!.limits.max_run_minutes
    const b = buildBrief(db, 'g1', run.id)
    expect(b.run!.deadline).toBe(new Date(started + minutes * 60_000).toISOString())
    // No schedule: nothing starts a later run on its own
    expect(b.run!.next_scheduled_run).toBeNull()

    setSchedule(db, 'g1', { kind: 'interval', minutes: 60 })
    expect(buildBrief(db, 'g1', run.id).run!.next_scheduled_run).toBe(new Date(started + 60 * 60_000).toISOString())
  })

  it('rejects a run from another goal', () => {
    expect(() => buildBrief(db, 'g1', 'run_missing')).toThrow(/not found/)
  })
})

describe('run lifecycle', () => {
  it('queueRun returns the existing open run instead of creating another', () => {
    const a = queueRun(db, 'g1')
    expect(queueRun(db, 'g1').id).toBe(a.id)
  })

  it('queueRun refuses paused goals', () => {
    updateGoal(db, 'g1', { status: 'paused' })
    expect(() => queueRun(db, 'g1')).toThrow(/paused/)
  })

  it('startRun / endRun record status, counts and last_run_at', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    expect(run.status).toBe('running')
    addItem(db, 'g1', run.id, { goal: 'a' })
    addItem(db, 'g1', run.id, { goal: 'b', action: { category: 'email.archive', summary: 'archived' } })
    const ended = endRun(db, run.id, 'Handled 2 emails.')
    expect(ended).toMatchObject({ status: 'completed', summary: 'Handled 2 emails.', items_created: 2, items_resolved: 1 })
    expect(getGoal(db, 'g1')!.last_run_at).not.toBeNull()
    expect(() => endRun(db, run.id, 'again')).toThrow(/already ended/)
  })

  it('endRun sets the goal status, keeps it when left out and clears it when empty', () => {
    const first = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, first.id, 'Checked.', '  2 PRs\n awaiting\treview ')
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: '2 PRs awaiting review', status_note_at: getRun(db, first.id)!.ended_at, status_note_untrusted: null })
    const second = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, second.id, 'Nothing new.')
    expect(getGoal(db, 'g1')!.status_note).toBe('2 PRs awaiting review')
    const third = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, third.id, 'Cleared.', '')
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: null, status_note_at: null })
  })

  it('endRun cleans the status to short plain text and notes what an untrusted run had read', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    updateRun(db, run.id, { untrusted_at: now, untrusted_source: 'mail' })
    const esc = String.fromCharCode(27)
    endRun(db, run.id, 'Done.', `${esc}[31mbroken${esc}[0m ${String.fromCharCode(0x202e)}x ${'y'.repeat(60)}`)
    const goal = getGoal(db, 'g1')!
    expect(goal.status_note_untrusted).toBe('mail')
    expect([...goal.status_note!].length).toBe(STATUS_NOTE_MAX)
    expect(goal.status_note!.startsWith('broken x yyy')).toBe(true)
    expect(goal.status_note!.endsWith('…')).toBe(true)
    expect(cleanStatusNote('clean')).toBe('clean')
  })

  it('statusNote is stale once a later run ends without setting it, or the last run failed', () => {
    const first = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, first.id, 'Checked.', 'clean')
    expect(statusNote(getGoal(db, 'g1')!, listRuns(db, 'g1', 5))).toMatchObject({ text: 'clean', stale: false, untrusted: null })
    const second = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, second.id, 'Nothing new.')
    updateRun(db, second.id, { ended_at: new Date(Date.now() + 1000).toISOString() })
    expect(statusNote(getGoal(db, 'g1')!, listRuns(db, 'g1', 5))!.stale).toBe(true)
    const third = startRun(db, queueRun(db, 'g1').id, null)
    endRun(db, third.id, 'Checked.', 'clean')
    updateRun(db, third.id, { status: 'failed' })
    expect(statusNote(getGoal(db, 'g1')!, listRuns(db, 'g1', 5))!.stale).toBe(true)
  })

  it('endRun requires a summary', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    expect(() => endRun(db, run.id, '  ')).toThrow(/summary is required/)
  })

  it('failRun marks failed/timed out and ignores finished runs', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    failRun(db, run.id, 'timed_out', 'Run exceeded 15 minutes')
    expect(getRun(db, run.id)).toMatchObject({ status: 'timed_out', summary: 'Run exceeded 15 minutes' })
    failRun(db, run.id, 'failed', 'later')
    expect(getRun(db, run.id)!.status).toBe('timed_out')
  })
})

describe('archiveResolved', () => {
  it('archives resolved items older than the retention period only', () => {
    addItem(db, 'g1', null, { goal: 'old done' })
    addItem(db, 'g1', null, { goal: 'new done' })
    addItem(db, 'g1', null, { goal: 'old open' })
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
    updateTask(db, 'g1', '1', { status: 'completed', updated_at: old })
    updateTask(db, 'g1', '2', { status: 'completed' })
    updateTask(db, 'g1', '3', { updated_at: old })
    expect(archiveResolved(db, 'g1')).toBe(1)
    expect(getTask(db, 'g1', '1')!.archived_at).not.toBeNull()
    expect(getTask(db, 'g1', '2')!.archived_at).toBeNull()
    expect(getTask(db, 'g1', '3')!.archived_at).toBeNull()
    expect(buildBrief(db, 'g1').open_items.map((i) => i.id)).toEqual(['3'])
  })
})

describe('scheduler decisions', () => {
  // A date after any next_run_at set during the test, at a chosen local time
  const at = (h: number, m = 0) => new Date(2099, 0, 5, h, m)

  it('withinActiveHours handles normal and overnight windows', () => {
    expect(withinActiveHours(undefined, at(3))).toBe(true)
    expect(withinActiveHours('08:00-20:00', at(8))).toBe(true)
    expect(withinActiveHours('08:00-20:00', at(20))).toBe(false)
    expect(withinActiveHours('22:00-06:00', at(23))).toBe(true)
    expect(withinActiveHours('22:00-06:00', at(5, 59))).toBe(true)
    expect(withinActiveHours('22:00-06:00', at(12))).toBe(false)
  })

  function intervalGoal(id: string, activeHours?: string) {
    createGoal(db, { ...plan, id }, { objective: 'x' }, { minutes: 30, active_hours: activeHours })
  }

  it('starts an interval goal when due, and nothing when not due', () => {
    intervalGoal('g2')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'start', trigger: 'interval' })
    updateGoal(db, 'g2', { next_run_at: new Date(Date.now() + 3_600_000).toISOString() })
    expect(decideTick(db, 'g2')).toEqual({ action: 'none' })
  })

  it('starts a queued manual run even without an interval', () => {
    const q = queueRun(db, 'g1')
    expect(decideTick(db, 'g1')).toEqual({ action: 'start', trigger: 'manual', queuedRunId: q.id })
  })

  it('does nothing while a run is in progress or the goal is paused', () => {
    intervalGoal('g2')
    const r = insertRun(db, 'g2', 'interval', 'running')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'none' })
    updateRun(db, r.id, { status: 'completed' })
    updateGoal(db, 'g2', { status: 'paused' })
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'none' })
  })

  it('defers outside active hours', () => {
    intervalGoal('g2', '08:00-09:00')
    const d = decideTick(db, 'g2', at(23))
    expect(d.action).toBe('defer')
  })

  it('skips once the daily run limit is reached', () => {
    intervalGoal('g2')
    updateGoal(db, 'g2', { limits: { max_runs_per_day: 1 } })
    insertRun(db, 'g2', 'interval', 'completed')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toMatchObject({ action: 'skip', reason: expect.stringMatching(/daily run limit/) })
  })

  it('nextIntervalRun adds the interval; null without one', () => {
    intervalGoal('g2')
    const from = new Date('2026-01-01T00:00:00Z')
    expect(nextIntervalRun(db, 'g2', from)).toBe('2026-01-01T00:30:00.000Z')
    expect(nextIntervalRun(db, 'g1', from)).toBeNull()
  })

  it('recordSkip records at most once per hour per reason', () => {
    expect(recordSkip(db, 'g1', 'interval', 'channel busy')).not.toBeNull()
    expect(recordSkip(db, 'g1', 'interval', 'channel busy')).toBeNull()
    expect(recordSkip(db, 'g1', 'interval', 'not connected')).not.toBeNull()
    expect(listRuns(db, 'g1')).toHaveLength(2)
  })
})

describe('runaway breaker', () => {
  const finishRun = (trigger: 'manual' | 'event' | 'interval' = 'event') => {
    const run = queueRun(db, 'g1', trigger)
    startRun(db, run.id, null)
    return endRun(db, run.id, 'nothing to do')
  }

  it('pauses the goal and asks the person after too many unscheduled runs that resolve nothing', () => {
    for (let i = 0; i < 4; i++) finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
    finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('paused')
    const ask = breakerAsks()
    expect(ask).toHaveLength(1)
    expect(ask[0].notes).toMatch(/5 unscheduled runs in a row resolved no item/)
  })

  const breakerAsks = () => db.prepare("SELECT * FROM tasks WHERE plan_id = 'g1' AND external_ref = 'runaway-breaker'").all() as
    { id: string; goal: string; notes: string; status: string; result: string | null; review_requested_at: string | null }[]

  /** A fake clock stepped a second per call, so runs and the resume never share a millisecond. */
  const withClock = (fn: (tick: () => void) => void) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let t = Date.parse('2026-01-01T00:00:00.000Z')
      fn(() => vi.setSystemTime((t += 1000)))
    } finally {
      vi.useRealTimers()
    }
  }

  it('counts only runs since the goal was resumed, and asks again with the same question', () => withClock((tick) => {
    for (let i = 0; i < 5; i++) { tick(); finishRun() }
    expect(getGoal(db, 'g1')!.status).toBe('paused')
    tick()
    updateGoal(db, 'g1', { status: 'active' })
    expect(getGoal(db, 'g1')!.resumed_at).toBe(new Date().toISOString())
    // Resuming answered "Resume it?", so it leaves Needs you
    expect(breakerAsks()).toEqual([expect.objectContaining({ status: 'completed', result: 'Resumed' })])
    tick(); finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
    for (let i = 0; i < 4; i++) { tick(); finishRun() }
    expect(getGoal(db, 'g1')!.status).toBe('paused')
    // The same item, open again: a second trip in the hour isn't lost
    const asks = breakerAsks()
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ status: 'active', result: null })
    expect(asks[0]!.review_requested_at).toBe(new Date().toISOString())
  }))

  it('counts the hour from the resume too', () => withClock((tick) => {
    updateGoal(db, 'g1', { limits: { max_runs_per_hour: 3, max_idle_runs: 0 } })
    for (let i = 0; i < 4; i++) { tick(); finishRun('interval') }
    expect(getGoal(db, 'g1')!.status).toBe('paused')
    tick()
    updateGoal(db, 'g1', { status: 'active' })
    for (let i = 0; i < 3; i++) { tick(); finishRun('interval') }
    expect(getGoal(db, 'g1')!.status).toBe('active')
    tick(); finishRun('interval')
    expect(getGoal(db, 'g1')!.status).toBe('paused')
  }))

  it('answering the question and then resuming also starts the count afresh', () => withClock((tick) => {
    for (let i = 0; i < 5; i++) { tick(); finishRun() }
    tick()
    decideItem(db, 'g1', breakerAsks()[0]!.id, { decision: 'answer', feedback: 'Yes, carry on' })
    expect(getGoal(db, 'g1')!.status).toBe('paused')
    tick()
    updateGoal(db, 'g1', { status: 'active' })
    tick(); finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
    expect(breakerAsks()).toEqual([expect.objectContaining({ status: 'completed' })])
  }))

  it('a pause and resume for some other reason resets the count as well, and asks nothing', () => withClock((tick) => {
    for (let i = 0; i < 4; i++) { tick(); finishRun() }
    tick(); updateGoal(db, 'g1', { status: 'paused' })
    tick(); updateGoal(db, 'g1', { status: 'active' })
    tick(); finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
    expect(breakerAsks()).toHaveLength(0)
  }))

  it('leaves idle scheduled runs alone', () => {
    for (let i = 0; i < 6; i++) finishRun('interval')
    expect(getGoal(db, 'g1')!.status).toBe('active')
  })

  it('a run that resolves an item resets the idle count', () => {
    for (let i = 0; i < 4; i++) finishRun()
    const run = queueRun(db, 'g1', 'event')
    startRun(db, run.id, null)
    const item = addItem(db, 'g1', run.id, { goal: 'x' }).task
    updateTask(db, 'g1', item.id, { status: 'completed' })
    endRun(db, run.id, 'did one')
    finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
  })

  it('pauses after more runs in an hour than max_runs_per_hour', () => {
    updateGoal(db, 'g1', { limits: { max_runs_per_hour: 3, max_idle_runs: 0 } })
    for (let i = 0; i < 3; i++) finishRun('interval')
    expect(getGoal(db, 'g1')!.status).toBe('active')
    finishRun('interval')
    expect(getGoal(db, 'g1')!.status).toBe('paused')
  })

  it('is off when both limits are 0', () => {
    updateGoal(db, 'g1', { limits: { max_runs_per_hour: 0, max_idle_runs: 0 } })
    for (let i = 0; i < 12; i++) finishRun()
    expect(getGoal(db, 'g1')!.status).toBe('active')
  })
})

describe('per-item attempt limits', () => {
  const newRun = () => { const r = queueRun(db, 'g1', 'event'); startRun(db, r.id, null); return r.id }
  const question = () => db.prepare("SELECT * FROM tasks WHERE plan_id = 'g1' AND external_ref LIKE 'attempt-limit:%'").get() as { id: string; goal: string; status: string } | undefined

  beforeEach(() => updateGoal(db, 'g1', { limits: { max_idle_runs: 0, max_runs_per_hour: 0 } }))

  it('counts each run once, and asks the person instead of a fourth attempt', () => {
    const item = addItem(db, 'g1', null, { goal: 'Fix CI on PR 31', external_ref: 'ci:31' }).task
    for (let i = 0; i < 3; i++) {
      const run = newRun()
      recordAttempt(db, 'g1', item.id, run)
      recordAttempt(db, 'g1', item.id, run) // same run again: still one attempt
      endRun(db, run, 'tried')
    }
    expect(countAttempts(db, 'g1', getTask(db, 'g1', item.id)!)).toBe(3)
    const fourth = newRun()
    expect(() => recordAttempt(db, 'g1', item.id, fourth)).toThrow(/limit of 3 attempts/)
    expect(question()).toMatchObject({ status: 'active' })
    expect(isAttemptBlocked(db, 'g1', getTask(db, 'g1', item.id)!)).toBe(true)
    expect(() => recordAttempt(db, 'g1', item.id, fourth)).toThrow(/blocked/)
    expect(buildBrief(db, 'g1').open_items.find((i) => i.id === item.id)).toMatchObject({ blocked: true })
  })

  it('counts a new item with the same external_ref as the same thread of work', () => {
    for (let i = 0; i < 3; i++) {
      const run = newRun()
      const item = addItem(db, 'g1', run, { goal: `Fix CI on PR 31, try ${i}`, external_ref: 'ci:31' }).task
      recordAttempt(db, 'g1', item.id, run)
      endRun(db, run, 'tried')
    }
    // A fresh item for the same PR under the same ref is returned, not created; a different item sharing the ref still counts
    const run = newRun()
    const again = addItem(db, 'g1', run, { goal: 'Fix CI on PR 31 again', external_ref: 'ci:31' }).task
    expect(() => recordAttempt(db, 'g1', again.id, run)).toThrow(/limit of 3 attempts/)
  })

  it("the person's answer lifts the block and starts a fresh count", () => {
    const item = addItem(db, 'g1', null, { goal: 'Hard one' }).task
    for (let i = 0; i < 3; i++) { const r = newRun(); recordAttempt(db, 'g1', item.id, r); endRun(db, r, 'tried') }
    const r = newRun()
    expect(() => recordAttempt(db, 'g1', item.id, r)).toThrow(/limit/)
    decideItem(db, 'g1', question()!.id, { decision: 'answer', feedback: 'Keep going, try the other API' })
    expect(() => recordAttempt(db, 'g1', item.id, r, new Date(Date.now() + 1000))).not.toThrow()
    expect(countAttempts(db, 'g1', getTask(db, 'g1', item.id)!)).toBe(1)
  })

  it('is off at 0', () => {
    updateGoal(db, 'g1', { limits: { max_item_attempts: 0 } })
    const item = addItem(db, 'g1', null, { goal: 'x' }).task
    for (let i = 0; i < 6; i++) { const r = newRun(); recordAttempt(db, 'g1', item.id, r); endRun(db, r, 'tried') }
    expect(question()).toBeUndefined()
  })
})
