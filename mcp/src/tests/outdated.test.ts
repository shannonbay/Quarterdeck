import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OUTDATED_MESSAGE } from '@quarterdeck/core'

const outdated = { value: false }
vi.mock('../db.js', async (load) => ({ ...(await load<typeof import('../db.js')>()), schemaOutdated: () => outdated.value }))
const { outdatedRefusal, REFUSED_WHEN_OUTDATED } = await import('../outdated.js')

beforeEach(() => { outdated.value = false })

describe('a server on older code than the database (#60)', () => {
  it("refuses the person's changes and decisions, and what queues runs, with the reload message", () => {
    outdated.value = true
    for (const tool of ['decide_item', 'update_goal', 'create_goal', 'delete_goal', 'restore_goal', 'purge_goal', 'set_goal_status', 'set_schedule', 'delete_memory', 'trust_memory', 'cancel_run', 'run_goal', 'watch_report']) {
      expect(outdatedRefusal(tool)).toBe(OUTDATED_MESSAGE)
    }
    expect(OUTDATED_MESSAGE).toMatch(/reload-plugins/)
  })

  it("lets reads, the scheduler pass, a run's own tools and to-dos go on", () => {
    outdated.value = true
    for (const tool of [
      'goals_overview', 'get_item', 'list_goals', 'get_goal_brief', 'goals_tick',
      'add_item', 'remember', 'recall', 'forget', 'propose_curation', 'end_run', 'set_status', 'update_task',
      'attach_agent', 'fail_run', 'guard_check', 'report_run_end', 'run_progress',
      'todo_list', 'todo_add', 'todo_set',
    ]) {
      expect(REFUSED_WHEN_OUTDATED.has(tool)).toBe(false)
      expect(outdatedRefusal(tool)).toBeNull()
    }
  })

  it('refuses nothing while the server is current', () => {
    for (const tool of REFUSED_WHEN_OUTDATED) expect(outdatedRefusal(tool)).toBeNull()
  })
})
