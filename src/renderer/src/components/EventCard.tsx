import type { CalEvent } from '../../../shared/api'
import { fmtTime } from '../lib/format'
import { tintFor } from '../lib/colors'

interface Props {
  event: CalEvent
  onDelete?: (id: string) => void
  onEdit?: (event: CalEvent) => void
  owner?: { emoji: string; name: string }
}

export default function EventCard({ event, onDelete, onEdit, owner }: Props) {
  const color = event.color || '#2f7a4d'
  return (
    <div
      className={`group relative rounded-xl2 border p-5 shadow-clay-sm transition duration-200 hover:-translate-y-0.5 ${
        onEdit ? 'cursor-pointer' : ''
      }`}
      style={{ background: tintFor(color), borderColor: color + '33' }}
      onClick={onEdit ? () => onEdit(event) : undefined}
      title={onEdit ? 'Edit event' : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-lg font-extrabold" style={{ color }}>
            {owner && (
              <span className="text-base" title={owner.name} aria-label={owner.name}>
                {owner.emoji}
              </span>
            )}
            {event.title}
          </h3>
          <p className="mt-0.5 text-sm font-bold" style={{ color: color + 'cc' }}>
            {event.all_day ? 'All day' : `${fmtTime(event.starts_at)} – ${fmtTime(event.ends_at)}`}
          </p>
        </div>
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(event.id)
            }}
            aria-label="Delete event"
            className="rounded-full p-1.5 opacity-0 transition hover:bg-white/60 group-hover:opacity-100"
            style={{ color }}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {event.location && (
        <p className="mt-3 whitespace-pre-line text-sm font-semibold" style={{ color: color + 'cc' }}>
          {event.location}
        </p>
      )}

      {event.attendees && (
        <p className="mt-2 text-xs font-bold" style={{ color: color + '99' }}>
          {event.attendees}
        </p>
      )}

      {event.notes && <p className="mt-3 text-sm text-slate-600">{event.notes}</p>}
    </div>
  )
}
