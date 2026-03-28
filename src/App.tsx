import { useState } from 'react'

type Tab = 'log' | 'graphs' | 'meals' | 'settings'

function App() {
  const [_tab, setTab] = useState<Tab>('log')

  return (
    <div className="flex flex-col min-h-dvh bg-slate-900 text-slate-200">
      {/* Content area — placeholder until tabs are built */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-green-500 mb-2">NutriLog</h1>
          <p className="text-slate-400">AI-powered nutrition tracker</p>
        </div>
      </main>

      {/* Bottom nav */}
      <nav className="flex justify-around border-t border-slate-700 bg-slate-900 py-3 pb-[env(safe-area-inset-bottom)]">
        {(['log', 'graphs', 'meals', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="text-xs text-slate-400 hover:text-green-400 capitalize"
          >
            {t}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
