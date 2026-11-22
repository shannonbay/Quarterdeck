import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, getGoal, getPlan, listMemory, insertMemory, queueRun, getRun, claimRun, schedulerPass, buildOverview,
  applyGoalChanges, normalizeModel, reportRunEnd, reportRunProgress, insertEvent, getRunHold, setRunHold, clearRunHold, parseLimitReset, isUsageLimit, addItem, getTask, updateGoal, applyInstructionEdits,
  setRunStep, STEP_MAX, endRun, failRun, markRunUntrusted, updateRun, isRiskyToolRule, autoAfterOutsideWarning,
  getAutonomySuggestions, approveTask, rejectTask, PROMOTE_AFTER,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto' } })
})

describe('instruction edits', () => {
  beforeEach(() => { updateGoal(db, 'g1', { instructions: 'Find stale senders. Propose one item per sender. Never send mail.' }) })

  it('the overview cuts long instructions unless asked for them whole', () => {
    const long = `${'Read each issue. '.repeat(120)}The end.`
    updateGoal(db, 'g1', { instructions: long })
    const cut = buildOverview(db, ['g1']).goals[0]!.instructions
    expect(cut.length).toBeLessThan(long.length)
    expect(cut.endsWith('…')).toBe(true)
    expect(buildOverview(db, ['g1'], null, true).goals[0]!.instructions).toBe(long)
  })

  it('replaces each old text, in order, and says how many', () => {
    expect(applyGoalChanges(db, 'g1', { instructions_edits: [
      { old: 'Propose one item per sender.', new: 'Propose one item per sender, with its count.' },
      { old: 'its count', new: 'its message count' }, // sees the edit before it
      { old: ' Never send mail.', new: '' },
    ] })).toEqual(['instructions edited (3 changes)'])
    expect(getGoal(db, 'g1')!.instructions).toBe('Find stale senders. Propose one item per sender, with its message count.')
  })

  it('refuses text that is missing, there twice or empty, or edits with full instructions, changing nothing', () => {
    expect(() => applyGoalChanges(db, 'g1', { name: 'Other', instructions_edits: [{ old: 'Archive', new: 'x' }] })).toThrow(/don't contain/)
    expect(() => applyGoalChanges(db, 'g1', { instructions_edits: [{ old: 'sender', new: 'x' }] })).toThrow(/more than once/)
    expect(() => applyGoalChanges(db, 'g1', { instructions_edits: [{ old: '', new: 'x' }] })).toThrow(/needs the text/)
    expect(() => applyGoalChanges(db, 'g1', { instructions: 'x', instructions_edits: [{ old: 'Find', new: 'x' }] })).toThrow(/not both/)
    expect(getPlan(db, 'g1')!.name).toBe('Inbox')
    expect(getGoal(db, 'g1')!.instructions).toBe('Find stale senders. Propose one item per sender. Never send mail.')
    expect(applyInstructionEdits('a b a', [{ old: 'a b', new: 'c' }])).toBe('c a')
  })
})

describe('goal model', () => {
  it("is null (the session's) by default; set, it goes with each claimed run and into the overview", () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Feeds' }, { objective: 'Feeds' })
    expect(getGoal(db, 'g2')!.model).toBeNull()
    expect(claimRun(db, 'g2', { holder: 'A' })!.model).toBeNull()
    expect(applyGoalChanges(db, 'g1', { model: 'Haiku' })).toEqual(['runs use haiku'])
    expect(getGoal(db, 'g1')!.model).toBe('haiku')
    expect(buildOverview(db).goals.find((g) => g.id === 'g1')).toMatchObject({ model: 'haiku' })
    const q = queueRun(db, 'g1')
    expect(claimRun(db, 'g1', { holder: 'A', queuedRunId: q.id })!.model).toBe('haiku')
  })

  it("changes to a full id, back to the session's with null, and says nothing when unchanged", () => {
    expect(applyGoalChanges(db, 'g1', { model: 'claude-opus-5-5' })).toEqual(['runs use claude-opus-5-5'])
    expect(applyGoalChanges(db, 'g1', { model: 'claude-opus-5-5' })).toEqual([])
    expect(applyGoalChanges(db, 'g1', { model: null })).toEqual(["runs use the session's model"])
    expect(getGoal(db, 'g1')!.model).toBeNull()
  })

  it("refuses a name that can't be a model, changing nothing", () => {
    expect(() => applyGoalChanges(db, 'g1', { model: 'rm -rf /', name: 'Other' })).toThrow(/isn't a model/)
    expect(getPlan(db, 'g1')!.name).toBe('Inbox')
    expect(normalizeModel('inherit')).toBeNull()
    expect(normalizeModel(' OPUS ')).toBe('opus')
  })

  it('can be given when the goal is made', () => {
    createGoal(db, { ...plan, id: 'g2' }, { objective: 'Feeds', model: 'sonnet' })
    expect(getGoal(db, 'g2')!.model).toBe('sonnet')
  })
})

describe('applyGoalChanges', () => {
  it('changes the name, objective, instructions, autonomy, tool rules, memory and status, saying what changed', () => {
    const m = insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Gmail is not connected', source: 'agent' })
    const done = applyGoalChanges(db, 'g1', {
      name: 'Inbox under 20',
      objective: 'Keep the inbox under 20 unread',
      instructions: 'Never touch mail from the bank.',
      autonomy: { 'email.send': 'propose', 'email.archive': null, 'email.delete': 'off' },
      tool_map: { 'mcp__gmail__send*': 'email.send' },
      add_memory: [{ kind: 'rule', text: 'Archive newsletters after a week', pinned: true }],
      forget_memory: [m.id],
      status: 'paused',
    })
    expect(done).toEqual([
      'renamed to "Inbox under 20"', 'objective changed', 'instructions changed',
      'email.send: propose', 'email.archive: back to propose', 'email.delete: off',
      'tool rule mcp__gmail__send* → email.send', 'remembered (rule): Archive newsletters after a week', `forgot memory ${m.id}`, 'paused',
    ])
    expect(getPlan(db, 'g1')!.name).toBe('Inbox under 20')
    expect(getGoal(db, 'g1')).toMatchObject({
      objective: 'Keep the inbox under 20 unread', status: 'paused',
      autonomy: { 'email.send': 'propose', 'email.delete': 'off' }, tool_map: { 'mcp__gmail__send*': 'email.send' },
    })
    expect(listMemory(db, 'g1', { activeOnly: true }).map((x) => [x.text, x.source, x.pinned])).toEqual([['Archive newsletters after a week', 'human', true]])
  })

  it('refuses a bad mode or another goal\'s memory, changing nothing', () => {
    createGoal(db, { ...plan, id: 'g2' }, { objective: 'x' })
    const other = insertMemory(db, { plan_id: 'g2', kind: 'fact', text: 'x', source: 'human' })
    expect(() => applyGoalChanges(db, 'g1', { autonomy: { 'email.send': 'yes' as never } })).toThrow(/isn't a mode/)
    expect(() => applyGoalChanges(db, 'g1', { objective: 'changed', forget_memory: [other.id] })).toThrow(/isn't this goal's/)
    expect(getGoal(db, 'g1')!.objective).toBe('Inbox zero')
  })
})

describe('the usage limit', () => {
  it('reads the reset time, local, the next time it comes round', () => {
    const at = new Date(2026, 10, 8, 19, 30)
    const reset = parseLimitReset("You've hit your 5-hour limit · resets 8:10pm (Pacific/Auckland)", at)!
    expect([reset.getDate(), reset.getHours(), reset.getMinutes()]).toEqual([8, 20, 10])
    const tomorrow = parseLimitReset('resets 7am', at)!
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([9, 7])
    expect(parseLimitReset('try again later', at)).toBeNull()
    expect(isUsageLimit("You've hit your 5-hour limit · resets 8:10pm")).toBe(true)
    expect(isUsageLimit('All done: archived 4 newsletters.')).toBe(false)
  })

  it('a run that hits it is skipped, not failed, and no run starts until the reset', async () => {
    const t = new Date(2099, 0, 5, 19, 30)
    const run = claimRun(db, 'g1', { holder: 'A', now: t })!
    const r = reportRunEnd(db, run.run_id, { answer: "You've hit your 5-hour limit · resets 8:10pm (Pacific/Auckland)" }, t)
    expect(r.outcome).toBe('held')
    expect(getRun(db, run.run_id)).toMatchObject({ status: 'skipped', skip_reason: expect.stringContaining('usage limit reached') })
    expect(getRunHold(db, t)).toMatchObject({ until: new Date(2099, 0, 5, 20, 10).toISOString() })
    expect(buildOverview(db).hold).not.toBeNull()

    queueRun(db, 'g1')
    const held = await schedulerPass(db, { holder: 'A', now: new Date(2099, 0, 5, 20, 0) })
    expect(held).toMatchObject({ claimed: [], hold: expect.objectContaining({ reason: expect.stringContaining('5-hour limit') }) })
    const after = await schedulerPass(db, { holder: 'A', now: new Date(2099, 0, 5, 20, 11) })
    expect(after.claimed).toHaveLength(1)
    expect(getRunHold(db, new Date(2099, 0, 5, 20, 11))).toBeNull()
  })

  it('records the goal whose run set it; clearing returns the hold, and with none changes nothing', () => {
    const t = new Date(2099, 0, 5, 19, 30)
    const run = claimRun(db, 'g1', { holder: 'A', now: t })!
    reportRunEnd(db, run.run_id, { answer: "You've hit your 5-hour limit · resets 8:10pm" }, t)
    expect(getRunHold(db, t)).toMatchObject({ plan_id: 'g1' })
    expect(clearRunHold(db)).toMatchObject({ plan_id: 'g1' })
    expect(getRunHold(db, t)).toBeNull()
    expect(clearRunHold(db)).toBeNull()
  })

  it("a pass lifts it when the session's usage windows are all below 100%, and claims due runs in that pass", async () => {
    const t = new Date(2099, 0, 5, 19, 30)
    setRunHold(db, { until: new Date(2099, 0, 5, 20, 10).toISOString(), reason: 'limit', plan_id: 'g1' })
    queueRun(db, 'g1')
    const pass = await schedulerPass(db, { holder: 'A', now: t, rateLimits: [{ percent_used: 12 }, { percent_used: 99.5 }] })
    expect(pass.hold).toBeUndefined()
    expect(pass.hold_cleared).toMatchObject({ plan_id: 'g1' })
    expect(pass.claimed).toHaveLength(1)
    expect(getRunHold(db, t)).toBeNull()
  })

  it('a pass keeps it with a window at 100%, or with no windows given or an empty list', async () => {
    const t = new Date(2099, 0, 5, 19, 30)
    setRunHold(db, { until: new Date(2099, 0, 5, 20, 10).toISOString(), reason: 'limit', plan_id: 'g1' })
    queueRun(db, 'g1')
    for (const rateLimits of [[{ percent_used: 10 }, { percent_used: 100 }], undefined, []]) {
      const pass = await schedulerPass(db, { holder: 'A', now: t, rateLimits })
      expect(pass).toMatchObject({ claimed: [], hold: expect.objectContaining({ reason: 'limit' }) })
      expect(pass.hold_cleared).toBeUndefined()
    }
  })

  it('another error fails the run with its message; an ordinary turn changes nothing', () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    expect(reportRunEnd(db, run.run_id, { answer: 'Still waiting on the export.' })).toEqual({ outcome: 'unchanged' })
    expect(reportRunEnd(db, run.run_id, { answer: 'API Error: 529 overloaded', reason: 'error' })).toEqual({ outcome: 'failed' })
    expect(getRun(db, run.run_id)).toMatchObject({ status: 'failed', summary: 'The agent stopped on an error: API Error: 529 overloaded' })
    setRunHold(db, { until: new Date(Date.now() + 60_000).toISOString(), reason: 'x' })
    expect(getRunHold(db)).not.toBeNull()
  })
})

describe('run usage', () => {
  it('adds each turn\'s tokens to the run, after end_run too, and the overview shows the new ones (no cache reads)', () => {
    const run = claimRun(db, 'g1', { holder: 'session-A' })!
    reportRunEnd(db, run.run_id, { answer: 'working', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-sonnet-5-5' } })
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.run_id)
    reportRunEnd(db, run.run_id, { answer: 'Done.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(getRun(db, run.run_id)).toMatchObject({ input_tokens: 110, output_tokens: 55, cache_read_tokens: 1000, cache_write_tokens: 200, model: 'claude-sonnet-5-5' })
    expect(buildOverview(db).goals[0]!.runs[0]).toMatchObject({ tokens: 365,model: 'claude-sonnet-5-5' })
  })
})

describe("a run's progress", () => {
  it('shows its latest tool call, and a call waiting for permission until it settles', () => {
    const t0 = new Date(2099, 0, 5, 9, 0)
    const at = (min: number) => new Date(t0.getTime() + min * 60_000)
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    const activity = () => buildOverview(db).goals[0]!.activity
    expect(activity().text).toBe('Starting: reading the brief')

    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Gmail search_threads' }, at(1))
    expect(activity()).toMatchObject({ state: 'running', text: 'Using Gmail search_threads', at: at(1).toISOString() })

    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Bash: rm old.zip' }, at(2))
    reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'Bash: rm old.zip' }, at(2))
    expect(activity()).toMatchObject({
      text: 'Waiting for your permission: Bash: rm old.zip', waiting: { tool: 'Bash: rm old.zip', since: at(2).toISOString() },
    })
    // Another call settling doesn't end this wait
    reportRunProgress(db, run.run_id, { event: 'settled', tool: 'Gmail search_threads' }, at(3))
    expect(activity().waiting).toBeDefined()
    reportRunProgress(db, run.run_id, { event: 'settled', tool: 'Bash: rm old.zip' }, at(4))
    expect(activity()).toMatchObject({ text: 'Using Bash: rm old.zip' })
    expect(activity().waiting).toBeUndefined()

    // A newer Quarterdeck event says more than the last tool call
    insertEvent(db, { id: 'e1', plan_id: 'g1', task_id: 'g1', event_type: 'memory_added', actor: 'agent', payload: { text: 'Bank mail stays' }, created_at: at(5).toISOString() })
    expect(activity().text).toBe('Noted: Bank mail stays')
    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Gmail label_thread' }, at(6))
    expect(activity().text).toBe('Using Gmail label_thread')
  })

  it("says a wait on Quarterdeck's own tool may have no prompt showing", () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'quarterdeck get_goal_brief' })
    const activity = buildOverview(db).goals[0]!.activity
    expect(activity.text).toMatch(/^Waiting for a permission prompt that may not be showing: quarterdeck get_goal_brief/)
    expect(activity.waiting?.tool).toBe('quarterdeck get_goal_brief')
  })

  it('changes nothing once the run has ended', () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    reportRunEnd(db, run.run_id, { answer: 'x', reason: 'error' })
    expect(reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'Bash: ls' })).toEqual({ updated: false })
    expect(getRun(db, run.run_id)!.waiting_tool).toBeNull()
  })
})

describe('merge_categories', () => {
  it('renames past items, autonomy and tool rules to the merged category', () => {
    const now = new Date().toISOString()
    createGoal(db, { id: 'm1', name: 'M', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now }, {
      objective: 'x', autonomy: { 'git.push': 'auto' },
    })
    applyGoalChanges(db, 'm1', { tool_map: { 'mcp__x__push': 'git.push' } })
    addItem(db, 'm1', null, { goal: 'a', action: { category: 'git.push', summary: 'push' } })
    addItem(db, 'm1', null, { goal: 'b', action: { category: 'github.pr', summary: 'pr' } })
    expect(applyGoalChanges(db, 'm1', { merge_categories: { 'git.push': 'github.pr' } })).toEqual(['merged git.push into github.pr (1 item)'])
    expect((getTask(db, 'm1', '1')!.state.action as { category: string }).category).toBe('github.pr')
    expect(getGoal(db, 'm1')!.autonomy).toEqual({ 'github.pr': 'auto' })
    expect(getGoal(db, 'm1')!.tool_map).toEqual({ 'mcp__x__push': 'github.pr' })
    expect(() => applyGoalChanges(db, 'm1', { merge_categories: { a: 'a' } })).toThrow(/two different/)
  })
})

describe("a run's step (#146)", () => {
  const t0 = new Date(2099, 0, 5, 9, 0)
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)
  const activity = () => buildOverview(db).goals[0]!.activity

  it('leads with the step, the latest call as detail; a wait for permission still wins', () => {
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    expect(setRunStep(db, run.run_id, '  Reviewing PR #139 ', at(1))).toEqual({ changed: true, step: 'Reviewing PR #139', untrusted: null })
    expect(activity()).toMatchObject({ state: 'running', text: 'Reviewing PR #139', at: at(1).toISOString() })
    expect(activity().detail).toBeUndefined()
    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Bash: npm test' }, at(2))
    expect(activity()).toMatchObject({ text: 'Reviewing PR #139', detail: 'Using Bash: npm test', at: at(2).toISOString() })
    reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'Bash: rm x' }, at(3))
    expect(activity().text).toBe('Waiting for your permission: Bash: rm x')
  })

  it('changes nothing for the same text, once for a new one', () => {
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    setRunStep(db, run.run_id, 'Issue #12', at(1))
    const rev = getPlan(db, 'g1')!.revision
    expect(setRunStep(db, run.run_id, 'Issue #12', at(2)).changed).toBe(false)
    expect(getPlan(db, 'g1')!.revision).toBe(rev)
    expect(getRun(db, run.run_id)!.step_at).toBe(at(1).toISOString())
    expect(setRunStep(db, run.run_id, 'Issue #13', at(3)).changed).toBe(true)
    expect(getPlan(db, 'g1')!.revision).toBe(rev + 1)
  })

  it('refuses a long, multi-line or empty step, and a run that is not running', () => {
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    expect(() => setRunStep(db, run.run_id, 'x'.repeat(STEP_MAX + 1))).toThrow(/at most 60 characters/)
    expect(setRunStep(db, run.run_id, 'x'.repeat(STEP_MAX)).changed).toBe(true)
    expect(() => setRunStep(db, run.run_id, 'one\ntwo')).toThrow(/one line/)
    expect(() => setRunStep(db, run.run_id, '   ')).toThrow(/few words/)
    endRun(db, run.run_id, 'done')
    expect(() => setRunStep(db, run.run_id, 'later')).toThrow(/not running/)
  })

  it('carries the untrusted source it was set after', () => {
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    markRunUntrusted(db, run.run_id, 'Bash: gh issue view')
    expect(setRunStep(db, run.run_id, 'Issue #12', at(1)).untrusted).toBe('Bash: gh issue view')
    expect(activity()).toMatchObject({ text: 'Issue #12', untrusted: 'Bash: gh issue view' })
  })

  it('is cleared however the run ends', () => {
    for (const end of [
      (id: string) => endRun(db, id, 'done'),
      (id: string) => failRun(db, id, 'failed', 'crashed'),
      (id: string) => failRun(db, id, 'timed_out', 'too long'),
      (id: string) => updateRun(db, id, { status: 'skipped', skip_reason: 'usage limit reached', ended_at: new Date().toISOString() }),
    ]) {
      const run = claimRun(db, 'g1', { holder: 'A' })!
      setRunStep(db, run.run_id, 'Working')
      end(run.run_id)
      expect(getRun(db, run.run_id)).toMatchObject({ step: null, step_at: null, step_untrusted: null })
    }
  })
})

describe('auto after outside content', () => {
  it('starts empty, and the person can add and remove categories', () => {
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual([])
    expect(applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': true } })).toEqual(['email.archive: auto, even after reading outside text'])
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual(['email.archive'])
    expect(applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': true } })).toEqual([])
    expect(applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': false } })).toEqual(['email.archive: back to propose after reading outside text'])
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual([])
  })

  it('says it counts only while the category is auto', () => {
    const [line] = applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.send': true } })
    expect(line).toContain('counts only while it is auto; it is propose')
  })

  it('warns, naming the rule, when the category pushes code, opens or merges PRs or is broad, and still saves', () => {
    updateGoal(db, 'g1', { autonomy: { 'github.write': 'auto', 'github.read': 'auto' }, tool_map: { 'Bash(git -C * push*)': 'github.write', 'Bash(gh pr create*)': 'github.write', 'Bash(gh issue view*)': 'github.read' } })
    const [line] = applyGoalChanges(db, 'g1', { auto_after_outside: { 'github.write': true } })
    expect(line).toContain('Warning:')
    expect(line).toContain('Bash(git -C * push*), Bash(gh pr create*)')
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual(['github.write'])
    expect(applyGoalChanges(db, 'g1', { auto_after_outside: { 'github.read': true } })[0]).not.toContain('Warning')
  })

  it('treats whole tools and whole MCP servers as broad', () => {
    for (const p of ['Bash', 'Edit', 'Write', 'mcp__gmail__*', 'mcp__claude_ai_Gmail__*', 'Bash(gh pr merge*)']) expect(isRiskyToolRule(p)).toBe(true)
    for (const p of ['Bash(gh issue view*)', 'mcp__gmail__send_message', 'Read']) expect(isRiskyToolRule(p)).toBe(false)
    expect(autoAfterOutsideWarning({ Bash: 'x' }, 'y')).toBeNull()
  })

  it('follows a merged category', () => {
    applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': true } })
    applyGoalChanges(db, 'g1', { merge_categories: { 'email.archive': 'email.tidy' } })
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual(['email.tidy'])
  })

  it('refuses a non-boolean or empty category, changing nothing', () => {
    expect(() => applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': 'yes' as unknown as boolean } })).toThrow(/true or false/)
    expect(() => applyGoalChanges(db, 'g1', { auto_after_outside: { ' ': true } })).toThrow(/category name/)
    expect(getGoal(db, 'g1')!.auto_after_outside).toEqual([])
  })
})

describe('autonomy suggestions (#189)', () => {
  const at = (category: string, mode: 'off' | 'propose' | 'auto') => updateGoal(db, 'g1', { autonomy: { ...getGoal(db, 'g1')!.autonomy, [category]: mode } })
  // Each proposal from a run of its own: marked (it read outside text) or not, in the category's current mode
  let n = 0
  const propose = (category: string, marked: boolean) => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    if (marked) markRunUntrusted(db, run.run_id, 'Bash: gh issue view')
    const r = addItem(db, 'g1', run.run_id, { goal: `${category} ${n++}`, action: { category, summary: 's' } })
    endRun(db, run.run_id, 'done')
    return r
  }
  const approve = (category: string, times: number, marked: boolean) => {
    for (let i = 0; i < times; i++) approveTask(db, 'g1', propose(category, marked).task.id)
  }

  it('marks a proposal a marked run made of an auto action, and no other', () => {
    expect(propose('email.archive', true).task.state.outside_text).toBe('Bash: gh issue view')
    expect(propose('email.archive', false).task.state.outside_text).toBeUndefined() // auto, done at once
    expect(propose('email.reply', true).task.state.outside_text).toBeUndefined() // propose anyway
  })

  it('suggests auto for a propose category, counting every approval', () => {
    approve('email.reply', PROMOTE_AFTER, false)
    expect(getAutonomySuggestions(db, 'g1')).toEqual([{ category: 'email.reply', approved_in_a_row: 10, kind: 'auto' }])
  })

  it('suggests keeping an auto category auto after outside text only for its marked proposals', () => {
    at('email.archive', 'propose')
    approve('email.archive', PROMOTE_AFTER, false) // approved while it was propose
    at('email.archive', 'auto')
    expect(getAutonomySuggestions(db, 'g1')).toEqual([]) // switching to auto doesn't bring up the next hint
    approve('email.archive', PROMOTE_AFTER - 1, true)
    expect(getAutonomySuggestions(db, 'g1')).toEqual([])
    approve('email.archive', 1, true)
    expect(getAutonomySuggestions(db, 'g1')).toEqual([{ category: 'email.archive', approved_in_a_row: 10, kind: 'after_outside' }])
  })

  it('carries the risky-rule warning', () => {
    at('github.write', 'auto')
    updateGoal(db, 'g1', { tool_map: { 'Bash(gh pr create*)': 'github.write' } })
    approve('github.write', PROMOTE_AFTER, true)
    expect(getAutonomySuggestions(db, 'g1')).toEqual([{ category: 'github.write', approved_in_a_row: 10, kind: 'after_outside', warning: expect.stringContaining('Bash(gh pr create*)') }])
  })

  it('suggests nothing after a recent rejection, once listed, or at off', () => {
    rejectTask(db, 'g1', propose('email.archive', true).task.id, 'no')
    approve('email.archive', PROMOTE_AFTER - 1, true)
    expect(getAutonomySuggestions(db, 'g1')).toEqual([])
    approve('email.archive', 1, true)
    expect(getAutonomySuggestions(db, 'g1')).toHaveLength(1)
    applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': true } })
    expect(getAutonomySuggestions(db, 'g1')).toEqual([])
    applyGoalChanges(db, 'g1', { auto_after_outside: { 'email.archive': false } })
    at('email.archive', 'off')
    expect(getAutonomySuggestions(db, 'g1')).toEqual([])
  })
})
