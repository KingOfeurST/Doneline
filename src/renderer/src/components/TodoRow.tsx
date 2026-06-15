import type { TodoWithGoal } from '../../../shared/api'
import { fmtTime } from '../lib/format'

interface Props {
  todo: TodoWithGoal
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  showOwner?: boolean
}

export default function TodoRow({ todo, onToggle, onDelete, showOwner }: Props) {
  const done = todo.completed_at !== null
  return (
    <div className="group flex items-center gap-3 border-b border-slate-100 py-3 last:border-0">
      {showOwner && (
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm"
          title={todo.person_name ?? ''}
          aria-label={todo.person_name ?? ''}
        >
          {todo.person_emoji ?? '🙂'}
        </span>
      )}
      <button
        onClick={() => onToggle(todo.id)}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition ${
          done ? 'border-mint-ink bg-mint-ink text-white' : 'border-slate-300 hover:border-mint-ink'
        }`}
      >
        {done && (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className={`truncate font-bold ${done ? 'text-slate-400 line-through' : 'text-ink'}`}>
          {todo.title}
        </p>
      </div>

      {todo.goal_title && (
        <span
          className="hidden shrink-0 rounded-full px-3 py-1 text-xs font-bold sm:inline"
          style={{ background: (todo.goal_color || '#2f7a4d') + '22', color: todo.goal_color || '#2f7a4d' }}
        >
          {todo.goal_title}
        </span>
      )}

      <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-400">
        {done ? fmtTime(todo.completed_at) : todo.due_at ? fmtTime(todo.due_at) : 'not yet'}
      </span>

      <button
        onClick={() => onDelete(todo.id)}
        aria-label="Delete"
        className="shrink-0 rounded-full p-1.5 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-ink group-hover:opacity-100"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
