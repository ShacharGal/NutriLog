import { useState } from 'react'
import LogTab from './components/LogTab'
import MealsTab from './components/MealsTab'

type Tab = 'log' | 'graphs' | 'meals' | 'settings'

function App() {
  const [tab, setTab] = useState<Tab>('log')

  return (
    <div className="flex flex-col min-h-dvh bg-slate-900 text-slate-200">
      <main className="flex-1 flex flex-col">
        {tab === 'log' && <LogTab />}
        {tab === 'graphs' && <Placeholder label="Graphs" />}
        {tab === 'meals' && <MealsTab />}
        {tab === 'settings' && <Placeholder label="Settings" />}
      </main>

      <nav className="flex justify-around border-t border-slate-700 bg-slate-900 py-3 pb-[env(safe-area-inset-bottom)]">
        {(['log', 'graphs', 'meals', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs ${
              tab === t ? 'text-green-400' : 'text-slate-400'
            }`}
          >
            {t === 'meals' ? 'My Foods' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
    </div>
  )
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-slate-500">{label} — coming soon</p>
    </div>
  )
}

export default App
