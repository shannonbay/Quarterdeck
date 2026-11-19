'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Restore and Delete permanently for one goal in the dashboard's "Recently deleted" section (#105). */
export function DeletedGoalActions({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function act(action: 'restore' | 'purge') {
    if (action === 'purge' && !window.confirm(`Delete "${name}" permanently? Its items, runs and memory are erased and can't be restored.`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/goals/${id}/${action}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-shrink-0 text-sm">
      {error && <span className="text-red-600">{error}</span>}
      <button disabled={busy} onClick={() => act('restore')} className="px-3 py-1 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50">
        Restore
      </button>
      <button disabled={busy} onClick={() => act('purge')} className="px-3 py-1 border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50">
        Delete permanently
      </button>
    </div>
  )
}
