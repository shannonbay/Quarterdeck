import { OUTDATED_MESSAGE } from '@quarterdeck/core'
import { schemaOutdated } from './db.js'

/**
 * The tools a server refuses once another session's newer Quarterdeck has upgraded the
 * database (#60): the person's changes to goals and decisions on items, and what queues
 * runs. This code can't tell what newer data means, so it could settle a request it
 * doesn't understand without saying so.
 *
 * Everything else keeps working: reads (goals_overview, get_item, the brief), so the
 * pane still shows the goals and its reload notice; goals_tick, which already schedules
 * nothing on outdated code; and a run's own tools (add_item, remember, end_run,
 * set_status, ...) with the runner's bookkeeping for it (attach_agent, fail_run,
 * guard_check, report_run_end, run_progress, run_step). An outdated server claims no new runs, so
 * those only serve a run it started before the upgrade, and refusing them would lose
 * that run's work and its end_run. To-do lists are plans, not goals, and are left alone.
 */
export const REFUSED_WHEN_OUTDATED = new Set([
  'decide_item',
  'update_goal',
  'create_goal',
  'delete_goal',
  'restore_goal',
  'purge_goal',
  'set_goal_status',
  'clear_run_hold',
  'set_schedule',
  'delete_memory',
  'restore_memory',
  'trust_memory',
  'cancel_run',
  'run_goal',
  'request_run',
  'watch_report',
])

/** The refusal for a call to `tool`, or null when it may go ahead. */
export function outdatedRefusal(tool: string): string | null {
  return REFUSED_WHEN_OUTDATED.has(tool) && schemaOutdated() ? OUTDATED_MESSAGE : null
}
