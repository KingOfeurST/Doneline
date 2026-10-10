import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { SearchResults } from '../../../shared/api'
import { useProfile } from '../profile'
import { fmtDayLabel } from '../lib/format'
import { searchExcerpt, type AppTab, type SearchSelection } from '../lib/searchNavigation'

interface Props {
  open: boolean
  onClose: () => void
  onNavigate: (tab: AppTab) => void
  onFocus: () => void
  onOpenResult: (selection: SearchSelection) => void
}
interface Item { id: string; icon: string; label: string; sub?: string; action: () => void }
const EMPTY: SearchResults = { todos: [], events: [], goals: [], notes: [] }

export default function CommandPalette({ open, onClose, onNavigate, onFocus, onOpenResult }: Props) {
  const { queryPersonId, personById, tick } = useProfile()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const q = query.trim()
  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); inputRef.current?.focus() }
  }, [open])
  useEffect(() => {
    const token = ++request.current
    setResults(EMPTY)
    setSelected(0)
    setError('')
    setLoading(open && !!q)
    if (!open || !q) return
    const timer = setTimeout(() => {
      api.search.query({ query: q, personId: queryPersonId, limit: 20 }).then((loaded) => {
        if (token === request.current) setResults(loaded)
      }).catch((cause) => {
        if (token === request.current) setError(cause instanceof Error ? cause.message : 'Could not search. Please try again.')
      }).finally(() => { if (token === request.current) setLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); request.current++ }
  }, [open, q, queryPersonId, tick])
  useEffect(() => {
    if (open) document.getElementById('search-option-' + selected)?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])
  if (!open) return null
  const choose = (selection: SearchSelection) => { onOpenResult(selection); onClose() }
  const owner = (id: string) => personById(id)?.name || 'Profile'
  const context = (id: string, date?: string | null) => [date ? fmtDayLabel(date) : 'No date', owner(id)].join(' · ')
  const nav: Item[] = [
    { id: 'nav:today', icon: '☀️', label: 'Go to Today', action: () => { onNavigate('today'); onClose() } },
    { id: 'nav:calendar', icon: '📆', label: 'Go to Calendar', action: () => { onNavigate('calendar'); onClose() } },
    { id: 'nav:goals', icon: '🎯', label: 'Go to Goals', action: () => { onNavigate('goals'); onClose() } },
    { id: 'nav:settings', icon: '⚙️', label: 'Go to Settings', action: () => { onNavigate('settings'); onClose() } },
    { id: 'nav:focus', icon: '⏱️', label: 'Start Focus Session', action: () => { onFocus(); onClose() } }
  ]
  const groups: { label: string; items: Item[] }[] = [
    { label: 'Tasks', items: results.todos.map((item) => ({ id: 'todo:' + item.id, icon: '✅', label: item.title, sub: [context(item.person_id, item.due_at), item.goal_title, item.completed_at ? 'Finished' : ''].filter(Boolean).join(' · '), action: () => choose({ kind: 'todo', item }) })) },
    { label: 'Events', items: results.events.map((item) => ({ id: 'event:' + item.id, icon: '📆', label: item.title, sub: [context(item.person_id, item.starts_at), item.location?.split('\n')[0]].filter(Boolean).join(' · '), action: () => choose({ kind: 'event', item }) })) },
    { label: 'Goals', items: results.goals.map((item) => ({ id: 'goal:' + item.id, icon: '🎯', label: item.title, sub: owner(item.person_id) + ' · ' + item.todo_done + '/' + item.todo_total + ' done' + (item.archived ? ' · Archived' : ''), action: () => choose({ kind: 'goal', item }) })) },
    { label: 'Notes', items: results.notes.map((item) => ({ id: 'note:' + item.day + ':' + item.person_id, icon: '📝', label: context(item.person_id, item.day), sub: searchExcerpt(item.body, q), action: () => choose({ kind: 'note', item }) })) },
    { label: 'Navigate', items: q ? nav.filter((item) => item.label.toLocaleLowerCase().includes(q.toLocaleLowerCase())) : nav }
  ].filter((group) => group.items.length)
  const allItems = groups.flatMap((group) => group.items)
  const selectedIndex = Math.min(selected, Math.max(0, allItems.length - 1))
  function handleKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((value) => Math.max(0, Math.min(value + (event.key === 'ArrowDown' ? 1 : -1), allItems.length - 1)))
    } else if (event.key === 'Enter') { event.preventDefault(); allItems[selectedIndex]?.action() }
    else if (event.key === 'Escape') onClose()
  }
  let offset = 0
  return <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24 sm:pt-32" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="pointer-events-none absolute inset-0 bg-black/20 backdrop-blur-sm" />
    <div role="dialog" aria-modal="true" aria-label="Search Doneline" className="relative z-10 w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl">
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="9" r="6" /><path d="M15 15l3 3" strokeLinecap="round" /></svg>
        <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0) }} onKeyDown={handleKey} placeholder="Search tasks, events, goals, notes…" aria-label="Search tasks, events, goals, notes" role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={allItems.length ? 'search-option-' + selectedIndex : undefined} className="min-w-0 flex-1 bg-transparent text-base font-semibold text-ink placeholder-slate-400 outline-none" />
        <button onClick={onClose} aria-label="Close search" className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-400">ESC</button>
      </div>
      <p className="px-5 pt-3 text-xs font-bold text-slate-400">{queryPersonId ? 'Searching ' + owner(queryPersonId) + ' and shared items' : 'Searching all profiles'}</p>
      <div id="search-results" role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto py-2">
        {groups.map((group) => {
          const start = offset
          offset += group.items.length
          return <div key={group.label} role="group" aria-label={group.label}>
            <p className="px-5 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">{group.label}{q && group.label !== 'Navigate' ? ' (' + group.items.length + ')' : ''}</p>
            {group.items.map((item, index) => <PaletteItem key={item.id} item={item} index={start + index} selected={selectedIndex === start + index} onHover={() => setSelected(start + index)} />)}
          </div>
        })}
        {loading && <p role="status" className="px-5 py-5 text-center text-sm font-semibold text-slate-400">Searching…</p>}
        {error && <p role="alert" className="px-5 py-5 text-center text-sm font-semibold text-rose-ink">{error}</p>}
        {!loading && !error && !allItems.length && <p className="px-5 py-8 text-center font-semibold text-slate-400">No results</p>}
      </div>
    </div>
  </div>
}
function PaletteItem({ item, selected, onHover, index }: { item: Item; selected: boolean; onHover: () => void; index: number }) {
  return <button id={'search-option-' + index} role="option" aria-selected={selected} className={'flex w-full items-center gap-3 px-5 py-3 text-left transition ' + (selected ? 'bg-mint-card' : 'hover:bg-slate-50')} onClick={item.action} onMouseEnter={onHover}>
    <span className="text-xl">{item.icon}</span>
    <div className="min-w-0 flex-1"><p className={'truncate font-bold ' + (selected ? 'text-mint-ink' : 'text-ink')}>{item.label}</p>{item.sub && <p className="truncate text-xs font-semibold text-slate-400">{item.sub}</p>}</div>
    {selected && <kbd className="rounded-lg bg-mint-ink/10 px-2 py-1 text-xs font-bold text-mint-ink">Enter</kbd>}
  </button>
}
