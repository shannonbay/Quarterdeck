/**
 * Fewer quiet runs (#111), played out against the bundled server: a command watch's match and
 * ignore, the goal's gap between watch runs, and an urgent watch that starts a run despite it.
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRINT_LINES, startLiveServer, type LiveServer } from './server.js'

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

const HOLDER = 'live-test-session'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
interface Claimed { run_id: string; goal_id: string; trigger: string }

/** Passes until one hands out a run of this goal (a queued run can take a second pass); null when none does. */
async function claim(goalId: string, passes = 3): Promise<Claimed | null> {
  for (let i = 0; i < passes; i++) {
    const run = ((await server.call('goals_tick', { holder: HOLDER })) as { claimed?: Claimed[] }).claimed?.find((c) => c.goal_id === goalId)
    if (run) return run
  }
  return null
}

/** Plays a claimed run's agent and gives the watch news its brief carried. */
async function play(run: Claimed): Promise<{ watch: string; new: string[] }[]> {
  const brief = await server.call('get_goal_brief', { goal_id: run.goal_id, run_id: run.run_id, run_scope: run.run_id })
  await server.call('end_run', { summary: 'Live test run.', run_scope: run.run_id })
  return (brief.watch_events ?? []).map((n: Any) => ({ watch: n.watch, new: n.new })).sort((a: Any, b: Any) => a.watch.localeCompare(b.watch))
}

function makeWatchesDue(goalId: string): void {
  server.db.prepare('UPDATE goal_watches SET last_checked_at = ? WHERE plan_id = ?').run(new Date(Date.now() - 120_000).toISOString(), goalId)
}

describe('fewer quiet runs', () => {
  it('filters a command watch, holds watch runs apart, and lets an urgent watch through', async () => {
    const dir = server.workDir('listings')
    const add = (file: string, line: string) => appendFileSync(join(dir, file), `${line}\n`)
    writeFileSync(join(dir, 'free.txt'), 'old sofa\n')
    writeFileSync(join(dir, 'free.cjs'), "process.stdout.write(require('fs').readFileSync('free.txt', 'utf8'))\n")

    const made = await server.call('create_goal', {
      name: 'Listings', objective: 'Look at new listings', working_dir: dir,
      watches: {
        listings: { command: PRINT_LINES, match: '^item', ignore: 'sponsored', every_minutes: 1 },
        free: { command: 'node free.cjs', urgent: true, every_minutes: 1 },
      },
    })
    const goalId: string = made.id
    const changed = await server.call('update_goal', { goal_id: goalId, min_watch_gap_minutes: 30 })
    expect(changed.changed).toEqual(['watch runs at least 30 min apart (urgent watches excepted)'])
    expect(await server.refused('update_goal', { goal_id: goalId, min_watch_gap_minutes: 5000 })).toMatch(/1440/)

    const card = (await server.call('goals_overview', { detail: [goalId] })).goals.find((g: Any) => g.id === goalId)
    expect(card.watch_gap_minutes).toBe(30)
    expect(card.watches.find((w: Any) => w.name === 'free')).toMatchObject({ urgent: true })
    expect(card.watches.find((w: Any) => w.name === 'listings').runs).toBe(`${PRINT_LINES} (lines: ^item) (ignoring: sponsored)`)

    // The first check is the baseline (create_goal made it); the first watch run has no gap to wait for
    add('lines.txt', 'item 1')
    add('lines.txt', 'noise')
    add('lines.txt', 'item 2 sponsored')
    makeWatchesDue(goalId)
    const first = await claim(goalId)
    expect(first).toMatchObject({ trigger: 'watch' })
    expect(await play(first!)).toEqual([{ watch: 'listings', new: ['item 1'] }])

    // Within the gap, news waits
    add('lines.txt', 'item 3')
    makeWatchesDue(goalId)
    expect(await claim(goalId)).toBeNull()
    expect(server.db.prepare('SELECT COUNT(*) n FROM goal_watch_events WHERE plan_id = ? AND run_id IS NULL AND queued_at IS NULL').get(goalId)).toEqual({ n: 1 })

    // An urgent watch's news starts a run at once, and carries what was waiting
    add('free.txt', 'free table')
    makeWatchesDue(goalId)
    const urgent = await claim(goalId)
    expect(urgent).toMatchObject({ trigger: 'watch' })
    expect(await play(urgent!)).toEqual([{ watch: 'free', new: ['free table'] }, { watch: 'listings', new: ['item 3'] }])

    // Once the gap has passed (moved back in the database), ordinary news starts a run again
    add('lines.txt', 'item 4')
    makeWatchesDue(goalId)
    expect(await claim(goalId)).toBeNull()
    server.db.prepare("UPDATE goal_runs SET started_at = ? WHERE plan_id = ? AND trigger = 'watch'").run(new Date(Date.now() - 31 * 60_000).toISOString(), goalId)
    const later = await claim(goalId)
    expect(later).toMatchObject({ trigger: 'watch' })
    expect(await play(later!)).toEqual([{ watch: 'listings', new: ['item 4'] }])
  })
})
