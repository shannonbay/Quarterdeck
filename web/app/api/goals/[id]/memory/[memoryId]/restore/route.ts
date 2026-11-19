import { NextRequest } from 'next/server'
import { getMemory, restoreMemory } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, notFound, serverError, refuseIfOutdated } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; memoryId: string }> }

/**
 * POST — brings back a memory that was forgotten, merged, retired or rewritten (#105).
 * A newer memory that merged or reworded it stays: the person decides which to keep.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const stale = refuseIfOutdated()
    if (stale) return stale
    const { id, memoryId } = await params
    const m = getMemory(memoryId)
    if (!m || m.plan_id !== id) return notFound('Memory')
    const memory = restoreMemory(memoryId)
    recordEvent({ planId: id, taskId: id, eventType: 'memory_restored', actor: 'human', payload: { memory_id: memoryId, reason: m.inactive_reason ?? null } })
    return ok({ memory })
  } catch (e) {
    return serverError(e)
  }
}
