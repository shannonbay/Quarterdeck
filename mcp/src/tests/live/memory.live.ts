/**
 * Memory over budget, played out against the bundled server (issue 42): the brief's index and
 * recall, then a curation run from the scheduler's tick through propose_curation to the person's
 * approval. Each test plays the parts Claude Code plays: the scheduler's tick, a run's agent (with
 * run_scope as the guard plugin sets it) and the person (decide_item).
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEMORY_BRIEF_CHARS } from '@quarterdeck/core'
import { startLiveServer, type LiveServer } from './server.js'

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

const HOLDER = 'live-test-memory'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
interface Claimed { run_id: string; goal_id: string; trigger: string; model: string | null }

/** Ticks until the scheduler hands out a run of this goal. */
async function claim(goalId: string, passes = 4): Promise<Claimed | null> {
  for (let i = 0; i < passes; i++) {
    const run = ((await server.call('goals_tick', { holder: HOLDER })) as { claimed?: Claimed[] }).claimed?.find((c) => c.goal_id === goalId)
    if (run) return run
  }
  return null
}

describe('memory over budget', () => {
  it('lists left-out memory for recall, then curates it once the person approves', async () => {
    const made = await server.call('create_goal', { name: 'Remembers a lot', objective: 'Keep notes', working_dir: server.workDir('memory'), model: 'haiku' })
    const goalId: string = made.id

    // A run saves more memory than a brief carries
    await server.call('run_goal', { goal_id: goalId })
    const first = (await claim(goalId))!
    expect(first.model).toBe('haiku')
    await server.call('get_goal_brief', { goal_id: goalId, run_id: first.run_id, run_scope: first.run_id })
    const size = Math.ceil(MEMORY_BRIEF_CHARS / 3) + 100
    for (const n of [1, 2, 3]) {
      await server.call('remember', { kind: 'fact', text: `Note ${n}: ${'x'.repeat(size)}`, run_scope: first.run_id })
    }
    await server.call('end_run', { summary: 'Saved three notes.', run_scope: first.run_id })

    // The next run sees the oldest note only in the index, and recalls it
    await server.call('run_goal', { goal_id: goalId })
    const second = (await claim(goalId))!
    expect(second.trigger).toBe('manual')
    const brief: Any = await server.call('get_goal_brief', { goal_id: goalId, run_id: second.run_id, run_scope: second.run_id })
    expect(brief.memory_omitted).toBe(1)
    expect(brief.memory_index).toEqual([expect.objectContaining({ kind: 'fact', source: 'agent', start: expect.stringMatching(/^Note 1: x+…$/) })])
    const left: string = brief.memory_index[0].id
    const recalled: Any = await server.call('recall', { memory_ids: [left], run_scope: second.run_id })
    expect(recalled.memory[0].text).toBe(`Note 1: ${'x'.repeat(size)}`)
    await server.call('end_run', { summary: 'Read the old note.', run_scope: second.run_id })
    // Two runs aren't enough for a curation by time: it waits for a third
    expect(await claim(goalId, 2)).toBeNull()
    await server.call('run_goal', { goal_id: goalId })
    const third = (await claim(goalId))!
    expect(third.trigger).toBe('manual')
    await server.call('get_goal_brief', { goal_id: goalId, run_id: third.run_id, run_scope: third.run_id })
    await server.call('end_run', { summary: 'Nothing new.', run_scope: third.run_id })

    // Over budget after three runs: the next tick starts a curation run on opus, whatever the goal's model
    const curate = (await claim(goalId))!
    expect(curate).toMatchObject({ trigger: 'curate', model: 'opus' })
    const curation: Any = await server.call('get_goal_brief', { goal_id: goalId, run_id: curate.run_id, run_scope: curate.run_id })
    expect(curation.memory).toHaveLength(3)
    expect(curation).toMatchObject({ due: 'time', runs_since_curation: 3 })
    expect(curation.runs.map((r: Any) => r.summary)).toEqual(['Nothing new.', 'Read the old note.', 'Saved three notes.'])
    const ids: string[] = curation.memory.map((m: Any) => m.id)
    const proposed: Any = await server.call('propose_curation', {
      changes: [{ type: 'merge', from: ids, kind: 'fact', text: 'Notes 1 to 3: three long notes.' }],
      run_scope: curate.run_id,
    })
    await server.call('end_run', { summary: 'Proposed merging the notes.', run_scope: curate.run_id })

    // The person sees it under Needs you and approves: the server applies it
    const goal = (await server.call('goals_overview', {})).goals.find((g: Any) => g.id === goalId)
    expect(goal.needs_you).toEqual([expect.objectContaining({ id: proposed.item.id, goal: expect.stringContaining("Tidy this goal's memory") })])
    const decided: Any = await server.call('decide_item', { goal_id: goalId, item_id: proposed.item.id, decision: 'approve' })
    expect(decided.curation).toEqual({ applied: 1, skipped: [] })
    const active = server.db.prepare('SELECT text FROM goal_memory WHERE plan_id = ? AND active = 1').all(goalId) as { text: string }[]
    expect(active.map((m) => m.text)).toEqual(['Notes 1 to 3: three long notes.'])
    const events = server.db.prepare("SELECT 1 FROM events WHERE plan_id = ? AND event_type = 'memory_curated'").all(goalId)
    expect(events).toHaveLength(1)
    expect((await claim(goalId, 2))).toBeNull() // under budget now: nothing more to curate
  })
})
