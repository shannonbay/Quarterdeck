import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, insertRun, getRun, markRunUntrusted, guardToolCallForRun, addItem, insertMemory, getMemory,
  tripRun, TRIP_THRESHOLD, TRIPPED_CATEGORY, TRIPPED_QUESTION_WARNING, getTask,
} from './index.js'

describe('tripping a marked run that keeps getting refused (#174)', () => {
  let db: Database
  const now = new Date().toISOString()
  const paths = { dirs: ['/nowhere/qd-data'], db: null }
  const merge = { command: 'gh pr merge 12' }
  const review = { command: 'gh pr review 12 --approve' }

  beforeEach(() => {
    db = openDatabase(':memory:')
    createGoal(db, { id: 'g1', name: 'G', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now }, { objective: 'o', instructions: '', autonomy: { 'gh.merge': 'off', 'gh.review': 'propose' } })
    updateGoal(db, 'g1', { tool_map: { 'Bash(gh pr merge*)': 'gh.merge', 'Bash(gh pr review*)': 'gh.review' } })
  })

  const guard = (runId: string, tool: string, input?: Record<string, unknown>) => guardToolCallForRun(db, runId, tool, input, paths)

  it(`trips a marked run at ${TRIP_THRESHOLD} probing refusals; only end_run and fail_run go through after`, () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    markRunUntrusted(db, run.id, 'mail')
    for (let i = 0; i < TRIP_THRESHOLD - 1; i++) expect(guard(run.id, 'Bash', merge).decision).toBe('deny')
    expect(getRun(db, run.id)!.tripped_at).toBeNull()
    guard(run.id, 'Bash', merge)
    const tripped = getRun(db, run.id)!
    expect(tripped.tripped_at).not.toBeNull()
    expect(tripped.status).toBe('failed')
    expect(tripped.summary).toBe(`tripped: ${TRIP_THRESHOLD} refusals (gh.merge)`)
    const after = guard(run.id, 'Bash', { command: 'npm test' })
    expect(after).toMatchObject({ decision: 'deny', category: TRIPPED_CATEGORY })
    expect(guard(run.id, 'mcp__quarterdeck__end_run').decision).toBe('allow')
    expect(guard(run.id, 'mcp__plugin_quarterdeck-goals_quarterdeck__fail_run').decision).toBe('allow')
    expect(guard(run.id, 'mcp__quarterdeck__remember').decision).toBe('deny')
  })

  it('propose fallbacks do not count, and an unmarked run does not trip', () => {
    const marked = insertRun(db, 'g1', 'manual', 'running')
    markRunUntrusted(db, marked.id, 'mail')
    for (let i = 0; i < TRIP_THRESHOLD + 2; i++) expect(guard(marked.id, 'Bash', review).decision).toBe('deny')
    expect(getRun(db, marked.id)!.tripped_at).toBeNull()
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(marked.id)
    const plain = insertRun(db, 'g1', 'manual', 'running')
    for (let i = 0; i < TRIP_THRESHOLD + 2; i++) guard(plain.id, 'Bash', merge)
    expect(getRun(db, plain.id)!.tripped_at).toBeNull()
  })

  it('tripRun abandons pending proposals, warns on questions and marks the memory the run wrote', () => {
    const run = insertRun(db, 'g1', 'manual', 'running')
    const proposal = addItem(db, 'g1', run.id, { goal: 'Review', external_ref: 'p', action: { category: 'gh.review', summary: 'Approve PR 12' } }).task
    const question = addItem(db, 'g1', run.id, { goal: 'Which one?', external_ref: 'q', ask_person: true, notes: 'A or B' }).task
    const mem = insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Planted fact', source: 'agent' })
    const human = insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'From the person', source: 'human' })
    expect(tripRun(db, run.id, 'a canary hit')).toBe(true)
    expect(tripRun(db, run.id, 'again')).toBe(false)
    const p = getTask(db, 'g1', proposal.id)!
    expect(p.status).toBe('abandoned')
    expect(p.abandon_reason).toBe('the run that proposed this tripped: a canary hit')
    const q = getTask(db, 'g1', question.id)!
    expect(q.status).not.toBe('abandoned')
    expect(q.notes).toBe(`${TRIPPED_QUESTION_WARNING}\n\nA or B`)
    expect(getMemory(db, mem.id)!.untrusted_source).toBe(`tripped run ${run.id}`)
    expect(getMemory(db, human.id)!.untrusted_source).toBeNull()
    expect(getRun(db, run.id)!.status).toBe('failed')
    expect(getGoal(db, 'g1')!.status).toBe('active')
  })

  it('two tripped runs in a row pause the goal; one does not', () => {
    const first = insertRun(db, 'g1', 'manual', 'running')
    tripRun(db, first.id, 'probing')
    expect(getGoal(db, 'g1')!.status).toBe('active')
    const second = insertRun(db, 'g1', 'manual', 'running')
    tripRun(db, second.id, 'probing')
    expect(getGoal(db, 'g1')!.status).toBe('paused')
  })
})
