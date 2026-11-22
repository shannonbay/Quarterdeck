import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import { openDatabase, createGoal, setWatch, getWatch, recordWatchLines, watchNeverSaw, neverSawHint, buildOverview, buildBrief, firstCheckWarnings, sampleLines } from './index.js'

let db: Database
const t0 = new Date('2026-11-01T00:00:00.000Z')
const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000)

beforeEach(() => {
  db = openDatabase(':memory:')
  const now = t0.toISOString()
  createGoal(db, { id: 'g1', name: 'Flips', description: null, status: 'active', working_dir: null, created_at: now, updated_at: now }, { objective: 'Watch the inbox', instructions: '' })
})

describe('a watch that has never seen anything (#185)', () => {
  it('is not flagged before its first check', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo' })
    expect(watchNeverSaw(getWatch(db, w.id)!, at(100))).toBe(false)
  })

  it('is flagged once zero lines since its baseline last 24 hours', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo', every_minutes: 60 })
    recordWatchLines(db, w.id, { lines: [] }, at(0))
    recordWatchLines(db, w.id, { lines: [] }, at(12))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(23))).toBe(false)
    expect(watchNeverSaw(getWatch(db, w.id)!, at(24))).toBe(true)
  })

  it('is flagged when every check saw the same one line', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo', every_minutes: 60 })
    for (let h = 0; h <= 24; h += 6) recordWatchLines(db, w.id, { lines: ['URL: https://example.com'] }, at(h))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(25))).toBe(true)
  })

  it('waits for 3 checks when they are more than 8 hours apart', () => {
    const w = setWatch(db, 'g1', 'daily', { command: 'echo', every_minutes: 24 * 60 })
    recordWatchLines(db, w.id, { lines: [] }, at(0))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(48))).toBe(false)
    expect(watchNeverSaw(getWatch(db, w.id)!, at(72))).toBe(true)
  })

  it('clears once a check sees a second distinct line, which also fires', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo', every_minutes: 60 })
    recordWatchLines(db, w.id, { lines: ['a'] }, at(0))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(30))).toBe(true)
    recordWatchLines(db, w.id, { lines: ['a', 'b'] }, at(31))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(31))).toBe(false)
  })

  it("clears for a 'change' watch that fired, though it keeps only the last line", () => {
    const w = setWatch(db, 'g1', 'price', { command: 'echo', every_minutes: 60, fires: 'change' })
    recordWatchLines(db, w.id, { lines: ['$10'] }, at(0))
    recordWatchLines(db, w.id, { lines: ['$12'] }, at(1))
    expect(getWatch(db, w.id)!.seen).toEqual(['$12'])
    expect(watchNeverSaw(getWatch(db, w.id)!, at(30))).toBe(false)
  })

  it('is never flagged for a status watch, which reads one value and may never fire', () => {
    const w = setWatch(db, 'g1', 'pr', { command: 'echo', every_minutes: 60, status: { rules: [{ match: 'OPEN', status: 'PR open' }] } })
    recordWatchLines(db, w.id, { lines: ['OPEN'] }, at(0))
    recordWatchLines(db, w.id, { lines: ['OPEN'] }, at(30))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(31))).toBe(false)
  })

  it("is not flagged for a 'change' watch that keeps seeing one value, only for zero lines", () => {
    const w = setWatch(db, 'g1', 'price', { command: 'echo', every_minutes: 60, fires: 'change' })
    recordWatchLines(db, w.id, { lines: ['v1'] }, at(0))
    recordWatchLines(db, w.id, { lines: ['v1'] }, at(30))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(31))).toBe(false)
    const empty = setWatch(db, 'g1', 'empty', { command: 'echo', every_minutes: 60, fires: 'change' })
    recordWatchLines(db, empty.id, { lines: [] }, at(0))
    expect(watchNeverSaw(getWatch(db, empty.id)!, at(30))).toBe(true)
  })

  it('resets when the watch is edited', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo', every_minutes: 60 })
    recordWatchLines(db, w.id, { lines: [] }, at(0))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(30))).toBe(true)
    setWatch(db, 'g1', 'inbox', { command: 'echo other', every_minutes: 60 })
    expect(watchNeverSaw(getWatch(db, w.id)!, at(30))).toBe(false)
    recordWatchLines(db, w.id, { lines: [] }, at(30))
    expect(watchNeverSaw(getWatch(db, w.id)!, at(40))).toBe(false)
  })

  it('shows in the overview and the brief, and not while the watch is new', () => {
    const w = setWatch(db, 'g1', 'inbox', { command: 'echo', every_minutes: 60 })
    recordWatchLines(db, w.id, { lines: [] }, new Date())
    expect(buildOverview(db, 'all').goals[0]).toMatchObject({ watch_never_saw: false, watches: [{ name: 'inbox', never_saw: false }] })
    expect(buildBrief(db, 'g1').watches_never_saw).toBeUndefined()
    db.prepare('UPDATE goal_watches SET baseline_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), w.id)
    expect(buildOverview(db, 'all').goals[0]).toMatchObject({ watch_never_saw: true, watches: [{ name: 'inbox', never_saw: true }] })
    expect(buildOverview(db, []).goals[0]).toMatchObject({ watch_never_saw: true, watches: [] })
    expect(buildBrief(db, 'g1').watches_never_saw).toEqual([{ name: 'inbox', hint: neverSawHint('inbox') }])
  })

  it('warns when the first check got zero lines, or one same line for a watch of new lines', () => {
    const fresh = { fires: 'new' as const, status_rules: null }
    expect(firstCheckWarnings(fresh, [])).toEqual([expect.stringMatching(/zero lines/)])
    expect(firstCheckWarnings(fresh, ['URL: https://example.com'])).toEqual([expect.stringMatching(/same/)])
    expect(firstCheckWarnings(fresh, ['#1', '#2'])).toEqual([])
    // One value is what a change or status watch reads by design
    expect(firstCheckWarnings({ fires: 'change', status_rules: null }, ['$10'])).toEqual([])
    expect(firstCheckWarnings({ fires: 'new', status_rules: { rules: [] } }, ['ok'])).toEqual([])
    expect(sampleLines(['a', 'b', 'c', 'd'])).toBe('"a", "b", "c"')
  })

  it('names the watch and propose_watch in the hint', () => {
    expect(neverSawHint('inbox')).toBe('watch inbox has never seen anything: check the source yourself and propose a fix with propose_watch')
  })
})
