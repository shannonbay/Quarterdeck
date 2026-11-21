import { NextRequest } from 'next/server'
import { getGoal, queueRun, queueRunWithRequest, getOpenRun, failRun, GoalError } from '@/lib/db'
import { ok, err, notFound, serverError, refuseIfOutdated } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/**
 * POST — "Run now": queue a run; the quarterdeck-goals plugin starts it at its next tick (within 30 s).
 * With { prompt } ("Run with a prompt…", #143) the run's brief carries the typed text as run.request,
 * trusted since the person typed it here; the daily limit or a usage hold comes back as an error.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    const body = await req.json().catch(() => ({})) as { prompt?: unknown }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) return err('The prompt is empty.', 400)
      const queued = queueRunWithRequest(id, body.prompt)
      if ('reason' in queued) return err(queued.reason, 409)
      return ok({ run: queued.run }, 202)
    }
    const run = queueRun(id)
    return ok({ run }, 202)
  } catch (e) {
    if (e instanceof GoalError) return err(e.message, 409)
    return serverError(e)
  }
}

/** DELETE — cancel the goal's run in progress. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    // Mark the run cancelled; the quarterdeck-goals plugin stops its agent at its next tick
    const open = getOpenRun(id)
    if (!open) return err('This goal has no run in progress.', 409)
    failRun(open.id, 'failed', 'Cancelled by you')
    return ok({ cancelled: true })
  } catch (e) {
    return serverError(e)
  }
}
