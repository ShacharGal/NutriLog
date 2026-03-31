import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { RecurringMeal, PersonalIngredient } from '../lib/types'

export default function MealsTab() {
  const [subTab, setSubTab] = useState<'meals' | 'foods'>('foods')

  return (
    <div className="flex flex-col flex-1">
      {/* Sub-tab toggle */}
      <div className="flex gap-1 px-4 pt-3 pb-2">
        <button
          onClick={() => setSubTab('foods')}
          className={`flex-1 py-2 text-xs font-medium rounded-full transition-colors ${
            subTab === 'foods' ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-400'
          }`}
        >
          Ingredients
        </button>
        <button
          onClick={() => setSubTab('meals')}
          className={`flex-1 py-2 text-xs font-medium rounded-full transition-colors ${
            subTab === 'meals' ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-400'
          }`}
        >
          Recipes
        </button>
      </div>

      {subTab === 'meals' ? <RecipesSection /> : <MyFoodsSection />}
    </div>
  )
}

// ─── Recipes Section ────────────────────────────────────────────────────────

interface RecipeChatMessage {
  role: 'user' | 'assistant'
  content: string
  recipe?: {
    name: string
    ingredients: { name: string; weight_g: number; source: string }[]
    totals: { calories: number; protein: number; carbs: number; fat: number; fiber: number }
  }
}

function RecipesSection() {
  const [meals, setMeals] = useState<RecurringMeal[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const [messages, setMessages] = useState<RecipeChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadMeals() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function loadMeals() {
    console.log('[Recipes] Loading recurring meals')
    const { data, error } = await supabase
      .from('recurring_meals')
      .select('*')
      .order('name', { ascending: true })
    if (error) console.error('[Recipes] Load error:', error)
    setMeals(data ?? [])
    setLoading(false)
  }

  async function deleteMeal(id: string) {
    console.log('[Recipes] Deleting meal:', id)
    const { error } = await supabase.from('recurring_meals').delete().eq('id', id)
    if (error) {
      console.error('[Recipes] Delete error:', error)
      return
    }
    setMeals(prev => prev.filter(m => m.id !== id))
    setDeleteId(null)
  }

  async function send() {
    const text = input.trim()
    if (!text || sending) return

    setInput('')
    setSending(true)

    setMessages(prev => [...prev, { role: 'user', content: text }])

    try {
      const res = await fetch('/api/save-recipe', {
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
        recipe: data.recipe,
      }])

      if (data.recipe) {
        await loadMeals()
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
          <p className="text-slate-400 animate-pulse text-center">Loading recipes...</p>
        ) : meals.length === 0 && messages.length === 0 ? (
          <p className="text-slate-500 text-sm text-center mt-12 px-6">
            No saved recipes yet. Add one below, or say "save as recurring" when logging a meal.
          </p>
        ) : null}

        {/* Recipe list */}
        {meals.map(meal => {
          const isExpanded = expandedId === meal.id
          const isDeleting = deleteId === meal.id
          const ingredients = (meal.ingredients_json ?? []) as { name: string; amount: string }[]

          return (
            <div
              key={meal.id}
              className="bg-slate-800 border border-slate-600 rounded-xl overflow-hidden"
            >
              <button
                onClick={() => setExpandedId(isExpanded ? null : meal.id)}
                className="w-full px-4 py-3 flex items-center justify-between text-left"
              >
                <span className="font-medium text-slate-100 text-sm truncate mr-3 capitalize">
                  {meal.name}
                </span>
                <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                  <span>{meal.calories ?? '—'} cal</span>
                  <span>{meal.protein_g ?? '—'}g P</span>
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
                  <div className="grid grid-cols-4 gap-2 pt-3">
                    <MacroBox label="cal" value={meal.calories} />
                    <MacroBox label="protein" value={meal.protein_g} unit="g" />
                    <MacroBox label="carbs" value={meal.carbs_g} unit="g" />
                    <MacroBox label="fat" value={meal.fat_g} unit="g" />
                  </div>

                  {meal.fiber_g != null && (
                    <div className="text-xs text-slate-400">
                      Fiber: {meal.fiber_g}g
                    </div>
                  )}

                  {ingredients.length > 0 && (
                    <div>
                      <p className="text-xs text-slate-400 mb-1">Ingredients</p>
                      <ul className="text-sm text-slate-300 space-y-0.5">
                        {ingredients.map((ing, i) => (
                          <li key={i}>
                            {ing.name}{ing.amount ? ` — ${ing.amount}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {meal.meal_description && (
                    <p className="text-xs text-slate-500 italic">{meal.meal_description}</p>
                  )}

                  {isDeleting ? (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs text-red-400">Delete "{meal.name}"?</span>
                      <button
                        onClick={() => deleteMeal(meal.id)}
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
                      onClick={() => setDeleteId(meal.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete recipe
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

            {msg.recipe && (
              <div className="mt-2 mr-auto bg-slate-800 border border-slate-600 rounded-xl p-3 max-w-[85%]">
                <div className="text-xs text-slate-300 mb-2 capitalize font-medium">{msg.recipe.name}</div>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  <MacroBox label="cal" value={msg.recipe.totals.calories} />
                  <MacroBox label="protein" value={msg.recipe.totals.protein} unit="g" />
                  <MacroBox label="carbs" value={msg.recipe.totals.carbs} unit="g" />
                  <MacroBox label="fat" value={msg.recipe.totals.fat} unit="g" />
                </div>
                <p className="text-[10px] text-slate-500 mb-1">Ingredients</p>
                <ul className="text-xs text-slate-400 space-y-0.5">
                  {msg.recipe.ingredients.map((ing, j) => (
                    <li key={j}>{ing.name} — {ing.weight_g}g</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="mr-auto bg-slate-700 rounded-2xl px-4 py-2 text-sm text-slate-400">
            <span className="animate-pulse">Building recipe...</span>
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
            + Add another recipe
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
            placeholder="Describe a recipe (e.g. shakshuka with 2 pitas)"
            autoFocus
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

// ─── My Foods Section ───────────────────────────────────────────────────────

interface FoodChatMessage {
  role: 'user' | 'assistant'
  content: string
  ingredients?: { name: string; nutrients_per_100g: { calories: number; protein: number; carbs: number; fat: number; fiber: number }; source: string }[]
}

function MyFoodsSection() {
  const [foods, setFoods] = useState<PersonalIngredient[]>([])
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
    console.log('[MyFoods] Loading personal ingredients')
    const { data, error } = await supabase
      .from('personal_ingredients')
      .select('*')
      .order('name', { ascending: true })
    if (error) console.error('[MyFoods] Load error:', error)
    setFoods(data ?? [])
    setLoading(false)
  }

  async function deleteFood(id: string) {
    console.log('[MyFoods] Deleting:', id)
    const { error } = await supabase.from('personal_ingredients').delete().eq('id', id)
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
      const res = await fetch('/api/save-ingredient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error || res.statusText}` }])
        return
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message,
        ingredients: data.ingredients,
      }])

      // Refresh the list if ingredients were saved
      if (data.ingredients?.length) {
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
      {/* Food list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <p className="text-slate-400 animate-pulse text-center">Loading foods...</p>
        ) : foods.length === 0 && messages.length === 0 ? (
          <p className="text-slate-500 text-sm text-center mt-12 px-6">
            Add foods you eat often — the more specific you are, the better your future logs will be.
          </p>
        ) : null}

        {/* Saved foods list */}
        {foods.map(food => {
          const n = food.nutrients_per_100g
          const isExpanded = expandedId === food.id
          const isDeleting = deleteId === food.id

          return (
            <div key={food.id} className="bg-slate-800 border border-slate-600 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : food.id)}
                className="w-full px-4 py-3 flex items-center justify-between text-left"
              >
                <span className="font-medium text-slate-100 text-sm truncate mr-3 capitalize">
                  {food.name}
                </span>
                <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                  <span>{n.calories} cal</span>
                  <span>{n.protein}g P</span>
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
                  <p className="text-[10px] text-slate-500 pt-2">per 100g</p>
                  <div className="grid grid-cols-5 gap-2">
                    <MacroBox label="cal" value={n.calories} />
                    <MacroBox label="protein" value={n.protein} unit="g" />
                    <MacroBox label="carbs" value={n.carbs} unit="g" />
                    <MacroBox label="fat" value={n.fat} unit="g" />
                    <MacroBox label="fiber" value={n.fiber} unit="g" />
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                      food.source === 'usda' ? 'bg-blue-900 text-blue-300' : 'bg-amber-900 text-amber-300'
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
                      Delete food
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

            {msg.ingredients?.map((ing, j) => (
              <div key={j} className="mt-2 mr-auto bg-slate-800 border border-slate-600 rounded-xl p-3 max-w-[85%]">
                <div className="text-xs text-slate-300 mb-2 capitalize font-medium">{ing.name}</div>
                <p className="text-[10px] text-slate-500 mb-1">per 100g</p>
                <div className="flex items-center gap-4 text-sm">
                  <div className="text-center">
                    <div className="text-base font-bold text-slate-100">{ing.nutrients_per_100g.calories}</div>
                    <div className="text-[10px] text-slate-400">cal</div>
                  </div>
                  <div className="text-center">
                    <div className="text-base font-bold text-slate-100">{ing.nutrients_per_100g.protein}g</div>
                    <div className="text-[10px] text-slate-400">protein</div>
                  </div>
                  <div className="text-center">
                    <div className="text-base font-bold text-slate-100">{ing.nutrients_per_100g.carbs}g</div>
                    <div className="text-[10px] text-slate-400">carbs</div>
                  </div>
                  <div className="text-center">
                    <div className="text-base font-bold text-slate-100">{ing.nutrients_per_100g.fat}g</div>
                    <div className="text-[10px] text-slate-400">fat</div>
                  </div>
                </div>
                <span className={`inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full ${
                  ing.source === 'usda' ? 'bg-blue-900 text-blue-300' : 'bg-amber-900 text-amber-300'
                }`}>
                  {ing.source}
                </span>
              </div>
            ))}
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
            placeholder="Type a food to save (e.g. chicken breast, labneh)"
            autoFocus
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

// ─── Shared ─────────────────────────────────────────────────────────────────

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
