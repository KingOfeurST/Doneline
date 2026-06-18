import { useEffect, useRef, useState } from 'react'
import * as chrono from 'chrono-node'
import { api } from '../api'
import { useProfile } from '../profile'
import { fmtDayLabel, fmtTime } from '../lib/format'

interface Props {
  onCreated: () => void
}

/**
 * Natural-language todo capture: "gym tomorrow 9am" → a todo titled "gym" due
 * tomorrow at 09:00. Parses the date phrase out of the title with chrono-node.
 */
export default function QuickAdd({ onCreated }: Props) {
  const { defaultOwnerId } = useProfile()
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Let the tray "New todo" action focus this input.
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('doneline:quickadd', focus)
    return () => window.removeEventListener('doneline:quickadd', focus)
  }, [])

  const parsed = chrono.parse(text)[0]
  const due = parsed ? parsed.start.date() : null
  const title = parsed ? text.replace(parsed.text, '').replace(/\s{2,}/g, ' ').trim() : text.trim()

  async function submit() {
    if (!title) return
    await api.todos.create({
      title,
      person_id: defaultOwnerId,
      due_at: due ? due.toISOString() : null
    })
    setText('')
    onCreated()
  }

  return (
    <div className="mb-1">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          className="input"
          placeholder="Quick add — e.g. “gym tomorrow 9am”"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="btn-primary px-4" onClick={submit} disabled={!title}>
          Add
        </button>
      </div>
      {due && (
        <p className="mt-1 px-1 text-xs font-semibold text-mint-ink">
          “{title}” · {fmtDayLabel(due.toISOString())} {fmtTime(due.toISOString())}
        </p>
      )}
    </div>
  )
}
