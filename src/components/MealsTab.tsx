import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { MyFood } from '../lib/types'

interface FoodChatMessage {
  role: 'user' | 'assistant'
  content: string
  food?: {
    name: string
    nutrients_per_100g: { calories: number; protein: number; carbs: number; fat: number; fiber: number }
    ingredients: { name: string; weight_g: number }[] | null
    total_weight_g: number | null
    totals: { calories: number; protein: number; carbs: number; fat: number; fiber: number } | null
    source: string
  }
}

export default function MealsTab() {
  const [foods, setFoods] = useState<MyFood[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const [messages, setMessages] = useState<FoodChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadFoods() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function loadFoods() {
    console.log('[MyFoods] Loading')
    const { data, error } = await supabase
      .from('my_foods')
      .select('*')
      .order('name', { ascending: true })
    if (error) console.error('[MyFoods] Load error:', error)
    setFoods(data ?? [])
    setLoading(false)
  }

  async function deleteFood(id: string) {
    console.log('[MyFoods] Deleting:', id)
    const { error } = await supabase.from('my_foods').delete().eq('id', id)
    if (error) {
      console.error('[MyFoods] Delete error:', error)
      return
    }
    setFoods(prev => prev.filter(f => f.id !== id))
    setDeleteId(null)
  }

  async function send() {
    const text = input.trim()
    if (!text || sending) return

    setInput('')
    setSending(true)

    setMessages(prev => [...prev, { role: 'user', content: text }])

    try {
      const res = await fetch('/api/save-food', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error || res.statusText}` }])
        return
      }

      if (data.status === 'needs_clarification') {
        setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
        return
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message,
        food: data.food,
      }])

      if (data.food) {
        await loadFoods()
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Try again.' }])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="flex flex-col flex-1">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <p className="text-slate-400 animate-pulse text-center">Loading foods...</p>
        ) : foods.length === 0 && messages.length === 0 ? (
          <p className="text-slate-500 text-sm text-center mt-12 px-6">
            Add foods and recipes you make often — the more specific, the better your future logs will be.
          </p>
        ) : null}

        {/* Food list */}
        {foods.map(food => {
          const n = food.nutrients_per_100g
          const isComposite = food.source === 'homemade'
          const isExpanded = expandedId === food.id
          const isDeleting = deleteId === food.id
          const ingredients = food.ingredients_json as { name: string; weight_g: number }[] | null

          // Calculate display totals for composite
          const totalWeight = food.total_weight_g ?? 100
          const displayCal = isComposite ? Math.round(n.calories * totalWeight / 100) : n.calories
          const displayProtein = isComposite ? Math.round(n.protein * totalWeight / 100 * 10) / 10 : n.protein

          return (
            <div key={food.id} className="bg-slate-800 border border-slate-600 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : food.id)}
                className="w-full px-4 py-3 flex items-center justify-between text-left"
              >
                <div className="flex items-center gap-2 truncate mr-3">
                  <span className="font-medium text-slate-100 text-sm truncate capitalize">
                    {food.name}
                  </span>
                  {isComposite && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900 text-amber-300 shrink-0">
                      homemade
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                  <span>{displayCal} cal</span>
                  <span>{displayProtein}g P</span>
                  <svg
                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-slate-700">
                  <p className="text-[10px] text-slate-500 pt-2">
                    {isComposite ? `per serving (${totalWeight}g)` : 'per 100g'}
                  </p>
                  <div className="grid grid-cols-5 gap-2">
                    <MacroBox label="cal" value={isComposite ? Math.round(n.calories * totalWeight / 100) : n.calories} />
                    <MacroBox label="protein" value={isComposite ? Math.round(n.protein * totalWeight / 100 * 10) / 10 : n.protein} unit="g" />
                    <MacroBox label="carbs" value={isComposite ? Math.round(n.carbs * totalWeight / 100 * 10) / 10 : n.carbs} unit="g" />
                    <MacroBox label="fat" value={isComposite ? Math.round(n.fat * totalWeight / 100 * 10) / 10 : n.fat} unit="g" />
                    <MacroBox label="fiber" value={isComposite ? Math.round(n.fiber * totalWeight / 100 * 10) / 10 : n.fiber} unit="g" />
                  </div>

                  {ingredients && ingredients.length > 0 && (
                    <div>
                      <p className="text-xs text-slate-400 mb-1">Ingredients</p>
                      <ul className="text-sm text-slate-300 space-y-0.5">
                        {ingredients.map((ing, i) => (
                          <li key={i}>{ing.name} — {ing.weight_g}g</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                      food.source === 'usda' ? 'bg-blue-900 text-blue-300'
                        : food.source === 'homemade' ? 'bg-amber-900 text-amber-300'
                        : 'bg-purple-900 text-purple-300'
                    }`}>
                      {food.source}
                    </span>
                  </div>

                  {isDeleting ? (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs text-red-400">Delete "{food.name}"?</span>
                      <button
                        onClick={() => deleteFood(food.id)}
                        className="text-xs bg-red-600 text-white rounded-full px-3 py-1"
                      >
                        Yes, delete
                      </button>
                      <button
                        onClick={() => setDeleteId(null)}
                        className="text-xs text-slate-400 border border-slate-600 rounded-full px-3 py-1"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteId(food.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Chat messages */}
        {messages.map((msg, i) => (
          <div key={`msg-${i}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                msg.role === 'user'
                  ? 'ml-auto bg-green-600 text-white'
                  : 'mr-auto bg-slate-700 text-slate-200'
              }`}
            >
              {msg.content}
            </div>

            {msg.food && (
              <div className="mt-2 mr-auto bg-slate-800 border border-slate-600 rounded-xl p-3 max-w-[85%]">
                <div className="text-xs text-slate-300 mb-2 capitalize font-medium">{msg.food.name}</div>

                {msg.food.totals ? (
                  <>
                    <p className="text-[10px] text-slate-500 mb-1">per serving ({msg.food.total_weight_g}g)</p>
                    <div className="grid grid-cols-4 gap-2 mb-2">
                      <MacroBox label="cal" value={msg.food.totals.calories} />
                      <MacroBox label="protein" value={msg.food.totals.protein} unit="g" />
                      <MacroBox label="carbs" value={msg.food.totals.carbs} unit="g" />
                      <MacroBox label="fat" value={msg.food.totals.fat} unit="g" />
                    </div>
                    {msg.food.ingredients && (
                      <div>
                        <p className="text-[10px] text-slate-500 mb-1">Ingredients</p>
                        <ul className="text-xs text-slate-400 space-y-0.5">
                          {msg.food.ingredients.map((ing, j) => (
                            <li key={j}>{ing.name} — {ing.weight_g}g</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-[10px] text-slate-500 mb-1">per 100g</p>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="text-center">
                        <div className="text-base font-bold text-slate-100">{msg.food.nutrients_per_100g.calories}</div>
                        <div className="text-[10px] text-slate-400">cal</div>
                      </div>
                      <div className="text-center">
                        <div className="text-base font-bold text-slate-100">{msg.food.nutrients_per_100g.protein}g</div>
                        <div className="text-[10px] text-slate-400">protein</div>
                      </div>
                      <div className="text-center">
                        <div className="text-base font-bold text-slate-100">{msg.food.nutrients_per_100g.carbs}g</div>
                        <div className="text-[10px] text-slate-400">carbs</div>
                      </div>
                      <div className="text-center">
                        <div className="text-base font-bold text-slate-100">{msg.food.nutrients_per_100g.fat}g</div>
                        <div className="text-[10px] text-slate-400">fat</div>
                      </div>
                    </div>
                  </>
                )}
                <span className={`inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full ${
                  msg.food.source === 'usda' ? 'bg-blue-900 text-blue-300'
                    : msg.food.source === 'homemade' ? 'bg-amber-900 text-amber-300'
                    : 'bg-purple-900 text-purple-300'
                }`}>
                  {msg.food.source}
                </span>
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="mr-auto bg-slate-700 rounded-2xl px-4 py-2 text-sm text-slate-400">
            <span className="animate-pulse">Looking up nutrients...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-slate-700 px-4 py-3 pb-[env(safe-area-inset-bottom)]">
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="w-full mb-2 text-xs text-slate-400 border border-slate-600 rounded-full py-1.5 hover:text-green-400 hover:border-green-500"
          >
            + Add more foods
          </button>
        )}
        <form
          onSubmit={e => { e.preventDefault(); send() }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Add a food or recipe (e.g. chicken breast, shakshuka)"
            className="flex-1 bg-slate-800 border border-slate-600 rounded-full px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-green-500"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="bg-green-600 text-white rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Save
          </button>
        </form>
      </div>
    </div>
  )
}

function MacroBox({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="text-center bg-slate-700 rounded-lg py-2">
      <div className="text-base font-bold text-slate-100">
        {value ?? '—'}{unit ?? ''}
      </div>
      <div className="text-[10px] text-slate-400">{label}</div>
    </div>
  )
}
