import { NextRequest } from 'next/server'
import { getGoal, purgeGoal } from '@/lib/db'
import { ok, err, notFound, serverError, refuseIfOutdated } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — Erases a deleted goal for good (#105), with its items, runs and memory. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    if (!getGoal(id)?.deleted_at) return err('Delete the goal first: only a deleted goal can be deleted permanently.')
    try {
      return ok({ purged: purgeGoal(id).name })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 409)
    }
  } catch (e) {
    return serverError(e)
  }
}
