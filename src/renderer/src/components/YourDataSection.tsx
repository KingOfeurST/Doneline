import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useProfile } from '../profile'
import { flushPendingNotes } from '../lib/notePersistence'
import type { BackupInfo, TrashItem } from '../../../shared/api'
import Modal from './Modal'

const formatTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function YourDataSection() {
  const { queryPersonId, tick, personById } = useProfile()
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [trash, setTrash] = useState<TrashItem[]>([])
  const [showRestore, setShowRestore] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [selected, setSelected] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const working = useRef(false)
  const scope = `${queryPersonId ?? 'all'}|${tick}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  const load = useCallback(async (clearError = false) => {
    const token = ++request.current
    try {
      const [copies, removed] = await Promise.all([api.data.listBackups(), api.trash.list(queryPersonId)])
      if (token !== request.current || scope !== currentScope.current) return
      setBackups(copies)
      setTrash(removed)
      setSelected(current => copies.some(copy => copy.id === current) ? current : copies[0]?.id ?? '')
      if (clearError) setError('')
    } catch (cause) {
      if (token === request.current && scope === currentScope.current) setError(cause instanceof Error ? cause.message : 'Could not load your backups and Trash.')
    }
  }, [queryPersonId, scope])
  const latestLoad = useRef(load)
  latestLoad.current = load
  useEffect(() => {
    void load()
    const restored = () => { void latestLoad.current() }
    window.addEventListener('doneline:restored', restored)
    return () => { request.current++; window.removeEventListener('doneline:restored', restored) }
  }, [load])

  async function create() {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await flushPendingNotes()
      const copy = await api.data.createBackup()
      setNotice(`Backup saved · ${formatTime(copy.createdAt)}`)
      await latestLoad.current()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a backup.') }
    finally { working.current = false; setBusy(false) }
  }

  async function restoreBackup() {
    if (working.current || !selected || !confirmed) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await flushPendingNotes()
      await api.data.restoreBackup(selected)
      setShowRestore(false)
      setConfirmed(false)
      setNotice('Backup restored. A safety copy of your previous data was saved first.')
      window.dispatchEvent(new Event('doneline:identity'))
      window.dispatchEvent(new Event('doneline:todos'))
      window.dispatchEvent(new Event('doneline:restored'))
      await latestLoad.current()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this backup. Your current data is unchanged.') }
    finally { working.current = false; setBusy(false) }
  }

  async function restoreItem(item: TrashItem) {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await api.trash.restore(item.id)
      setNotice(`Restored “${item.title}”.`)
      window.dispatchEvent(new Event('doneline:todos'))
      window.dispatchEvent(new Event('doneline:restored'))
      await latestLoad.current()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this item. It is still in Trash.') }
    finally { working.current = false; setBusy(false) }
  }

  return <section className="card space-y-4 p-7">
    <div>
      <h2 className="text-xl font-extrabold text-ink">Your data</h2>
      <p className="mt-1 text-sm font-semibold text-slate-500">Daily backups are saved on this device for 30 days. Manual and safety backups are kept.</p>
    </div>
    <p className="text-xs font-bold text-slate-400">{backups[0] ? `Latest backup · ${formatTime(backups[0].createdAt)}` : 'No backup yet.'}</p>
    <div className="flex flex-wrap gap-3">
      <button className="btn-primary" disabled={busy} onClick={() => void create()}>{busy ? 'Working…' : 'Create backup'}</button>
      <button className="btn-soft" disabled={busy || !backups.length} onClick={() => { setConfirmed(false); setError(''); setShowRestore(true) }}>Restore backup</button>
      <button className="btn-soft" disabled={busy} onClick={() => { setError(''); setShowTrash(true); void latestLoad.current() }}>Trash ({trash.length})</button>
    </div>
    {notice && <p role="status" className="text-sm font-semibold text-mint-ink">{notice}</p>}
    {error && !showRestore && !showTrash && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}<button className="ml-2 underline" onClick={() => void latestLoad.current(true)}>Retry</button></p>}

    <Modal title="Restore backup" open={showRestore} onClose={() => { if (!working.current) setShowRestore(false) }}>
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-500">This replaces the current tasks, events, goals, notes, and app preferences for every profile. A safety backup is created first. Your active Apple Calendar connections stay; restored events reconcile when they sync.</p>
        <label className="block text-xs font-bold text-slate-500">Choose a backup
          <select className="input mt-2" value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setConfirmed(false) }}>
            {backups.map(copy => <option key={copy.id} value={copy.id}>{formatTime(copy.createdAt)} · {copy.reason === 'before-restore' ? 'Safety copy' : copy.reason === 'daily' ? 'Daily' : 'Manual'}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm font-bold text-slate-600"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Replace current data with this backup</label>
        {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
        <div className="flex justify-end gap-3"><button className="btn-soft" disabled={busy} onClick={() => setShowRestore(false)}>Cancel</button><button className="btn-primary" disabled={busy || !selected || !confirmed} onClick={() => void restoreBackup()}>{busy ? 'Restoring…' : 'Restore selected backup'}</button></div>
      </div>
    </Modal>

    <Modal title="Trash" open={showTrash} onClose={() => { if (!working.current) setShowTrash(false) }}>
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-500">Deleted tasks and events stay here for 30 days.</p>
        {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
        {trash.length === 0 ? <p className="py-5 text-center font-semibold text-slate-400">Trash is empty.</p> : <div className="space-y-3">
          {trash.map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-4">
            <div className="min-w-0"><p className="truncate font-bold text-ink">{item.title}</p><p className="mt-1 text-xs font-semibold text-slate-400">{item.kind === 'task' ? 'Task' : 'Event'} · {personById(item.person_id)?.name ?? 'Profile'} · {formatTime(item.deleted_at)}{item.item_count > 1 ? ` · ${item.item_count} items` : ''}</p></div>
            <button className="btn-soft shrink-0 py-2 text-sm" disabled={busy} onClick={() => void restoreItem(item)}>Restore</button>
          </div>)}
        </div>}
        <button className="btn-soft w-full" disabled={busy} onClick={() => setShowTrash(false)}>Close</button>
      </div>
    </Modal>
  </section>
}
