import { useState } from 'react'
import TodayView from './views/TodayView'
import CalendarView from './views/CalendarView'
import GoalsView from './views/GoalsView'
import SettingsView from './views/SettingsView'
import StartScreen from './components/StartScreen'
import ProfileSwitcher from './components/ProfileSwitcher'
import FocusButton from './components/FocusButton'
import FocusOverlay from './components/FocusOverlay'
import { ProfileProvider } from './profile'
import { FocusProvider } from './focus'

type Tab = 'today' | 'calendar' | 'goals' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'goals', label: 'Goals' },
  { id: 'settings', label: 'Settings' }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [started, setStarted] = useState(false)

  if (!started) return <StartScreen onDone={() => setStarted(true)} />

  return (
    <ProfileProvider>
      <FocusProvider>
      <div className="relative min-h-full">
        {/* decorative background blobs */}
        <div className="blob" style={{ width: 220, height: 220, background: '#bdeccf', top: 80, left: -60 }} />
        <div className="blob" style={{ width: 260, height: 260, background: '#bfe5f7', bottom: 60, right: -70 }} />
        <div className="blob" style={{ width: 160, height: 160, background: '#d9c8f0', bottom: 220, left: 40 }} />

        <div className="relative z-10 mx-auto flex min-h-full max-w-5xl flex-col px-6 pb-16">
          <header className="flex items-center justify-between gap-3 py-6">
            <span className="select-none font-brand text-3xl text-mint-ink/80">Doneline</span>
            <nav className="flex items-center gap-1 rounded-full bg-white/70 p-1 shadow-clay-sm backdrop-blur">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                    tab === t.id ? 'bg-mint-ink text-white shadow-clay-sm' : 'text-slate-500 hover:text-ink'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              <FocusButton />
              <ProfileSwitcher />
            </div>
          </header>

          <main className="flex-1">
            {tab === 'today' && <TodayView />}
            {tab === 'calendar' && <CalendarView />}
            {tab === 'goals' && <GoalsView />}
            {tab === 'settings' && <SettingsView />}
          </main>
        </div>

        <FocusOverlay />
      </div>
      </FocusProvider>
    </ProfileProvider>
  )
}
