import { NextRequest } from 'next/server'
import { getGoal, restoreGoal } from '@/lib/db'
import { ok, err, notFound, serverError, refuseIfOutdated } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — Restores a deleted goal (#105); it comes back paused. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    try {
      return ok({ restored: restoreGoal(id).name })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 409)
    }
  } catch (e) {
    return serverError(e)
  }
}
