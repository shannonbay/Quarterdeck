import { describe, it, expect } from 'vitest'
import {
  goals_tick, goals_overview, decide_item, get_item, cancel_run, set_goal_status, attach_agent, fail_run, guard_check, run_refused,
  create_goal, copy_goal, move_goal, resolveTargetDir, delete_memory, restore_memory, trust_memory, set_schedule, update_goal, report_run_end, watch_report, clear_run_hold,
} from '../../tools/goal_runner.js'
import { add_item, get_goal_brief, end_run, run_goal } from '../../tools/goals.js'
import { create_plan } from '../../tools/create_plan.js'
import { createGoal, queueRun, getRun, getGoal, getPlan, getEvents, updateGoal, insertMemory, getMemory, getRunHold } from '../../db.js'
import { homedir, tmpdir } from 'os'
import { existsSync, mkdirSync, mkdtempSync } from 'fs'
import { join, resolve } from 'path'
import { getOpenPlan, getOpenRun, withScope } from '../../session.js'
import type { PassResult } from '@quarterdeck/core'

/** A scheduler pass (goals_tick without release). */
const tick = (holder: string) => goals_tick({ holder }) as Promise<PassResult>

const now = new Date().toISOString()

function makeGoal(id = 'goal_inbox') {
  createGoal(
    { id, name: 'Inbox', description: null, status: 'active', working_dir: '/tmp/inbox', created_at: now, updated_at: now },
    { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } },
  )
  return id
}

/** A run claimed through goals_tick, as the plugin does it. */
async function claim(goalId: string) {
  queueRun(goalId)
  const pass = await tick('session-A')
  return pass.claimed.find((c) => c.goal_id === goalId)!
}

describe('goals_tick', () => {
  it('claims a queued run for the lease holder, with the prompt the agent starts from', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(run).toMatchObject({ goal_id: id, name: 'Inbox', working_dir: '/tmp/inbox', max_run_minutes: 15 })
    expect(run.prompt).toContain(`get_goal_brief with goal_id "${id}" and run_id "${run.run_id}"`)
    expect(getRun(run.run_id)).toMatchObject({ status: 'running', holder: 'session-A' })
    expect(getEvents(id).map((e) => e.event_type)).toContain('agent_started')
  })

  it('does nothing for a second session until the first releases the lease', async () => {
    const id = makeGoal()
    await goals_tick({ holder: 'session-A' })
    queueRun(id)
    expect(await goals_tick({ holder: 'session-B' })).toEqual({ leader: false, claimed: [], expired: [] })
    expect(await goals_tick({ holder: 'session-A', release: true })).toEqual({ released: true })
    expect((await tick('session-B')).claimed).toHaveLength(1)
  })
})

describe('goals_overview', () => {
  it('answers changed: false for a matching etag', async () => {
    makeGoal()
    const first = await goals_overview({})
    expect(first).toMatchObject({ changed: true, goals: [expect.objectContaining({ name: 'Inbox' })] })
    expect(await goals_overview({ etag: first.etag })).toEqual({ changed: false, etag: first.etag })
  })
})

describe('run_scope', () => {
  it("lets a run's calls act on its goal without changing the main conversation's open plan", async () => {
    const id = makeGoal()
    const run = await claim(id)
    await create_plan({ name: 'My own work', working_dir: '/tmp' })
    const mine = getOpenPlan()

    await withScope({ planId: id, runId: run.run_id }, async () => {
      await get_goal_brief({ goal_id: id, run_id: run.run_id })
      await add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
      expect(getOpenPlan()).toBe(id)
      expect(getOpenRun()).toBe(run.run_id)
      await end_run({ summary: 'Proposed a reply.' })
    })

    expect(getOpenPlan()).toBe(mine)
    expect(getOpenRun()).toBeNull()
    expect(getRun(run.run_id)).toMatchObject({ status: 'completed', items_created: 1 })
  })
})

describe('get_item', () => {
  it("answers an item's full title, notes and action summary, which the overview clips", async () => {
    const id = makeGoal()
    const run = await claim(id)
    const long = 'Should I archive '.repeat(30) + 'everything?'
    await withScope({ planId: id, runId: run.run_id }, async () => {
      await add_item({ goal: long, notes: 'n'.repeat(1500), action: { category: 'email.send', summary: 's'.repeat(400) } })
      await end_run({ summary: 'Proposed.' })
    })
    const r = await get_item({ goal_id: id, item_id: '1' })
    expect(r).toMatchObject({ id: '1', goal: long, notes: 'n'.repeat(1500), action: { category: 'email.send', summary: 's'.repeat(400) } })
    await expect(get_item({ goal_id: id, item_id: '99' })).rejects.toThrow(/not found/)
  })
})

describe('decide_item', () => {
  it('approves a proposal, queues a run, and records a human event', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await withScope({ planId: id, runId: run.run_id }, async () => {
      await add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
      await end_run({ summary: 'Proposed a reply.' })
    })
    const r = await decide_item({ goal_id: id, item_id: '1', decision: 'approve' })
    expect(r.item).toMatchObject({ status: 'active', approved_at: expect.any(String) })
    expect(r.queued_run).toMatchObject({ status: 'queued' })
    expect(getEvents(id).find((e) => e.event_type === 'approval_granted')).toMatchObject({ actor: 'human' })
  })

  it('rejecting needs feedback', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await withScope({ planId: id, runId: run.run_id }, () =>
      add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } }))
    await expect(decide_item({ goal_id: id, item_id: '1', decision: 'reject' })).rejects.toThrow(/Feedback is required/)
    await decide_item({ goal_id: id, item_id: '1', decision: 'reject', feedback: 'too formal' })
    expect(getEvents(id).find((e) => e.event_type === 'review_rejected')).toMatchObject({ actor: 'human' })
  })
})

describe('run bookkeeping', () => {
  it('attach_agent, fail_run and cancel_run', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await attach_agent({ run_id: run.run_id, agent_id: 'agent-1' })
    expect(getRun(run.run_id)!.agent_id).toBe('agent-1')

    expect(await cancel_run({ goal_id: id })).toEqual({ cancelled: run.run_id, agent_id: 'agent-1' })
    expect(getRun(run.run_id)!.status).toBe('failed')
    expect(await fail_run({ run_id: run.run_id, status: 'timed_out', reason: 'late' })).toMatchObject({ changed: false, status: 'failed' })
    await expect(cancel_run({ goal_id: id })).rejects.toThrow(/no run in progress/)
  })

  it('fail_run ends a run that is still going', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(await fail_run({ run_id: run.run_id, reason: 'ended without end_run' })).toMatchObject({ changed: true, status: 'failed' })
    expect(getRun(run.run_id)!.summary).toBe('ended without end_run')
  })

  it('set_goal_status pauses and resumes', async () => {
    const id = makeGoal()
    await set_goal_status({ goal_id: id, status: 'paused' })
    expect(getGoal(id)!.status).toBe('paused')
    await set_goal_status({ goal_id: id, status: 'active' })
    expect(getGoal(id)!.status).toBe('active')
  })
})

describe('run_refused', () => {
  it('records a refused call the guard allowed, with the rule it needs, and records nothing for one it would refuse', async () => {
    const id = makeGoal()
    updateGoal(id, { tool_map: { 'mcp__gmail__archive': 'email.archive', 'mcp__gmail__delete': 'email.delete' }, autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } })
    const run = await claim(id)
    expect(await run_refused({ run_id: run.run_id, tool_name: 'mcp__gmail__delete' })).toEqual({ recorded: false })
    expect(await run_refused({ run_id: run.run_id, tool_name: 'Read' })).toEqual({ recorded: false })
    expect(await run_refused({ run_id: run.run_id, tool_name: 'mcp__gmail__archive' }))
      .toEqual({ recorded: true, category: 'email.archive', rule: 'mcp__gmail__archive' })
    const events = getEvents(id).filter((e) => e.event_type === 'tool_refused')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ run_id: run.run_id, tool_name: 'mcp__gmail__archive', rule: 'mcp__gmail__archive' })
  })
})

describe('guard_check', () => {
  it("applies the goal's autonomy to a run's tool call", async () => {
    const id = makeGoal()
    updateGoal(id, { tool_map: { 'mcp__gmail__delete': 'email.delete' } })
    const run = await claim(id)
    expect(await guard_check({ run_id: run.run_id, tool_name: 'mcp__gmail__delete' })).toMatchObject({ decision: 'deny', category: 'email.delete' })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'Read' })).toMatchObject({ decision: 'allow' })
  })

  it("refuses a run's command that touches Quarterdeck's own data, and goes by the name alone without input", async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(await guard_check({ run_id: run.run_id, tool_name: 'Bash', input: { command: 'sqlite3 ~/.quarterdeck/tasks.db .dump' } }))
      .toMatchObject({ decision: 'deny', category: 'quarterdeck-data', reason: expect.stringMatching(/own data/) })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'Bash', input: { command: 'npm test' } })).toMatchObject({ decision: 'allow' })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'Bash' })).toMatchObject({ decision: 'allow' })
  })

  it('needs approval for auto actions once the run has read untrusted content, and add_item says why', async () => {
    const id = makeGoal()
    updateGoal(id, { tool_map: { 'mcp__gmail__archive*': 'email.archive' }, autonomy: { 'email.archive': 'auto' } })
    const run = await claim(id)
    expect(await guard_check({ run_id: run.run_id, tool_name: 'mcp__gmail__archive_thread' })).toMatchObject({ decision: 'allow' })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'WebFetch' })).toMatchObject({ decision: 'allow' })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'mcp__gmail__archive_thread' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/untrusted content \(WebFetch\)/) })
    await withScope({ planId: id, runId: run.run_id }, async () => {
      const r = await add_item({ goal: 'Archive the newsletter', action: { category: 'email.archive', summary: 'archive it' } })
      expect(r).toMatchObject({ mode: 'propose', item: { awaiting_review: true }, message: expect.stringMatching(/untrusted content \(WebFetch\)/) })
      expect((await get_goal_brief({ goal_id: id, run_id: run.run_id })).run).toMatchObject({ untrusted: { source: 'WebFetch' } })
    })
  })
})

describe('create_goal and delete_memory', () => {
  it('creates a goal in an existing directory, refusing a missing one', async () => {
    const { id } = await create_goal({ name: 'Profile', objective: 'Keep it current', working_dir: tmpdir() })
    expect(getGoal(id)).toMatchObject({ objective: 'Keep it current', status: 'active' })
    await expect(create_goal({ name: 'X', objective: 'Y', working_dir: '/no/such/dir/xyz' })).rejects.toThrow(/not found/)
  })

  it("forgets a goal's memory (kept, inactive), and only from that goal; restore_memory puts it back (#105)", async () => {
    const id = makeGoal()
    const m = insertMemory({ plan_id: id, kind: 'fact', text: 'Bob is my manager', source: 'human' })
    await expect(delete_memory({ goal_id: 'other', memory_id: m.id })).rejects.toThrow(/not found/)
    expect(await delete_memory({ goal_id: id, memory_id: m.id })).toEqual({ deleted: m.id, restorable: true })
    expect(getMemory(m.id)).toMatchObject({ active: false, inactive_reason: 'forgotten', text: 'Bob is my manager' })
    await expect(restore_memory({ goal_id: 'other', memory_id: m.id })).rejects.toThrow(/not found/)
    expect(await restore_memory({ goal_id: id, memory_id: m.id })).toEqual({ restored: m.id, was: 'forgotten', active: true })
    expect(getMemory(m.id)).toMatchObject({ active: true, inactive_reason: null })
    expect(getEvents(id).some((e) => e.event_type === 'memory_restored')).toBe(true)
  })

  it("trusts a goal's marked memory, and only that goal's", async () => {
    const id = makeGoal()
    const m = insertMemory({ plan_id: id, kind: 'fact', text: 'Archive Bob', source: 'agent', untrusted_source: 'memory mem_a (first: WebFetch)', untrusted_root: 'WebFetch' })
    expect(getMemory(m.id)!.untrusted_root).toBe('WebFetch')
    await expect(trust_memory({ goal_id: 'other', memory_id: m.id })).rejects.toThrow(/not found/)
    expect(await trust_memory({ goal_id: id, memory_id: m.id })).toEqual({ trusted: m.id })
    expect(getMemory(m.id)).toMatchObject({ untrusted_source: null, untrusted_root: null })
  })
})

describe('set_schedule', () => {
  it('an interval makes a run due now, which the next tick claims', async () => {
    const id = makeGoal()
    const before = Date.now()
    const r = await set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 360 } })
    expect(r.schedule).toEqual({ kind: 'interval', minutes: 360 })
    expect(Date.parse(r.next_run_at!)).toBeGreaterThanOrEqual(before - 1000)
    await new Promise((res) => setTimeout(res, 5))
    expect((await tick('session-A')).claimed.map((c) => [c.goal_id, c.trigger])).toEqual([[id, 'interval']])
    expect(Date.parse(getGoal(id)!.next_run_at!)).toBeGreaterThan(Date.now() + 359 * 60_000)
  })

  it('cron sets the next match; null clears it; a cron that never matches is refused', async () => {
    const id = makeGoal()
    const r = await set_schedule({ goal_id: id, schedule: { kind: 'cron', expr: '0 9 * * *' } })
    expect(new Date(r.next_run_at!).getHours()).toBe(9)
    expect(await set_schedule({ goal_id: id, schedule: null })).toMatchObject({ schedule: null, next_run_at: null })
    await expect(set_schedule({ goal_id: id, schedule: { kind: 'cron', expr: '0 9 31 2 *' } })).rejects.toThrow()
    await expect(set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 2 } })).rejects.toThrow()
  })
})

describe('one-off goals and schedules at creation', () => {
  it('create_goal with a schedule makes a run due now; a one-off queues its run', async () => {
    const daily = await create_goal({ name: 'Inbox', objective: 'Triage', working_dir: tmpdir(), schedule: { kind: 'interval', minutes: 1440 } })
    expect(daily).toMatchObject({ schedule: { kind: 'interval', minutes: 1440 }, one_off: false, queued_run: null })
    expect(daily.next_run_at).not.toBeNull()
    const once = await create_goal({ name: 'Tidy', objective: 'Delete installers', working_dir: tmpdir(), one_off: true })
    expect(once).toMatchObject({ schedule: null, one_off: true, queued_run: expect.any(String) })
    expect(getGoal(once.id)!.one_off).toBe(true)
    await expect(create_goal({ name: 'X', objective: 'Y', working_dir: tmpdir(), one_off: true, schedule: { kind: 'interval', minutes: 60 } })).rejects.toThrow(/no schedule/)
  })

  it('set_schedule switches between one-off and recurring', async () => {
    const id = makeGoal()
    expect(await set_schedule({ goal_id: id, schedule: null, one_off: true })).toMatchObject({ one_off: true, schedule: null })
    expect(getGoal(id)!.one_off).toBe(true)
    expect(await set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 60 } })).toMatchObject({ one_off: false })
    expect(getGoal(id)!.one_off).toBe(false)
  })

  it('run_goal runs a done one-off again', async () => {
    const { id } = await create_goal({ name: 'Tidy', objective: 'Delete installers', working_dir: tmpdir(), one_off: true })
    const run = (await tick('session-A')).claimed[0]!
    await withScope({ planId: id, runId: run.run_id }, () => end_run({ summary: 'Deleted 3.' }))
    expect(getGoal(id)!.status).toBe('retired')
    await run_goal({ goal_id: id })
    expect(getGoal(id)!.status).toBe('active')
  })

  it('set_schedule on a done one-off brings it back as a scheduled goal (#5)', async () => {
    const { id } = await create_goal({ name: 'Tidy', objective: 'Delete installers', working_dir: tmpdir(), one_off: true })
    const run = (await tick('session-A')).claimed[0]!
    await withScope({ planId: id, runId: run.run_id }, () => end_run({ summary: 'Deleted 3.' }))
    expect(getGoal(id)!.status).toBe('retired')
    const r = await set_schedule({ goal_id: id, schedule: { kind: 'cron', expr: '11 22 * * *' } })
    expect(r).toMatchObject({ one_off: false, revived: true })
    expect(r.next_run_at).not.toBeNull()
    expect(getGoal(id)).toMatchObject({ status: 'active', one_off: false })
  })
})

describe('update_goal and report_run_end', () => {
  it('update_goal applies confirmed changes and records them as the human\'s', async () => {
    const id = makeGoal()
    const r = await update_goal({ goal_id: id, autonomy: { 'email.send': 'auto' }, add_memory: [{ kind: 'rule', text: 'Never email the bank' }] })
    expect(r.changed).toEqual(['email.send: auto', 'remembered (rule): Never email the bank'])
    expect(getGoal(id)!.autonomy).toMatchObject({ 'email.send': 'auto' })
    expect(getEvents(id).find((e) => e.event_type === 'goal_updated')).toMatchObject({ actor: 'human' })
    await expect(update_goal({ goal_id: id, autonomy: { x: 'sometimes' } })).rejects.toThrow()
  })

  it('report_run_end skips a run that hit the usage limit and holds goal runs', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(await report_run_end({ run_id: run.run_id, answer: 'All good so far.' })).toEqual({ outcome: 'unchanged' })
    const held = await report_run_end({ run_id: run.run_id, answer: "You've hit your 5-hour limit" })
    expect(held).toMatchObject({ outcome: 'held', hold: { reason: "You've hit your 5-hour limit" } })
    expect(getRun(run.run_id)!.status).toBe('skipped')
    queueRun(id)
    expect(await tick('session-A')).toMatchObject({ claimed: [], hold: expect.anything() })
  })
})

describe('watches', () => {
  const PRINT = (...lines: string[]) => `node -e "console.log('${lines.join('\\n')}')"`

  it('update_goal sets a watch, checks it once and says whether the command works', async () => {
    const { id } = await create_goal({ name: 'Issues', objective: 'Triage new issues', working_dir: tmpdir() })
    const r = await update_goal({ goal_id: id, watches: { 'new issues': { command: PRINT('7', '9') }, broken: { command: 'node -e "process.exit(2)"', every_minutes: 30 } } })
    expect(r.changed).toHaveLength(2)
    expect(r.watches).toEqual([
      { name: 'broken', result: expect.stringMatching(/^the command failed \(Exit code 2\); it is tried again every 30 min$/) },
      { name: 'new issues', result: 'works: 2 items there now; a run starts when a new one appears. Some of what it got: "7", "9".' },
    ])
    // The first check is the baseline: nothing starts
    expect((await tick('session-A')).claimed).toEqual([])
    // Changing only how often it checks doesn't check again
    expect((await update_goal({ goal_id: id, watches: { 'new issues': { command: PRINT('7', '9'), every_minutes: 10 } } })).watches).toBeUndefined()
    expect((await update_goal({ goal_id: id, watches: { broken: null } })).changed).toEqual(['watch "broken" removed'])
    await expect(update_goal({ goal_id: id, watches: { x: { command: 'echo 1', every_minutes: 0 } } })).rejects.toThrow()
  })

  it('update_goal says when a watch sets the status, and what it is now', async () => {
    const { id } = await create_goal({ name: 'Tree', objective: 'Watch the tree', working_dir: tmpdir() })
    const r = await update_goal({ goal_id: id, watches: { tree: { command: PRINT('M a.ts'), fires: 'change', status: { rules: [{ match: '^M ', status: 'uncommitted', tone: 'attention' }], default: { status: 'clean' } } } } })
    expect(r.watches).toEqual([{ name: 'tree', result: `works: 1 line now; it sets the goal's status (now "uncommitted") at each check. Some of what it got: "M a.ts".` }])
  })

  it('create_goal takes watches too, and the brief and the overview carry them', async () => {
    const r = await create_goal({ name: 'Issues', objective: 'Triage new issues', working_dir: tmpdir(), watches: { 'new issues': { command: PRINT('7') } } })
    // One line for a watch of new lines may be one fixed line, so it warns (#185); the watch is still set
    expect(r.watches).toEqual([{ name: 'new issues', result: 'works: 1 item there now; a run starts when a new one appears. Some of what it got: "7". Warning: every line the first check got is the same one: if its source should have several, the watch may only ever see that line.' }])
    const run = await claim(r.id)
    const brief = await withScope({ planId: r.id, runId: run.run_id }, () => get_goal_brief({ goal_id: r.id, run_id: run.run_id })) as { watch_events: unknown[] }
    expect(brief.watch_events).toEqual([])
    const overview = await goals_overview({}) as unknown as { goals: { id: string; watches: { name: string; runs: string }[] }[] }
    expect(overview.goals.find((g) => g.id === r.id)!.watches).toMatchObject([{ name: 'new issues', runs: PRINT('7'), failing: false }])
  })
})

describe('tool watches', () => {
  const SEARCH = 'mcp__claude_ai_Gmail__search_threads'
  const answer = (...ids: string[]) => JSON.stringify({ threads: ids.map((id) => ({ id })) })

  it("names every step of a steps watch in the set-up answer, not only the first step's tool", async () => {
    const steps = [
      { tool: 'mcp__claude-in-chrome__tabs_create_mcp', pick: { tabId: { regex: 'Tab ID: (\\d+)' } } },
      { tool: 'mcp__claude-in-chrome__get_page_text', input: { tabId: '{{tabId}}' } },
    ]
    const r = await create_goal({ name: 'Page', objective: 'Watch a page', working_dir: tmpdir(), watches: { page: { steps, finally: { tool: 'mcp__claude-in-chrome__tabs_close_mcp', input: { tabId: '{{tabId}}' } } } } })
    expect(r.watches).toEqual([{ name: 'page', result: 'set; the session running goals runs 2 steps (tabs_create_mcp, get_page_text) within a minute, and goal_detail says if that fails' }])
  })

  it('goals_tick hands a due tool watch to the plugin, and watch_report queues a run for what is new', async () => {
    const { id } = await create_goal({ name: 'Mail', objective: 'Answer new mail', working_dir: tmpdir() })
    const r = await update_goal({ goal_id: id, watches: { mail: { tool: SEARCH, input: { query: 'is:unread' }, every_minutes: 1 } } })
    expect(r.watches).toEqual([{ name: 'mail', result: expect.stringContaining(`calls ${SEARCH} within a minute`) }])
    // Only a caller that says it checks tool watches is given them
    expect(await tick('session-A')).not.toHaveProperty('tool_watches')
    const pass = await goals_tick({ holder: 'session-A', tool_watches: true }) as PassResult
    expect(pass.tool_watches).toMatchObject([{ goal_id: id, name: 'mail', tool: SEARCH, input: { query: 'is:unread' } }])
    const watchId = pass.tool_watches![0]!.watch_id

    expect(await watch_report({ watch_id: watchId, text: answer('1a') })).toMatchObject({ baseline: true, lines: 1, new: 0, queued_run: null })
    const fresh = await watch_report({ watch_id: watchId, text: answer('2b', '1a') })
    expect(fresh).toMatchObject({ baseline: false, new: 1, queued_run: expect.any(String) })
    const run = (await tick('session-A')).claimed[0]!
    expect(run).toMatchObject({ run_id: fresh.queued_run, trigger: 'watch' })
    const brief = await withScope({ planId: id, runId: run.run_id }, () => get_goal_brief({ goal_id: id, run_id: run.run_id })) as { watch_events: unknown[] }
    expect(brief.watch_events).toEqual([{ watch: 'mail', new: ['2b'], omitted: 0 }])

    expect(await watch_report({ watch_id: watchId, error: 'refused' })).toMatchObject({ new: 0, error: 'refused', queued_run: null })
    await expect(watch_report({ watch_id: watchId })).rejects.toThrow()
    await expect(watch_report({ watch_id: 'nope', text: '' })).rejects.toThrow(/not found/)
  })

  it('end_run needs handled after a watch run, and brings back the events it leaves out (#201)', async () => {
    const { id } = await create_goal({ name: 'Mail', objective: 'Answer new mail', working_dir: tmpdir() })
    await update_goal({ goal_id: id, watches: { mail: { tool: SEARCH, input: { query: 'is:unread' }, every_minutes: 1 } } })
    const pass = await goals_tick({ holder: 'session-A', tool_watches: true }) as PassResult
    const watchId = pass.tool_watches![0]!.watch_id
    await watch_report({ watch_id: watchId, text: answer('1a') })
    await watch_report({ watch_id: watchId, text: answer('2b', '3c', '1a') })
    const run = (await tick('session-A')).claimed[0]!
    await withScope({ planId: id, runId: run.run_id }, async () => {
      await get_goal_brief({ goal_id: id, run_id: run.run_id })
      await expect(end_run({ run_id: run.run_id, summary: 'done' })).rejects.toThrow('This run had watch_events, so end_run needs handled')
      await expect(end_run({ run_id: run.run_id, summary: 'done', handled: ['9z'] })).rejects.toThrow('handled names "9z"')
      expect(getRun(run.run_id)!.status).toBe('running')
      await end_run({ run_id: run.run_id, summary: 'answered 2b', handled: ['2b'] })
    })
    const next = (await tick('session-A')).claimed[0]!
    expect(next).toMatchObject({ trigger: 'watch' })
    const brief = await withScope({ planId: id, runId: next.run_id }, () => get_goal_brief({ goal_id: id, run_id: next.run_id })) as { watch_events: unknown[] }
    expect(brief.watch_events).toEqual([{ watch: 'mail', new: ['3c'], omitted: 0, carried_over: [{ line: '3c', attempts: 1 }] }])
  })

  it('a watch is a command or a tool, and not a tool the goal would have to ask for', async () => {
    const { id } = await create_goal({ name: 'Mail', objective: 'x', working_dir: tmpdir(), tool_map: { 'mcp__*Gmail*__send_message': 'email.send' } })
    await expect(update_goal({ goal_id: id, watches: { x: { command: 'echo 1', tool: SEARCH } } })).rejects.toThrow()
    await expect(update_goal({ goal_id: id, watches: { x: {} } })).rejects.toThrow()
    await expect(update_goal({ goal_id: id, watches: { x: { tool: 'mcp__claude_ai_Gmail__send_message' } } })).rejects.toThrow(/may only read/)
  })
})

describe('create_goal with autonomy and tool rules', () => {
  it('stores them, so a template\'s approvals work from the first run', async () => {
    const r = await create_goal({
      name: 'Inbox', objective: 'triage', working_dir: process.cwd(),
      autonomy: { 'email.send': 'off' }, tool_map: { 'mcp__*Gmail*__send_message': 'email.send' },
    })
    expect(getGoal(r.id)).toMatchObject({ autonomy: { 'email.send': 'off' }, tool_map: { 'mcp__*Gmail*__send_message': 'email.send' } })
  })
})

describe('goal model', () => {
  it('create_goal and update_goal set the model its runs use; the claimed run carries it', async () => {
    const made = await create_goal({ name: 'Feeds', objective: 'Read feeds', working_dir: tmpdir(), model: 'Sonnet' }) as { id: string; model: string | null }
    expect(made.model).toBe('sonnet')
    const changed = await update_goal({ goal_id: made.id, model: 'claude-opus-5-5' }) as { changed: string[] }
    expect(changed.changed).toEqual(['runs use claude-opus-5-5'])
    await run_goal({ goal_id: made.id })
    const pass = await tick('session-a')
    expect(pass.claimed.find((r) => r.goal_id === made.id)?.model).toBe('claude-opus-5-5')
    await update_goal({ goal_id: made.id, model: null })
    expect(getGoal(made.id)!.model).toBeNull()
  })

  it("refuses a model name that can't be one, and makes no goal", async () => {
    await expect(create_goal({ name: 'Bad', objective: 'x', working_dir: tmpdir(), model: 'two words' })).rejects.toThrow(/isn't a model/)
    const goal = makeGoal()
    await expect(update_goal({ goal_id: goal, model: 'two words' })).rejects.toThrow(/isn't a model/)
  })
})

describe('clear_run_hold (#104)', () => {
  it('lifts the usage-limit hold and records it against the goal whose run set it', async () => {
    const id = makeGoal('goal_hold')
    const run = await claim(id)
    await report_run_end({ run_id: run.run_id, answer: "You've hit your 5-hour limit" })
    expect(getRunHold()).toMatchObject({ plan_id: id })
    expect(await clear_run_hold({})).toEqual({ cleared: true })
    expect(getRunHold()).toBeNull()
    const ev = getEvents(id).filter((e) => e.event_type === 'run_hold_cleared')
    expect(ev).toHaveLength(1)
    expect(ev[0].actor).toBe('human')
  })

  it('changes nothing when there is no hold', async () => {
    expect(await clear_run_hold({})).toEqual({ cleared: false })
  })

  it('goals_tick lifts the hold when every usage window is below 100%, and records it', async () => {
    const id = makeGoal('goal_hold_auto')
    const run = await claim(id)
    await report_run_end({ run_id: run.run_id, answer: "You've hit your 5-hour limit" })
    await goals_tick({ holder: 'session-A', rate_limits: [{ percent_used: 100 }] })
    expect(getRunHold()).not.toBeNull()
    await goals_tick({ holder: 'session-A', rate_limits: [{ percent_used: 12 }, { percent_used: 40 }] })
    expect(getRunHold()).toBeNull()
    const ev = getEvents(id).filter((e) => e.event_type === 'run_hold_cleared')
    expect(ev).toHaveLength(1)
    expect(ev[0].actor).toBe('agent')
  })
})

describe('copy_goal (#208)', () => {
  const from = process.cwd()
  const to = tmpdir()
  // Each folder's origin remote, without running git
  const remotes: Record<string, string> = { [from]: 'https://github.com/me/alpha.git', [to]: 'git@github.com:me/beta.git' }
  const run = async (_cmd: string, args: string[]) => remotes[args[1]] ?? Promise.reject(new Error('no remote'))

  it('copies the set-up, paused, with the folder and repo rewritten, and records it', async () => {
    const src = await create_goal({
      name: 'Fixer', objective: 'Fix issues', working_dir: from, instructions: `Work in ${from} on me/alpha`,
      autonomy: { 'email.send': 'auto' }, tool_map: { 'mcp__x__send*': 'email.send' }, schedule: { kind: 'interval', minutes: 60 },
      // A local command, so creating the goal's first check doesn't reach GitHub
      watches: { issues: { command: `node -e "console.log('me/alpha')"` } },
    })
    insertMemory({ plan_id: src.id, kind: 'fact', text: 'about alpha', source: 'human' })
    const r = await copy_goal({ goal_id: src.id, working_dir: to, name: 'Fixer (beta)' }, run)
    expect(r).toMatchObject({ name: 'Fixer (beta)', working_dir: to, status: 'paused', next_run_at: null, watches: 1 })
    expect(r.replacements.map((x) => x.to)).toEqual(expect.arrayContaining(['me/beta']))
    expect(getGoal(r.id!)).toMatchObject({ instructions: expect.stringContaining('me/beta'), autonomy: { 'email.send': 'auto' }, tool_map: { 'mcp__x__send*': 'email.send' }, status: 'paused', next_run_at: null })
    expect(getGoal(r.id!)!.instructions).not.toContain('me/alpha')
    expect(getEvents(r.id!).find((e) => e.event_type === 'goal_copied')).toBeTruthy()
  })

  it('saves the text the person confirmed, and refuses a missing goal or folder', async () => {
    const src = await create_goal({ name: 'A', objective: 'B', working_dir: from, instructions: 'old' })
    const r = await copy_goal({ goal_id: src.id, working_dir: to, instructions: 'confirmed', watches: {} }, run)
    expect(getGoal(r.id!)!.instructions).toBe('confirmed')
    expect(r.replacements).toEqual([])
    await expect(copy_goal({ goal_id: 'nope', working_dir: to }, run)).rejects.toThrow(/not found/)
    await expect(copy_goal({ goal_id: src.id, working_dir: '/no/such/dir/xyz' }, run)).rejects.toThrow(/not found/)
  })

  it('previews the rewrite without creating anything', async () => {
    const src = await create_goal({ name: 'P', objective: 'B', working_dir: from, instructions: `In ${from} on me/alpha` })
    const r = await copy_goal({ goal_id: src.id, working_dir: to, preview: true }, run)
    expect(r).toMatchObject({ preview: true, name: 'P', working_dir: to, instructions: expect.stringContaining('me/beta'), watches: {} })
    expect(r).not.toHaveProperty('id')
  })

  it('makes a missing folder only when asked, and only one level', async () => {
    const src = await create_goal({ name: 'N', objective: 'B', working_dir: from })
    const fresh = join(mkdtempSync(join(tmpdir(), 'qd-copy-')), 'Selling')
    expect(await copy_goal({ goal_id: src.id, working_dir: fresh, preview: true }, run)).toMatchObject({ exists: false })
    await expect(copy_goal({ goal_id: src.id, working_dir: fresh }, run)).rejects.toThrow(/not found/)
    await expect(copy_goal({ goal_id: src.id, working_dir: join(fresh, 'deeper'), preview: true }, run)).rejects.toThrow(/neither is the folder/)
    const r = await copy_goal({ goal_id: src.id, working_dir: fresh, create_dir: true }, run)
    expect(existsSync(fresh)).toBe(true)
    expect(r.working_dir).toBe(fresh)
  })
})

describe('resolveTargetDir', () => {
  const from = join(tmpdir(), 'GitHub', 'Quarterdeck')
  const github = join(tmpdir(), 'GitHub')

  it('takes a bare name as a sibling of the goal folder', () => {
    expect(resolveTargetDir(from, 'Selling')).toBe(join(github, 'Selling'))
    expect(resolveTargetDir(from, ' Goals/Selling ')).toBe(join(github, 'Goals', 'Selling'))
  })

  it('goes from the folder itself for ./ and ../, from home for ~, and keeps a full path', () => {
    expect(resolveTargetDir(from, './Selling')).toBe(join(from, 'Selling'))
    // A backslash counts as a separator after the dot everywhere, so .\Selling is inside too
    expect(resolveTargetDir(from, '.\\Selling')).toBe(resolve(from, '.\\Selling'))
    expect(resolveTargetDir(from, '../Selling')).toBe(join(github, 'Selling'))
    expect(resolveTargetDir(from, '~/Selling')).toBe(join(homedir(), 'Selling'))
    expect(resolveTargetDir(from, '~')).toBe(homedir())
    expect(resolveTargetDir(from, join(tmpdir(), 'Elsewhere'))).toBe(join(tmpdir(), 'Elsewhere'))
  })

  it('saves the full path for a name typed to move_goal', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qd-rel-'))
    const goalDir = join(base, 'Quarterdeck')
    mkdirSync(goalDir)
    const src = await create_goal({ name: 'Rel', objective: 'B', working_dir: goalDir })
    const run = async () => Promise.reject(new Error('no remote'))
    const preview = await move_goal({ goal_id: src.id, working_dir: 'Selling', preview: true }, run)
    expect(preview).toMatchObject({ working_dir: join(base, 'Selling'), exists: false })
    await move_goal({ goal_id: src.id, working_dir: 'Selling', create_dir: true }, run)
    expect(getPlan(src.id)!.working_dir).toBe(join(base, 'Selling'))
    expect(existsSync(join(base, 'Selling'))).toBe(true)
  })
})

describe('move_goal', () => {
  const from = process.cwd()
  const remotes: Record<string, string> = { [from]: 'https://github.com/me/alpha.git' }
  const run = async (_cmd: string, args: string[]) => remotes[args[1]] ?? Promise.reject(new Error('no remote'))

  it('moves the same goal, rewriting its folder, and records it', async () => {
    const src = await create_goal({ name: 'Web', objective: 'Sell things', working_dir: from, instructions: `Keep photos in ${from}` })
    insertMemory({ plan_id: src.id, kind: 'fact', text: 'kept', source: 'human' })
    const to = join(mkdtempSync(join(tmpdir(), 'qd-move-')), 'Selling')
    const preview = await move_goal({ goal_id: src.id, working_dir: to, preview: true }, run)
    expect(preview).toMatchObject({ preview: true, exists: false, instructions: `Keep photos in ${to}` })
    expect(getPlan(src.id)!.working_dir).toBe(from)
    const r = await move_goal({ goal_id: src.id, working_dir: to, instructions: preview.instructions, watches: preview.watches, create_dir: true }, run)
    expect(r).toMatchObject({ id: src.id, working_dir: to })
    expect(getPlan(src.id)!.working_dir).toBe(to)
    expect(getGoal(src.id)!.instructions).toBe(`Keep photos in ${to}`)
    expect(getEvents(src.id).find((e) => e.event_type === 'goal_moved')).toBeTruthy()
  })

  it('refuses the same folder and a goal with a run going', async () => {
    const src = await create_goal({ name: 'R', objective: 'B', working_dir: from })
    await expect(move_goal({ goal_id: src.id, working_dir: from.toUpperCase() + '/' }, run)).rejects.toThrow(/already works/)
    queueRun(src.id)
    await expect(move_goal({ goal_id: src.id, working_dir: tmpdir() }, run)).rejects.toThrow(/run is going/)
  })
})
