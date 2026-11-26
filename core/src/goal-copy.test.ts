import { describe, expect, it } from 'vitest'
import { copyGoal, moveGoal, repoOfRemote, rewriteForCopy, watchSpecOf } from './goal-copy.js'
import { applyGoalChanges, queueRun, createGoal, getGoal, getPlan, getSchedule, listMemory, listWatches, openDatabase, setSchedule, updateGoal, type Watch } from './index.js'

const win = { fromDir: 'C:\\Users\\me\\GitHub\\Alpha', toDir: 'C:\\Users\\me\\GitHub\\Beta', fromRepo: 'me/Alpha', toRepo: 'me/Beta', caseInsensitive: true }

describe('rewriteForCopy (#208)', () => {
  it('replaces the folder in both slash forms, keeping the form used', () => {
    const r = rewriteForCopy('cd C:\\Users\\me\\GitHub\\Alpha && ls C:/Users/me/GitHub/Alpha/src', win)
    expect(r.value).toBe('cd C:\\Users\\me\\GitHub\\Beta && ls C:/Users/me/GitHub/Beta/src')
    expect(r.replacements).toHaveLength(2)
  })

  it('matches any case on Windows, and only the exact case otherwise', () => {
    expect(rewriteForCopy('c:\\users\\ME\\github\\alpha', win).value).toBe('C:\\Users\\me\\GitHub\\Beta')
    const posix = { fromDir: '/home/me/alpha', toDir: '/home/me/beta', caseInsensitive: false }
    expect(rewriteForCopy('/home/me/Alpha and /home/me/alpha', posix).value).toBe('/home/me/Alpha and /home/me/beta')
  })

  it('ignores a trailing separator on either folder', () => {
    const r = rewriteForCopy('in C:\\Users\\me\\GitHub\\Alpha\\', { ...win, fromDir: win.fromDir + '\\', toDir: win.toDir + '/' })
    expect(r.value).toBe('in C:\\Users\\me\\GitHub\\Beta\\')
  })

  it("doesn't touch a longer folder that starts the same", () => {
    expect(rewriteForCopy('C:\\Users\\me\\GitHub\\Alpha-issue-fix', win).value).toBe('C:\\Users\\me\\GitHub\\Alpha-issue-fix')
  })

  it('replaces owner/name, case-insensitively, but not inside a longer name', () => {
    const r = rewriteForCopy('gh pr list -R ME/alpha; me/Alphabet; other-me/Alpha; github.com/me/Alpha.', win)
    expect(r.value).toBe('gh pr list -R me/Beta; me/Alphabet; other-me/Alpha; github.com/me/Beta.')
    expect(r.replacements).toEqual([{ from: 'ME/alpha', to: 'me/Beta', count: 1 }, { from: 'me/Alpha', to: 'me/Beta', count: 1 }])
  })

  it('leaves the repo alone when either folder has no forge remote', () => {
    expect(rewriteForCopy('me/Alpha', { ...win, toRepo: null }).value).toBe('me/Alpha')
    expect(rewriteForCopy('me/Alpha', { ...win, fromRepo: undefined }).value).toBe('me/Alpha')
  })

  it('rewrites every string in a watch spec and counts repeats', () => {
    const watch = { tool: 'mcp__x__list', tool_input: { repo: 'me/Alpha', n: 5 }, steps: [{ tool: 't', input: { path: 'C:/Users/me/GitHub/Alpha' } }], finally: null, urgent: true }
    const r = rewriteForCopy(watch, win)
    expect(r.value).toEqual({ tool: 'mcp__x__list', tool_input: { repo: 'me/Beta', n: 5 }, steps: [{ tool: 't', input: { path: 'C:/Users/me/GitHub/Beta' } }], finally: null, urgent: true })
    expect(rewriteForCopy('me/Alpha me/Alpha', win).replacements).toEqual([{ from: 'me/Alpha', to: 'me/Beta', count: 2 }])
  })

  it('makes no replacements when copying to the same folder', () => {
    expect(rewriteForCopy('C:\\Users\\me\\GitHub\\Alpha', { ...win, toDir: win.fromDir, toRepo: win.fromRepo }).replacements).toEqual([])
  })

  it('finishes quickly on a long input', () => {
    const start = Date.now()
    rewriteForCopy('C:\\'.repeat(100_000) + 'me/'.repeat(100_000), win)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('copyGoal (#208)', () => {
  const now = new Date().toISOString()
  const plan = (id: string, dir: string) => ({ id, name: 'Fixer', description: null, status: 'active' as const, working_dir: dir, created_at: now, updated_at: now })

  it('copies how the goal works and nothing about its old project, paused with nothing due', () => {
    const db = openDatabase(':memory:')
    createGoal(db, plan('src', '/a'), { objective: 'Fix issues', instructions: 'Work in /a', autonomy: { 'email.send': 'auto' }, limits: { max_run_minutes: 30, min_watch_gap_minutes: 5 }, one_off: false, model: 'sonnet' })
    applyGoalChanges(db, 'src', {
      tool_map: { 'mcp__x__send*': 'email.send' },
      auto_after_outside: { 'email.send': true },
      watches: {
        issues: { command: 'gh issue list -R me/a', match: '^[0-9]+', ignore: 'x', every_minutes: 10, urgent: true },
        mail: { steps: [{ tool: 'mcp__gmail__search', input: { q: 'a' } }], finally: { tool: 'mcp__gmail__label', input: {} }, fires: 'change' },
      },
      add_memory: [{ kind: 'fact', text: 'about the old project' }],
    })
    setSchedule(db, 'src', { kind: 'interval', minutes: 60 })
    updateGoal(db, 'src', { next_run_at: now })

    const copy = copyGoal(db, 'src', { id: 'dst', name: 'Fixer copy', working_dir: '/b', instructions: 'Work in /b' })
    expect(copy).toMatchObject({ objective: 'Fix issues', instructions: 'Work in /b', status: 'paused', next_run_at: null, autonomy: { 'email.send': 'auto' }, tool_map: { 'mcp__x__send*': 'email.send' }, auto_after_outside: ['email.send'], one_off: false, model: 'sonnet' })
    expect(copy.limits).toEqual(getGoal(db, 'src')!.limits)
    expect(getPlan(db, 'dst')).toMatchObject({ name: 'Fixer copy', working_dir: '/b' })
    expect(getSchedule(db, 'dst')).toEqual(getSchedule(db, 'src'))
    const strip = (w: Watch) => ({ ...watchSpecOf(w), name: w.name })
    expect(listWatches(db, 'dst').map(strip)).toEqual(listWatches(db, 'src').map(strip))
    for (const w of listWatches(db, 'dst')) expect(w).toMatchObject({ seen: [], baseline_at: null, last_checked_at: null })
    expect(listMemory(db, 'dst')).toEqual([])
  })

  it('refuses a goal that does not exist', () => {
    const db = openDatabase(':memory:')
    expect(() => copyGoal(db, 'nope', { id: 'dst', name: 'x', working_dir: '/b' })).toThrow(/not found/)
  })
})

describe('moveGoal', () => {
  const now = new Date().toISOString()
  const setUp = () => {
    const db = openDatabase(':memory:')
    createGoal(db, { id: 'g', name: 'Fixer', description: null, status: 'active', working_dir: '/a', created_at: now, updated_at: now },
      { objective: 'Fix issues', instructions: 'Work in /a', autonomy: {}, limits: { max_run_minutes: 30, min_watch_gap_minutes: 5 }, one_off: false, model: null })
    applyGoalChanges(db, 'g', {
      watches: { issues: { command: 'gh issue list' }, mail: { tool: 'mcp__gmail__search', input: { q: 'a' } }, old: { command: 'ls /a/old' } },
      add_memory: [{ kind: 'fact', text: 'kept' }],
    })
    // Every watch has a baseline before the move
    db.prepare("UPDATE goal_watches SET seen = '[\"x\"]', baseline_at = ?, last_checked_at = ?").run(now, now)
    return db
  }

  it('keeps the goal and its memory, saves what the person confirmed and starts command watches afresh', () => {
    const db = setUp()
    const specs = Object.fromEntries(listWatches(db, 'g').filter((w) => w.name !== 'old').map((w) => [w.name, watchSpecOf(w)]))
    const moved = moveGoal(db, 'g', { working_dir: '/b', instructions: 'Work in /b', watches: specs })
    expect(moved).toMatchObject({ instructions: 'Work in /b', status: 'active' })
    expect(getPlan(db, 'g')!.working_dir).toBe('/b')
    expect(listMemory(db, 'g').map((m) => m.text)).toEqual(['kept'])
    const watches = Object.fromEntries(listWatches(db, 'g').map((w) => [w.name, w]))
    expect(Object.keys(watches).sort()).toEqual(['issues', 'mail'])
    // The command runs in the new folder, so it starts again; the unchanged tool watch keeps what it saw
    expect(watches.issues).toMatchObject({ seen: [], baseline_at: null })
    expect(watches.mail).toMatchObject({ seen: ['x'], baseline_at: now })
  })

  it('refuses a missing goal and a goal with a run going', () => {
    const db = setUp()
    expect(() => moveGoal(db, 'nope', { working_dir: '/b' })).toThrow(/not found/)
    queueRun(db, 'g')
    expect(() => moveGoal(db, 'g', { working_dir: '/b' })).toThrow(/run is going/)
    expect(getPlan(db, 'g')!.working_dir).toBe('/a')
  })
})

describe('repoOfRemote', () => {
  it('reads owner/name from https, ssh and scp-like remotes', () => {
    expect(repoOfRemote('https://github.com/me/Alpha.git')).toBe('me/Alpha')
    expect(repoOfRemote('ssh://git@github.com:22/me/Alpha')).toBe('me/Alpha')
    expect(repoOfRemote('git@github.com:me/Alpha.git\n')).toBe('me/Alpha')
    expect(repoOfRemote('C:/repos/alpha')).toBeNull()
  })
})
