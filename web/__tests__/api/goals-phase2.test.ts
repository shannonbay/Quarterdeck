import { describe, it, expect } from 'vitest'

import { NextRequest } from 'next/server'
import { tmpdir } from 'os'
import { POST as POSTGoal } from '@/app/api/goals/route.js'
import { GET as GETGoal, PATCH as PATCHGoal } from '@/app/api/goals/[id]/route.js'
import { POST as POSTWebhook, DELETE as DELETEWebhook } from '@/app/api/goals/[id]/webhook/route.js'
import { POST as POSTTrigger } from '@/app/api/goals/[id]/trigger/route.js'
import { POST as POSTHealth } from '@/app/api/goals/[id]/health/route.js'
import { DELETE as DELETEHold } from '@/app/api/goals/hold/route.js'
import { getDb, getGoal, getOpenRun, getSchedule, listHealth } from '@/lib/db'
import * as core from '@quarterdeck/core'

function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/x', {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  })
}
const p = (id: string) => ({ params: Promise.resolve({ id }) })
async function goal(body: Record<string, unknown> = {}) {
  const res = await POSTGoal(req('POST', { name: 'Inbox', objective: 'x', working_dir: tmpdir(), ...body }))
  return (await res.json()).id as string
}
const FAIL_HEALTH = 'node -e "console.log(\'unread: 42\'); process.exit(1)"'

describe('schedules', () => {
  it('creates a cron goal with the next run at the next match', async () => {
    const id = await goal({ cron: '0 9 * * *' })
    expect(getSchedule(id)).toEqual({ kind: 'cron', expr: '0 9 * * *' })
    const next = new Date(getGoal(id)!.next_run_at!)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  it('PATCH switches between interval, cron and manual, and rejects bad cron', async () => {
    const id = await goal({ interval_minutes: 30 })
    await PATCHGoal(req('PATCH', { schedule: { kind: 'cron', expr: '*/15 * * * *' } }), p(id))
    expect(getSchedule(id)).toEqual({ kind: 'cron', expr: '*/15 * * * *' })
    expect(new Date(getGoal(id)!.next_run_at!).getMinutes() % 15).toBe(0)
    const bad = await PATCHGoal(req('PATCH', { schedule: { kind: 'cron', expr: '99 * * * *' } }), p(id))
    expect(bad.status).toBe(400)
    await PATCHGoal(req('PATCH', { schedule: null }), p(id))
    expect(getSchedule(id)).toBeNull()
    expect(getGoal(id)!.next_run_at).toBeNull()
  })

  it('PATCH saves tool rules and health settings', async () => {
    const id = await goal()
    await PATCHGoal(req('PATCH', { tool_map: { 'mcp__gmail__send*': 'email.send' }, health_command: 'echo 1', health_every_minutes: 15, health_triggers_run: false }), p(id))
    expect(getGoal(id)).toMatchObject({ tool_map: { 'mcp__gmail__send*': 'email.send' }, health_command: 'echo 1', health_every_minutes: 15, health_triggers_run: false })
  })
})

describe('webhook', () => {
  it('rejects bad secrets, queues a run, and coalesces repeats', async () => {
    const id = await goal()
    const { secret } = await (await POSTWebhook(req('POST'), p(id))).json()
    expect((await (await GETGoal(req('GET'), p(id))).json()).webhook_enabled).toBe(true)

    expect((await POSTTrigger(req('POST', {}, { authorization: 'Bearer nope' }), p(id))).status).toBe(401)
    const first = await POSTTrigger(req('POST', { reason: 'new mail' }, { authorization: `Bearer ${secret}` }), p(id))
    expect(first.status).toBe(202)
    expect(getOpenRun(id)).toMatchObject({ status: 'queued', trigger: 'event' })
    const again = await (await POSTTrigger(req('POST', undefined, { 'x-quarterdeck-secret': secret }), p(id))).json()
    expect(again.coalesced).toBe(true)
    const old = await (await POSTTrigger(req('POST', undefined, { 'x-conductor-secret': secret }), p(id))).json()
    expect(old.coalesced).toBe(true)

    await DELETEWebhook(req('DELETE'), p(id))
    expect((await POSTTrigger(req('POST', {}, { authorization: `Bearer ${secret}` }), p(id))).status).toBe(401)
  })
})

describe('health checks', () => {
  it('Check now records the result and queues a run on failure', async () => {
    const id = await goal()
    await PATCHGoal(req('PATCH', { health_command: FAIL_HEALTH }), p(id))
    const r = await (await POSTHealth(req('POST'), p(id))).json()
    expect(r).toEqual({ passed: false, queuedRun: true })
    expect(getOpenRun(id)).toMatchObject({ trigger: 'health' })
    const data = await (await GETGoal(req('GET'), p(id))).json()
    expect(data.health[0]).toMatchObject({ passed: false, value: 42 })
  })

  it('does not queue a run when health_triggers_run is off', async () => {
    const id = await goal()
    await PATCHGoal(req('PATCH', { health_command: FAIL_HEALTH, health_triggers_run: false }), p(id))
    expect((await (await POSTHealth(req('POST'), p(id))).json()).queuedRun).toBe(false)
  })


  it('returns 400 without a health command', async () => {
    const id = await goal()
    expect((await POSTHealth(req('POST'), p(id))).status).toBe(400)
  })
})

describe('promote-to-auto suggestions', () => {
  it('suggests auto after 10 approvals in a row for a propose category', async () => {
    const id = await goal()
    const db = getDb()
    for (let i = 0; i < 10; i++) {
      const t = core.addItem(db, id, null, { goal: `reply ${i}`, action: { category: 'email.draft_reply', summary: 's' } }).task
      core.approveTask(db, id, t.id)
    }
    const r = core.addItem(db, id, null, { goal: 'one more', action: { category: 'email.send', summary: 's' } }).task
    core.rejectTask(db, id, r.id, 'no')
    const data = await (await GETGoal(req('GET'), p(id))).json()
    expect(data.suggestions).toEqual([{ category: 'email.draft_reply', approved_in_a_row: 10, kind: 'auto' }])

    // Now auto: the same streak suggests keeping it auto after outside text (#189)
    await PATCHGoal(req('PATCH', { autonomy: { 'email.draft_reply': 'auto' } }), p(id))
    expect((await (await GETGoal(req('GET'), p(id))).json()).suggestions).toEqual([{ category: 'email.draft_reply', approved_in_a_row: 10, kind: 'after_outside' }])

    // Once listed in auto_after_outside, or set to off, nothing is suggested
    core.updateGoal(db, id, { auto_after_outside: ['email.draft_reply'] })
    expect((await (await GETGoal(req('GET'), p(id))).json()).suggestions).toEqual([])
    core.updateGoal(db, id, { auto_after_outside: [] })
    await PATCHGoal(req('PATCH', { autonomy: { 'email.draft_reply': 'off' } }), p(id))
    expect((await (await GETGoal(req('GET'), p(id))).json()).suggestions).toEqual([])
  })

  it('a rejection among the last 10 breaks an auto category after-outside streak (#189)', async () => {
    const id = await goal()
    const db = getDb()
    // Proposals made while at propose, as a marked run's would be: a rejection in the middle
    for (let i = 0; i < 10; i++) {
      const t = core.addItem(db, id, null, { goal: `review ${i}`, action: { category: 'github.review', summary: 's' } }).task
      if (i === 4) core.rejectTask(db, id, t.id, 'no'); else core.approveTask(db, id, t.id)
    }
    await PATCHGoal(req('PATCH', { autonomy: { 'github.review': 'auto' } }), p(id))
    expect((await (await GETGoal(req('GET'), p(id))).json()).suggestions).toEqual([])
  })
})

describe('usage-limit hold (#104)', () => {
  it('shows the hold on the goal page and Clear hold lifts it, recorded against the goal that set it', async () => {
    const id = await goal()
    const until = new Date(Date.now() + 3_600_000).toISOString()
    core.setRunHold(getDb(), { until, reason: 'usage limit', plan_id: id })
    const page = await (await GETGoal(req('GET'), p(id))).json()
    expect(page.hold).toMatchObject({ until, plan_id: id })

    const res = await DELETEHold(req('DELETE'))
    expect(await res.json()).toEqual({ cleared: true })
    expect(core.getRunHold(getDb())).toBeNull()
    expect((await (await GETGoal(req('GET'), p(id))).json()).hold).toBeNull()
    const events = getDb().prepare("SELECT actor, payload FROM events WHERE plan_id = ? AND event_type = 'run_hold_cleared'").all(id) as { actor: string; payload: string }[]
    expect(events).toHaveLength(1)
    expect(events[0].actor).toBe('human')
    expect(JSON.parse(events[0].payload)).toMatchObject({ until, via: 'web' })
  })

  it('with no hold changes nothing', async () => {
    expect(await (await DELETEHold(req('DELETE'))).json()).toEqual({ cleared: false })
  })
})
