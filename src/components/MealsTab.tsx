import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { RecurringMeal } from '../lib/types'

export default function MealsTab() {
  const [meals, setMeals] = useState<RecurringMeal[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    loadMeals()
  }, [])

  async function loadMeals() {
    console.log('[MealsTab] Loading recurring meals')
    const { data, error } = await supabase
      .from('recurring_meals')
      .select('*')
      .order('name', { ascending: true })
    if (error) {
      console.error('[MealsTab] Load error:', error)
    }
    setMeals(data ?? [])
    setLoading(false)
  }

  async function deleteMeal(id: string) {
    console.log('[MealsTab] Deleting meal:', id)
    const { error } = await supabase.from('recurring_meals').delete().eq('id', id)
    if (error) {
      console.error('[MealsTab] Delete error:', error)
      return
    }
    setMeals(prev => prev.filter(m => m.id !== id))
    setDeleteId(null)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-slate-400 animate-pulse">Loading meals...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      <p className="text-xs text-slate-500 text-center mb-2">
        Create and edit meals by chatting in the Log tab
      </p>

      {meals.length === 0 && (
        <p className="text-slate-500 text-sm text-center mt-12">
          No saved meals yet. Log a meal and say "save as recurring" in the Log tab.
        </p>
      )}

      {meals.map(meal => {
        const isExpanded = expandedId === meal.id
        const isDeleting = deleteId === meal.id
        const ingredients = (meal.ingredients_json ?? []) as { name: string; amount: string }[]

        return (
          <div
            key={meal.id}
            className="bg-slate-800 border border-slate-600 rounded-xl overflow-hidden"
          >
            {/* Collapsed header — always visible */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : meal.id)}
              className="w-full px-4 py-3 flex items-center justify-between text-left"
            >
              <span className="font-medium text-slate-100 text-sm truncate mr-3">
                {meal.name}
              </span>
              <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                <span>{meal.calories ?? '—'} cal</span>
                <span>{meal.protein_g ?? '—'}g P</span>
                <svg
                  className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {/* Expanded details */}
            {isExpanded && (
              <div className="px-4 pb-4 space-y-3 border-t border-slate-700">
                {/* Macros grid */}
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

                {/* Ingredients */}
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

                {/* Delete */}
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
                    Delete meal
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
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
