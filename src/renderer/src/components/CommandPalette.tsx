import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'

type Tab = 'today' | 'calendar' | 'goals' | 'activity' | 'settings'

interface Props {
  open: boolean
  onClose: () => void
  onNavigate: (tab: Tab) => void
  onFocus: () => void
}

interface Item {
  id: string
  icon: string
  label: string
  sub?: string
  action: () => void
}

export default function CommandPalette({ open, onClose, onNavigate, onFocus }: Props) {
  const { queryPersonId } = useProfile()
  const [query, setQuery] = useState('')
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 30)
      api.todos.list({ personId: queryPersonId }).then(setTodos)
    }
  }, [open, queryPersonId])

  if (!open) return null

  const q = query.toLowerCase().trim()

  const navItems: Item[] = [
    { id: 'today', icon: '📅', label: 'Go to Today', action: () => { onNavigate('today'); onClose() } },
    { id: 'calendar', icon: '📆', label: 'Go to Calendar', action: () => { onNavigate('calendar'); onClose() } },
    { id: 'goals', icon: '🎯', label: 'Go to Goals', action: () => { onNavigate('goals'); onClose() } },
    { id: 'activity', icon: '📋', label: 'Go to Activity', action: () => { onNavigate('activity'); onClose() } },
    { id: 'settings', icon: '⚙️', label: 'Go to Settings', action: () => { onNavigate('settings'); onClose() } },
    { id: 'focus', icon: '🎯', label: 'Start Focus Session', action: () => { onFocus(); onClose() } }
  ]

  const filteredNav = q ? navItems.filter((i) => i.label.toLowerCase().includes(q)) : navItems

  const todoItems: Item[] = todos
    .filter((t) => !t.completed_at && (!q || t.title.toLowerCase().includes(q)))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      icon: '✅',
      label: t.title,
      sub: t.goal_title ?? undefined,
      action: () => { onNavigate('today'); onClose() }
    }))

  const allItems: Item[] = [
    ...filteredNav,
    ...(todoItems.length > 0 ? todoItems : [])
  ]

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      allItems[selected]?.action()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="pointer-events-none absolute inset-0 bg-black/20 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="9" r="6" /><path d="M15 15l3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={handleKey}
            placeholder="Jump anywhere, search todos…"
            className="min-w-0 flex-1 bg-transparent text-base font-semibold text-ink placeholder-slate-400 outline-none"
          />
          <kbd className="hidden rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-400 sm:inline">
            ESC
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto py-2">
          {filteredNav.length > 0 && (
            <div>
              {!q && (
                <p className="px-5 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                  Navigate
                </p>
              )}
              {filteredNav.map((item, idx) => (
                <PaletteItem
                  key={item.id}
                  item={item}
                  selected={allItems[selected]?.id === item.id}
                  onHover={() => setSelected(idx)}
                />
              ))}
            </div>
          )}

          {todoItems.length > 0 && (
            <div>
              <p className="mt-2 px-5 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                Todos
              </p>
              {todoItems.map((item, idx) => (
                <PaletteItem
                  key={item.id}
                  item={item}
                  selected={allItems[selected]?.id === item.id}
                  onHover={() => setSelected(filteredNav.length + idx)}
                />
              ))}
            </div>
          )}

          {allItems.length === 0 && (
            <p className="px-5 py-8 text-center font-semibold text-slate-400">No results</p>
          )}
        </div>
      </div>
    </div>
  )
}

function PaletteItem({ item, selected, onHover }: { item: Item; selected: boolean; onHover: () => void }) {
  return (
    <button
      className={`flex w-full items-center gap-3 px-5 py-3 text-left transition ${
        selected ? 'bg-mint-card' : 'hover:bg-slate-50'
      }`}
      onClick={item.action}
      onMouseEnter={onHover}
    >
      <span className="text-xl">{item.icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`font-bold truncate ${selected ? 'text-mint-ink' : 'text-ink'}`}>{item.label}</p>
        {item.sub && <p className="text-xs font-semibold text-slate-400 truncate">{item.sub}</p>}
      </div>
      {selected && (
        <kbd className="rounded-lg bg-mint-ink/10 px-2 py-1 text-xs font-bold text-mint-ink">
          Enter
        </kbd>
      )}
    </button>
  )
}
