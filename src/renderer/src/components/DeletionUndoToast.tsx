import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DeletedItems } from '../lib/deletionUndo'

export default function DeletionUndoToast() {
  const [items, setItems] = useState<DeletedItems | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef<DeletedItems | null>(null)
  const pending = useRef(false)
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function deleted(event: Event) {
      const next = (event as CustomEvent<DeletedItems>).detail
      if (!Array.isArray(next?.trashIds) || !next.trashIds.length) return
      // Rapid deletions can all be recovered by one undo, without losing an earlier toast.
      const combined = { trashIds: [...new Set([...(latest.current?.trashIds ?? []), ...next.trashIds])], label: next.label }
      latest.current = combined
      setItems(combined)
      setError('')
      if (expiry.current) clearTimeout(expiry.current)
      expiry.current = setTimeout(() => {
        if (pending.current) return
        latest.current = null
        setItems(null)
      }, 8000)
    }
    window.addEventListener('doneline:deleted', deleted)
    return () => { window.removeEventListener('doneline:deleted', deleted); if (expiry.current) clearTimeout(expiry.current) }
  }, [])

  async function undo() {
    const current = latest.current
    if (!current || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    if (expiry.current) clearTimeout(expiry.current)
    try {
      // Keep any still-failed IDs available for retry after a partial failure.
      const failures: string[] = []
      for (const id of current.trashIds) {
        try {
          await api.trash.restore(id)
          if (latest.current) latest.current = { ...latest.current, trashIds: latest.current.trashIds.filter(value => value !== id) }
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : 'Could not restore. Your item is still in Trash.')
        }
      }
      window.dispatchEvent(new Event('doneline:todos'))
      window.dispatchEvent(new Event('doneline:restored'))
      if (latest.current?.trashIds.length) setItems(latest.current)
      else { latest.current = null; setItems(null) }
      if (failures.length) setError(failures[0])
    } catch (cause) {
      setItems(latest.current)
      setError(cause instanceof Error ? cause.message : 'Could not restore. Your item is still in Trash.')
      window.dispatchEvent(new Event('doneline:todos'))
      window.dispatchEvent(new Event('doneline:restored'))
    } finally { pending.current = false; setBusy(false) }
  }

  if (!items) return null
  return <div role="status" className="fixed bottom-6 left-1/2 z-[70] w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl bg-white px-5 py-4 shadow-clay">
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm font-bold text-ink">{items.trashIds.length > 1 ? `${items.trashIds.length} items moved to Trash` : items.label}</p>
      <button className="font-extrabold text-mint-ink underline disabled:opacity-50" disabled={busy} onClick={() => void undo()}>{busy ? 'Restoring…' : 'Undo'}</button>
      <button aria-label="Dismiss undo" className="text-slate-400" disabled={busy} onClick={() => { latest.current = null; setItems(null) }}>×</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs font-semibold text-rose-ink">{error}</p>}
  </div>
}
