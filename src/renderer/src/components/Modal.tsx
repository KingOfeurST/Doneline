import { type ReactNode, useEffect } from 'react'

interface Props {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
}

export default function Modal({ title, open, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/25 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      <div
        className="card w-full max-w-md p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-2xl font-extrabold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}
