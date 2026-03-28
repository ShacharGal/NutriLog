import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { ChatMessage, NutritionLog } from '../lib/types'

const GRADE_COLORS: Record<string, string> = {
  A: 'bg-green-600',
  B: 'bg-blue-500',
  C: 'bg-yellow-500',
  D: 'bg-orange-500',
  F: 'bg-red-500',
}

const RESET_KEYWORDS = ['done', 'next', 'new meal']

interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  entry?: NutritionLog
}

export default function LogTab() {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [todayCal, setTodayCal] = useState(0)
  const [todayProtein, setTodayProtein] = useState(0)
  const [calTarget, setCalTarget] = useState(2400)
  const [proteinTarget, setProteinTarget] = useState(145)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load today's totals and targets on mount
  useEffect(() => {
    loadTodayTotals()
    loadTargets()
  }, [])

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadTodayTotals() {
    const today = new Date().toISOString().slice(0, 10)
    const { data } = await supabase
      .from('nutrition_log')
      .select('calories, protein_g')
      .gte('created_at', today)
    if (data) {
      setTodayCal(data.reduce((s, e) => s + (e.calories ?? 0), 0))
      setTodayProtein(data.reduce((s, e) => s + (e.protein_g ?? 0), 0))
    }
  }

  async function loadTargets() {
    const { data } = await supabase
      .from('user_settings')
      .select('daily_calorie_target, daily_protein_target')
      .eq('id', 1)
      .single()
    if (data) {
      setCalTarget(data.daily_calorie_target)
      setProteinTarget(data.daily_protein_target)
    }
  }

  function resetThread() {
    setMessages([])
    setHistory([])
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return

    // Check for reset keywords
    if (RESET_KEYWORDS.includes(text.toLowerCase())) {
      resetThread()
      setInput('')
      return
    }

    setInput('')
    setLoading(true)

    const userMsg: DisplayMessage = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])

    try {
      const res = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationHistory: history.slice(-5),
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error || res.statusText}` }])
        setLoading(false)
        return
      }

      const assistantMsg: DisplayMessage = {
        role: 'assistant',
        content: data.message,
        entry: data.logged_entry,
      }
      setMessages(prev => [...prev, assistantMsg])

      // Update conversation history (cap at 6)
      const newHistory: ChatMessage[] = [
        ...history,
        { role: 'user' as const, content: text },
        { role: 'assistant' as const, content: data.message },
      ].slice(-6)
      setHistory(newHistory)

      // If meal was logged, update today's totals and reset thread after a pause
      if (data.status === 'ready_to_log' || data.status === 'save_recurring') {
        await loadTodayTotals()
        setTimeout(() => resetThread(), 4000)
      }
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Something went wrong. Try again.' },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const calPct = Math.min((todayCal / calTarget) * 100, 100)
  const protPct = Math.min((todayProtein / proteinTarget) * 100, 100)

  return (
    <div className="flex flex-col flex-1">
      {/* Today's summary bar */}
      <div className="px-4 py-3 border-b border-slate-700 space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400 w-16">Cal</span>
          <div className="flex-1 bg-slate-700 rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all"
              style={{ width: `${calPct}%` }}
            />
          </div>
          <span className="text-xs text-slate-300 w-24 text-right">
            {todayCal} / {calTarget}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400 w-16">Protein</span>
          <div className="flex-1 bg-slate-700 rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all"
              style={{ width: `${protPct}%` }}
            />
          </div>
          <span className="text-xs text-slate-300 w-24 text-right">
            {todayProtein}g / {proteinTarget}g
          </span>
        </div>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-slate-500 text-sm text-center mt-12">
            Tell me what you ate...
          </p>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            {/* Text bubble */}
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                msg.role === 'user'
                  ? 'ml-auto bg-green-600 text-white'
                  : 'mr-auto bg-slate-700 text-slate-200'
              }`}
            >
              {msg.content}
            </div>

            {/* Confirmation card */}
            {msg.entry && <ConfirmationCard entry={msg.entry} />}
          </div>
        ))}

        {loading && (
          <div className="mr-auto bg-slate-700 rounded-2xl px-4 py-2 text-sm text-slate-400">
            <span className="animate-pulse">Thinking...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-slate-700 px-4 py-3 pb-[env(safe-area-inset-bottom)]">
        <form
          onSubmit={e => {
            e.preventDefault()
            send()
          }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="What did you eat?"
            autoFocus
            className="flex-1 bg-slate-800 border border-slate-600 rounded-full px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-green-500"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-green-600 text-white rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}

function ConfirmationCard({ entry }: { entry: NutritionLog }) {
  const grade = entry.health_grade ?? 'C'
  const color = GRADE_COLORS[grade] ?? 'bg-slate-500'

  return (
    <div className="mt-2 mr-auto bg-slate-800 border border-slate-600 rounded-xl p-3 max-w-[85%]">
      <div className="flex items-center gap-3 text-sm">
        <div className="text-center">
          <div className="text-lg font-bold text-slate-100">{entry.calories ?? '—'}</div>
          <div className="text-[10px] text-slate-400">cal</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-slate-100">{entry.protein_g ?? '—'}g</div>
          <div className="text-[10px] text-slate-400">protein</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-slate-100">{entry.fiber_g ?? '—'}g</div>
          <div className="text-[10px] text-slate-400">fiber</div>
        </div>
        <div className="text-center">
          <span className={`${color} text-white text-lg font-bold px-2.5 py-0.5 rounded`}>
            {grade}
          </span>
        </div>
      </div>
      {entry.grade_reasoning && (
        <p className="text-xs text-slate-400 mt-2">{entry.grade_reasoning}</p>
      )}
    </div>
  )
}
