import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { WorkspaceSyncStatus } from '../../../shared/api'

export default function SyncStatus(): JSX.Element {
  const [status, setStatus] = useState<WorkspaceSyncStatus>({ state: 'local', cloud: false, pending: 0, lastSyncedAt: null })
  const revision = useRef(0)
  useEffect(() => {
    let active = true
    const read = () => {
      const current = ++revision.current
      void api.workspace.syncStatus().then((value) => { if (active && current === revision.current) setStatus(value) }).catch(() => {})
    }
    read()
    const unsubscribe = api.workspace.onSyncStatus((value) => { revision.current++; if (active) setStatus(value) })
    const changed = api.workspace.onChanged(read)
    const interval = window.setInterval(read, 3000)
    const connected = () => { if (navigator.onLine) void api.workspace.sync().catch(() => {}); read() }
    window.addEventListener('online', connected)
    window.addEventListener('offline', read)
    return () => { active = false; unsubscribe(); changed(); window.clearInterval(interval); window.removeEventListener('online', connected); window.removeEventListener('offline', read) }
  }, [])
  const offline = status.state === 'offline' || !navigator.onLine
  const text = status.state === 'syncing' ? 'Syncing…' : offline ? 'Saved locally · Offline'
    : status.state === 'synced' ? 'Synced' : status.state === 'error' ? 'Saved locally · Sync needs attention' : 'Saved locally'
  const detail = status.message ?? (status.cloud ? `${status.pending} changes waiting to sync${status.lastSyncedAt ? ` · Last sync ${new Date(status.lastSyncedAt).toLocaleString()}` : ''}` : 'Changes are saved on this computer. Connect a workspace in Settings to sync between devices.')
  return <div role="status" aria-live="polite" title={detail} className="mt-1 flex items-center gap-1.5 text-[11px] text-ink/50">
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M7 18H6a4 4 0 0 1-.8-7.92 7 7 0 0 1 13.64-1.53A4.8 4.8 0 0 1 19 18h-1"/><path d={status.state === 'synced' ? 'm9 16 2 2 4-5' : 'M12 13v7m-3-3 3 3 3-3'}/></svg>
    {text}
  </div>
}
