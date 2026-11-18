import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, getGoal, updateGoal, insertRun, getTask, decideItem, listWatches, setWatch, proposeWatch, applyWatchRequest, isWatchRequest,

} from './index.js'

let db: Database
let run: string
beforeEach(() => {
  db = openDatabase(':memory:')
  const now = new Date().toISOString()
  createGoal(db, { id: 'g1', name: 'Sale', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }, {
    objective: 'Sell it', autonomy: { 'email.send': 'propose' },
  } as never)
  updateGoal(db, 'g1', { tool_map: { 'mcp__mail__send': 'email.send' } } as never)
  run = insertRun(db, 'g1', 'manual', 'running').id
})

describe('a run proposes a watch', () => {
  it('writes one request showing the whole command and sets no watch', () => {
    const t = proposeWatch(db, 'g1', run, { name: 'buyer', spec: { command: 'gh pr list', every_minutes: 5 }, reason: 'tell me when a buyer replies' })
    expect(isWatchRequest(t)).toBe(true)
    expect(t.notes).toContain('gh pr list')
    expect(t.notes).toContain('Every 5 min')
    expect(t.notes).toContain('buyer replies')
    expect(t.review_requested_at).not.toBeNull()
    expect(listWatches(db, 'g1')).toEqual([])
  })

  it('refuses what update_goal refuses', () => {
    expect(() => proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'x', every_minutes: 0 } })).toThrow(/minute/)
    expect(() => proposeWatch(db, 'g1', run, { name: 'a', spec: { tool: 'Bash' } })).toThrow(/mcp__/)
    expect(() => proposeWatch(db, 'g1', run, { name: 'a', spec: { tool: 'mcp__mail__send' } })).toThrow(/propose/)
    expect(() => proposeWatch(db, 'g1', run, { name: '', spec: { command: 'x' } })).toThrow(/name/)
  })

  it('needs an open run, and refuses a second waiting request for a name', () => {
    expect(() => proposeWatch(db, 'g1', null, { name: 'a', spec: { command: 'x' } })).toThrow(/open run/)
    const t = proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'x' } })
    expect(() => proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'y' } })).toThrow(new RegExp(t.id))
  })

  it('Approve sets the watch as proposed and queues a run; Reject sets none and keeps feedback', () => {
    const t = proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'echo hi', every_minutes: 3 } })
    const r = decideItem(db, 'g1', t.id, { decision: 'approve' })
    expect(r.watch?.command).toBe('echo hi')
    expect(r.queuedRun).not.toBeNull()
    expect(listWatches(db, 'g1')).toHaveLength(1)
    expect(getTask(db, 'g1', t.id)!.status).toBe('completed')

    const u = proposeWatch(db, 'g1', run, { name: 'b', spec: { command: 'echo no' } })
    decideItem(db, 'g1', u.id, { decision: 'reject', feedback: 'too noisy' })
    expect(listWatches(db, 'g1').map((w) => w.name)).toEqual(['a'])
    expect(getTask(db, 'g1', u.id)!.status).toBe('abandoned')
    // after a rejection the same name can be proposed again
    expect(() => proposeWatch(db, 'g1', run, { name: 'b', spec: { command: 'echo no' } })).not.toThrow()
  })

  it('refuses an answer', () => {
    const t = proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'x' } })
    expect(() => decideItem(db, 'g1', t.id, { decision: 'answer', feedback: 'ok' })).toThrow(/approve or reject/)
  })

  it('shows old and new when replacing, and refuses whole if the watch changed since', () => {
    setWatch(db, 'g1', 'a', { command: 'old' })
    const t = proposeWatch(db, 'g1', run, { name: 'a', spec: { command: 'new' } })
    expect(t.notes).toContain('Now:')
    expect(t.notes).toContain('Proposed:')
    setWatch(db, 'g1', 'a', { command: 'changed by the person' })
    expect(() => applyWatchRequest(db, 'g1', t.id)).toThrow(/changed since/)
    expect(listWatches(db, 'g1')[0]!.command).toBe('changed by the person')
    expect(getTask(db, 'g1', t.id)!.review_requested_at).not.toBeNull()
  })

  it("is refused if the spec stopped validating (the goal's rules changed)", () => {
    const t = proposeWatch(db, 'g1', run, { name: 'a', spec: { tool: 'mcp__mail__read' } })
    updateGoal(db, 'g1', { tool_map: { 'mcp__mail__read': 'email.send' } } as never)
    expect(() => decideItem(db, 'g1', t.id, { decision: 'approve' })).toThrow(/propose/)
    expect(listWatches(db, 'g1')).toEqual([])
  })
})
