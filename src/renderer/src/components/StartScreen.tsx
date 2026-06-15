import { useEffect, useState } from 'react'

interface Props {
  onDone: () => void
}

/** Brief welcome splash shown on launch. Auto-dismisses, or click to skip. */
export default function StartScreen({ onDone }: Props) {
  const [leaving, setLeaving] = useState(false)

  function dismiss() {
    if (leaving) return
    setLeaving(true)
    setTimeout(onDone, 500) // match the fade-out duration
  }

  useEffect(() => {
    const t = setTimeout(dismiss, 2200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      onClick={dismiss}
      className={`fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center transition-opacity duration-500 ${
        leaving ? 'opacity-0' : 'opacity-100'
      }`}
      style={{
        background:
          'radial-gradient(900px 600px at 20% 10%, #c7f0d8 0%, transparent 55%), radial-gradient(900px 600px at 100% 20%, #cdeefb 0%, transparent 55%), linear-gradient(180deg, #dcf0fb 0%, #e3f6ec 100%)'
      }}
    >
      <div className="animate-[hello_700ms_ease-out] text-center">
        <p className="font-brand text-7xl text-mint-ink drop-shadow-sm">Hello</p>
        <p className="mt-4 text-lg font-bold text-slate-500">Welcome to Doneline</p>
      </div>
      <p className="absolute bottom-10 text-sm font-semibold text-slate-400">click to continue</p>

      <style>{`
        @keyframes hello {
          0% { opacity: 0; transform: translateY(14px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  )
}
