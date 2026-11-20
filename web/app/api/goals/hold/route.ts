import { NextRequest } from 'next/server'
import { getGoal, clearRunHold } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, serverError, refuseIfOutdated } from '@/lib/api-utils'

/**
 * DELETE — the person lifts the usage-limit hold on all goal runs (#104), say
 * after switching accounts. If the limit still applies, the next run sets it
 * again. Recorded against the goal whose run set the hold, when there is one.
 */
export async function DELETE(_req: NextRequest) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const hold = clearRunHold()
    if (hold?.plan_id && getGoal(hold.plan_id)) {
      recordEvent({ planId: hold.plan_id, taskId: hold.plan_id, eventType: 'run_hold_cleared', actor: 'human', payload: { until: hold.until, via: 'web' } })
    }
    return ok({ cleared: hold !== null })
  } catch (e) {
    return serverError(e)
  }
}
