/**
 * A server on older code than the database (#60), against the bundled server: once another
 * session's newer Quarterdeck has upgraded the database, this one refuses the person's changes
 * and decisions with a reload message, keeps answering reads, schedules nothing, and lets a run
 * it started before the upgrade finish.
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '@quarterdeck/core'
import { startLiveServer, type LiveServer } from './server.js'

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

const HOLDER = 'live-test-outdated'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** As a newer Quarterdeck in another session would, by migrating the database past this code. */
const upgradeElsewhere = () => server.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
const restore = () => server.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

describe('a server on older code than the database', () => {
  it("refuses changes and decisions, answers reads, schedules nothing, and lets a run it started finish", async () => {
    const made = await server.call('create_goal', { name: 'Outdated', objective: 'Nothing', working_dir: server.workDir('outdated') })
    const goalId: string = made.id
    // A run this server started before the upgrade, which proposes something for the person
    await server.call('run_goal', { goal_id: goalId })
    const run = ((await server.call('goals_tick', { holder: HOLDER })) as { claimed: { run_id: string; goal_id: string }[] }).claimed.find((c) => c.goal_id === goalId)!
    await server.call('get_goal_brief', { goal_id: goalId, run_id: run.run_id, run_scope: run.run_id })
    const proposed: Any = await server.call('add_item', { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send' }, run_scope: run.run_id })

    upgradeElsewhere()
    try {
      // The person's changes and decisions are refused, with the reload message, and change nothing
      for (const [tool, args] of [
        ['decide_item', { goal_id: goalId, item_id: proposed.item.id, decision: 'approve' }],
        ['set_goal_status', { goal_id: goalId, status: 'paused' }],
        ['update_goal', { goal_id: goalId, name: 'Renamed' }],
        ['run_goal', { goal_id: goalId }],
      ] as const) {
        await expect(server.call(tool, args)).rejects.toThrow(/updated in another session.*reload-plugins/)
      }
      const item = server.db.prepare('SELECT status, review_requested_at FROM tasks WHERE plan_id = ? AND id = ?').get(goalId, proposed.item.id) as Any
      expect(item.review_requested_at).not.toBeNull()
      expect((server.db.prepare('SELECT status FROM goals WHERE plan_id = ?').get(goalId) as Any).status).toBe('active')

      // Reads still answer, and say the session is outdated; the scheduler pass claims nothing
      const overview: Any = await server.call('goals_overview', {})
      expect(overview.outdated).toBe(true)
      expect(overview.goals.find((g: Any) => g.id === goalId).needs_you).toHaveLength(1)
      expect(await server.call('goals_tick', { holder: HOLDER })).toMatchObject({ outdated: true, claimed: [] })

      // The run it started before the upgrade can still save and end
      await server.call('remember', { kind: 'fact', text: 'Alice prefers short replies.', run_scope: run.run_id })
      await server.call('end_run', { summary: 'Proposed a reply.', run_scope: run.run_id })
      expect((server.db.prepare('SELECT status FROM goal_runs WHERE id = ?').get(run.run_id) as Any).status).toBe('completed')
    } finally {
      restore()
    }

    // Back on current code, the same decision goes through
    await server.call('decide_item', { goal_id: goalId, item_id: proposed.item.id, decision: 'approve' })
    expect((server.db.prepare('SELECT approved_at FROM tasks WHERE plan_id = ? AND id = ?').get(goalId, proposed.item.id) as Any).approved_at).not.toBeNull()
  })
})
