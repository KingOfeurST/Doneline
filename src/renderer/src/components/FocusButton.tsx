import { useFocus, formatClock } from '../focus'

export default function FocusButton() {
  const { open, setOpen, isRunning, secondsLeft, phase } = useFocus()
  const active = isRunning
  const tint = phase === 'focus' ? '#2f7a4d' : '#2f6f9c'

  return (
    <button
      onClick={() => setOpen(!open)}
      title="Focus mode"
      className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-3.5 text-sm font-bold shadow-clay-sm backdrop-blur transition"
      style={
        active
          ? { background: tint, color: 'white' }
          : { background: 'rgba(255,255,255,0.7)', color: '#1f2933' }
      }
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="13" r="7.5" />
        <path d="M12 13V9.5M12 2.5h0M9.5 2.5h5" strokeLinecap="round" />
      </svg>
      {active ? <span className="tabular-nums">{formatClock(secondsLeft)}</span> : <span>Focus</span>}
    </button>
  )
}
