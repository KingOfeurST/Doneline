import { useEffect, useMemo, useRef, useState } from 'react'
import type { UnassignedNoteSummary } from '../../../shared/api'
import { api } from '../api'
import { useProfile } from '../profile'

function noteKey(note: UnassignedNoteSummary): string {
  return JSON.stringify([note.day, note.person_id])
}

function dateLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Keep notes whose original profiles are gone discoverable without changing them. */
export default function OlderProfileNotes() {
  const { tick } = useProfile()
  const [notes, setNotes] = useState<UnassignedNoteSummary[]>([])
  const [listError, setListError] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [readRevision, setReadRevision] = useState(0)
  const [content, setContent] = useState({ key: '', body: '', loading: false, error: '' })
  const [copyMessage, setCopyMessage] = useState('')
  const copyRequest = useRef(0)
  const profileLabels = useMemo(() => new Map([...new Set(notes.map(note => note.person_id))].sort()
    .map((personId, index) => [personId, `Previous profile ${index + 1}`])), [notes])
  const selected = notes.find(note => noteKey(note) === selectedKey)
  const selectedDay = selected?.day
  const selectedPersonId = selected?.person_id

  // This list deliberately ignores the selected current profile. An old profile
  // cannot be selected in the switcher, but its saved notes must remain visible.
  useEffect(() => {
    let cancelled = false
    void api.notes.unassigned(1000).then(loaded => {
      if (cancelled) return
      setNotes([...loaded].sort((left, right) => right.day.localeCompare(left.day) || left.person_id.localeCompare(right.person_id)))
      setSelectedKey(current => loaded.some(note => noteKey(note) === current) ? current : null)
      setListError('')
    }).catch(() => {
      if (!cancelled) setListError('Could not load notes from older profiles.')
    })
    return () => { cancelled = true }
  }, [tick])

  useEffect(() => {
    let cancelled = false
    copyRequest.current++
    setCopyMessage('')
    if (!selectedDay || !selectedPersonId) {
      setContent({ key: '', body: '', loading: false, error: '' })
      return () => { cancelled = true; copyRequest.current++ }
    }
    const key = JSON.stringify([selectedDay, selectedPersonId])
    setContent({ key, body: '', loading: true, error: '' })
    void api.notes.get(selectedDay, selectedPersonId).then(note => {
      if (!cancelled) setContent({ key, body: note.body, loading: false, error: '' })
    }).catch(() => {
      if (!cancelled) setContent({ key, body: '', loading: false, error: 'Could not load this note. Choose it again to retry.' })
    })
    return () => { cancelled = true; copyRequest.current++ }
  }, [selectedDay, selectedPersonId, tick, readRevision])

  const visibleContent = selectedKey === content.key ? content : { body: '', loading: true, error: '' }
  async function copyNote() {
    const request = ++copyRequest.current
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(visibleContent.body)
      if (request === copyRequest.current) setCopyMessage('Copied')
    } catch {
      if (request === copyRequest.current) setCopyMessage('Could not copy. Select the note text and copy it.')
    }
  }

  if (!notes.length && !listError) return null

  return (
    <details className="group rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 shadow-clay-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-extrabold text-amber-950">
        <span>Notes from older profiles{notes.length ? ` (${notes.length})` : ''}</span>
        <span aria-hidden="true" className="text-lg transition group-open:rotate-180">⌄</span>
      </summary>
      <p className="mt-2 text-xs font-semibold leading-5 text-amber-950/65">Read saved notes from profiles no longer listed above. The originals are preserved.</p>
      {listError ? <p role="status" className="mt-2 text-xs font-semibold text-rose-ink">{listError}</p> : null}
      <ul aria-label="Older profile note dates" className="mt-3 max-h-48 space-y-1 overflow-y-auto">
        {notes.map(note => {
          const key = noteKey(note)
          return <li key={key}>
            <button type="button" aria-pressed={selectedKey === key} onClick={() => { setSelectedKey(key); setReadRevision(current => current + 1) }}
              className={`w-full rounded-xl px-3 py-2 text-left transition ${selectedKey === key ? 'bg-white shadow-clay-sm' : 'hover:bg-white/70'}`}>
              <span className="block text-sm font-bold text-amber-950">{dateLabel(note.day)}</span>
              <span className="block text-xs font-semibold text-amber-950/60">{profileLabels.get(note.person_id)} · {note.body_length} characters</span>
            </button>
          </li>
        })}
      </ul>
      {selected ? <div className="mt-3 border-t border-amber-200/70 pt-3">
        <p className="text-xs font-bold text-amber-950">{dateLabel(selected.day)} · {profileLabels.get(selected.person_id)} · Read only</p>
        <p className="mt-1 text-xs font-semibold text-amber-950/60">Kept from a profile that is no longer listed.</p>
        {visibleContent.loading ? <p role="status" className="mt-3 text-xs font-semibold text-amber-950/60">Loading note…</p> : visibleContent.error ? (
          <p role="alert" className="mt-3 text-xs font-semibold text-rose-ink">{visibleContent.error}</p>
        ) : (
          <textarea aria-label="Older profile note" readOnly value={visibleContent.body}
            className="mt-3 min-h-[168px] w-full resize-y rounded-xl border border-amber-200/70 bg-white/70 px-3 py-2 text-sm leading-6 text-amber-950 outline-none" />
        )}
        <button type="button" aria-label="Copy older profile note" onClick={() => { void copyNote() }} disabled={visibleContent.loading || !!visibleContent.error}
          className="mt-2 text-xs font-bold text-mint-ink hover:underline disabled:opacity-40">Copy note</button>
        {copyMessage ? <p role="status" className="mt-2 text-xs font-semibold text-amber-950/65">{copyMessage}</p> : null}
      </div> : notes.length ? <p className="mt-3 text-xs font-semibold text-amber-950/65">Choose a date to read its note.</p> : null}
    </details>
  )
}
