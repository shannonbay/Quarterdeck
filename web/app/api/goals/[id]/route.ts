import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  getPlan, updatePlan, getGoal, updateGoal, getIntervalTrigger, listRuns, getOpenRun,
  listMemory, getGoalItems, getApprovalStats, MEMORY_BRIEF_CHARS,
  getSchedule, setSchedule, getRunHold, nextScheduledRun, getEventTrigger, listHealth, listToolCalls, getAutonomySuggestions, autoAfterOutsideWarning,
} from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { itemView } from '@/lib/goal-views'
import { ok, err, notFound, serverError, refuseIfOutdated } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** GET — everything the goal page shows. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    const goal = getGoal(id)
    if (!plan || !goal) return notFound('Goal')

    const items = getGoalItems(id)
    const open = items.filter((t) => t.status === 'pending' || t.status === 'active')
    return ok({
      plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
      goal,
      interval: getIntervalTrigger(id)?.config ?? null,
      open_run: getOpenRun(id) ?? null,
      runs: listRuns(id, 30),
      needs_you: open.filter((t) => t.review_requested_at).map(itemView),
      open_items: open.filter((t) => !t.review_requested_at).map(itemView),
      recently_resolved: items
        .filter((t) => t.status === 'completed' || t.status === 'abandoned')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 20)
        .map(itemView),
      memory: listMemory(id),
      memory_brief_chars: MEMORY_BRIEF_CHARS,
      approval_stats: getApprovalStats(id),
      schedule: getSchedule(id),
      webhook_enabled: Boolean(getEventTrigger(id)),
      health: listHealth(id, 30),
      tool_calls: listToolCalls(id, 20),
      suggestions: getAutonomySuggestions(id),
      // Shown before the person keeps a category auto after outside text (#159)
      auto_after_outside_warnings: Object.fromEntries([...new Set(Object.values(goal.tool_map))]
        .map((c) => [c, autoAfterOutsideWarning(goal.tool_map, c)]).filter(([, w]) => w)),
      hold: getRunHold(),
    })
  } catch (e) {
    return serverError(e)
  }
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1).optional(),
  instructions: z.string().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
  autonomy: z.record(z.string(), z.enum(['off', 'propose', 'auto'])).optional(),
  /** Categories kept auto after a run reads outside content (#159); the page warns before adding a risky one. */
  auto_after_outside: z.array(z.string().trim().min(1)).optional(),
  limits: z.object({
    max_run_minutes: z.number().int().min(1).max(120),
    max_items_per_run: z.number().int().min(1).max(500),
    max_runs_per_day: z.number().int().min(1).max(1440),
    // Loop protection: 0 turns each off
    max_runs_per_hour: z.number().int().min(0).max(60),
    max_idle_runs: z.number().int().min(0).max(100),
    max_item_attempts: z.number().int().min(0).max(100),
    // Minutes after a watch-started run before watch events start another (0: none)
    min_watch_gap_minutes: z.number().int().min(0).max(1440),
  }).partial().optional(),
  item_retention_days: z.number().int().min(1).max(365).optional(),
  interval: z.object({
    minutes: z.number().int().min(1).max(10_080),
    active_hours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Use HH:MM-HH:MM').nullable().optional(),
  }).nullable().optional(),
  /** Replaces interval: { kind: 'interval', minutes, active_hours? } | { kind: 'cron', expr } | null (manual only) */
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(10_080), active_hours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Use HH:MM-HH:MM').nullable().optional() }),
    z.object({ kind: z.literal('cron'), expr: z.string().trim().min(1) }),
  ]).nullable().optional(),
  tool_map: z.record(z.string().min(1), z.string().min(1)).optional(),
  health_command: z.string().trim().min(1).nullable().optional(),
  health_every_minutes: z.number().int().min(1).max(10_080).optional(),
  health_triggers_run: z.boolean().optional(),
})

/** PATCH — edit goal settings, pause/resume/retire, change the schedule. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id } = await params
    const goal = getGoal(id)
    if (!goal) return notFound('Goal')
    const parsed = PatchSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const { name, interval, schedule: scheduleInput, ...fields } = parsed.data

    if (name) updatePlan(id, { name, updated_at: new Date().toISOString() })
    if (fields.objective) updatePlan(id, { description: fields.objective })
    updateGoal(id, fields)

    // `interval` is the older form of `schedule`
    const schedule = scheduleInput !== undefined ? scheduleInput
      : interval !== undefined ? (interval ? { kind: 'interval' as const, ...interval } : null)
      : undefined
    if (schedule !== undefined) {
      try {
        setSchedule(id, schedule ? (schedule.kind === 'interval'
          ? { kind: 'interval', minutes: schedule.minutes, ...(schedule.active_hours && { active_hours: schedule.active_hours }) }
          : schedule) : null)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
    // A new schedule, or resuming, makes the next run due: now for intervals, the next match for cron
    const resumed = fields.status === 'active' && goal.status !== 'active'
    if (schedule !== undefined || resumed) {
      const s = getSchedule(id)
      updateGoal(id, { next_run_at: !s ? null : s.kind === 'interval' ? new Date().toISOString() : nextScheduledRun(id) })
    }

    recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'human', payload: { changes: Object.keys(parsed.data) } })
    return ok({ goal: getGoal(id), interval: getIntervalTrigger(id)?.config ?? null, schedule: getSchedule(id) })
  } catch (e) {
    return serverError(e)
  }
}
