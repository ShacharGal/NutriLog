import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface NutrientsPer100g {
  calories: number; protein: number; carbs: number; fat: number; fiber: number
}

interface ResolvedIngredient {
  food_name: string; weight_g: number; nutrients_per_100g: NutrientsPer100g; source: 'personal' | 'usda' | 'llm'
}

interface LLMParsedItem {
  food_name: string; quantity_grams: number
}

type SourceTier = 'personal' | 'usda' | 'llm' | 'mixed'
type MealClassification = 'EXACT_MATCH' | 'REMOVE' | 'QUANTITY' | 'ADD_SUBSTITUTE' | 'NEW_MEAL'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STAGE1_MODEL = 'google/gemini-2.5-flash-lite-preview'
const FALLBACK_MODEL = 'openai/gpt-4o-mini'

const USDA_API_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const NUTRIENT_IDS = { ENERGY: 1008, PROTEIN: 1003, CARBS: 1005, FAT: 1004, FIBER: 1079 } as const

const STAGE1_SYSTEM_PROMPT = `You are a meal-ingredient extraction assistant for a nutrition tracker.
Your ONLY job is to parse a meal description into a list of individual ingredients with estimated gram weights.
You do NOT calculate calories, protein, or any macros — that is handled by a separate lookup step.

USER PROFILE:
- Male, 185cm, weight is dynamic (provided at runtime)
- Cuisine context: Israeli/Mediterranean home cooking is typical

DIETARY CONTEXT:
- Does NOT eat cow dairy. Sheep and goat dairy are fine.
- Avoids gluten and processed foods (not strict, but preferred)

LANGUAGE:
- The user writes in Hebrew, English, or a mix of both.
- All JSON output fields MUST be in English.
- For Israeli/Middle-Eastern foods, transliterate (e.g., לבנה → "labneh", פרגית → "chicken thigh/pargiyot").
- Clarification questions: respond in the same language the user used.

PORTION DEFAULTS:
- 1 egg = 50g, 1 chicken breast = 160g, 1 slice bread = 35g
- A bowl = 300ml, a plate = moderate adult serving
- A handful of nuts = 30g, olive oil for cooking = 15g
- 1 pita = 60g, 1 cup rice (cooked) = 200g

BEHAVIOR:
1. Break down the meal into ALL individual ingredients with gram weights.
   - Include cooking fats even if not explicitly mentioned.
   - Decompose composite dishes into components.
2. If too vague, respond with needs_clarification. Max 1 question.
   - Simple meals (2 eggs, a banana): always parse immediately.

EXAMPLES:
User: "2 scrambled eggs with toast"
{"status":"parsed","items":[{"food_name":"egg","quantity_grams":100},{"food_name":"white bread","quantity_grams":35},{"food_name":"butter","quantity_grams":5}]}

User: "shakshuka with 2 pitas and hummus"
{"status":"parsed","items":[{"food_name":"canned crushed tomatoes","quantity_grams":200},{"food_name":"egg","quantity_grams":100},{"food_name":"onion","quantity_grams":50},{"food_name":"bell pepper","quantity_grams":40},{"food_name":"olive oil","quantity_grams":15},{"food_name":"pita bread","quantity_grams":120},{"food_name":"hummus","quantity_grams":80}]}

OUTPUT (valid JSON only):
{"status":"parsed","items":[{"food_name":"string","quantity_grams":number}]}
{"status":"needs_clarification","question":"string"}`

// ─── Validation ──────────────────────────────────────────────────────────────

function clampNutrients(p: NutrientsPer100g): NutrientsPer100g {
  const c = (v: number, max: number) => Math.max(0, Math.min(v, max))
  return { calories: c(p.calories, 2000), protein: c(p.protein, 200), carbs: c(p.carbs, 200), fat: c(p.fat, 200), fiber: c(p.fiber, 200) }
}

function atwaterCheck(p: NutrientsPer100g): boolean {
  const expected = 4 * p.protein + 4 * p.carbs + 9 * p.fat + 2 * p.fiber
  if (expected === 0 && p.calories === 0) return true
  return Math.abs(p.calories - expected) <= 0.15 * expected
}

function atwaterCorrect(p: NutrientsPer100g): NutrientsPer100g {
  return { ...p, calories: Math.round(4 * p.protein + 4 * p.carbs + 9 * p.fat + 2 * p.fiber) }
}

function calculateTotals(items: ResolvedIngredient[]): NutrientsPer100g {
  const t: NutrientsPer100g = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  for (const item of items) {
    const f = item.weight_g / 100
    t.calories += item.nutrients_per_100g.calories * f
    t.protein += item.nutrients_per_100g.protein * f
    t.carbs += item.nutrients_per_100g.carbs * f
    t.fat += item.nutrients_per_100g.fat * f
    t.fiber += item.nutrients_per_100g.fiber * f
  }
  t.calories = Math.round(t.calories)
  t.protein = Math.round(t.protein * 10) / 10
  t.carbs = Math.round(t.carbs * 10) / 10
  t.fat = Math.round(t.fat * 10) / 10
  t.fiber = Math.round(t.fiber * 10) / 10
  return t
}

// ─── Classifier ──────────────────────────────────────────────────────────────

const REMOVE_PATTERN = /\b(without|remove|no|בלי|ללא)\s+/i
const QUANTITY_PATTERN = /\b(double|half|extra|less|more|כפול|חצי)\b/i
const ADD_SUB_PATTERN = /\b(add|swap|replace|substitute|instead|עם|במקום|להוסיף|להחליף)\b/i

function classifyInput(input: string, savedMealNames: string[]): { classification: MealClassification; matchedMeal?: string; modifier?: string } {
  const lower = input.trim().toLowerCase()

  for (const name of savedMealNames) {
    if (lower === name.toLowerCase()) return { classification: 'EXACT_MATCH', matchedMeal: name }
  }

  const sorted = [...savedMealNames].sort((a, b) => b.length - a.length)
  const matchedMeal = sorted.find(n => lower.includes(n.toLowerCase()))

  if (REMOVE_PATTERN.test(lower) && matchedMeal) return { classification: 'REMOVE', matchedMeal }
  if (QUANTITY_PATTERN.test(lower) && matchedMeal) return { classification: 'QUANTITY', matchedMeal }
  if (ADD_SUB_PATTERN.test(lower) && matchedMeal) return { classification: 'ADD_SUBSTITUTE', matchedMeal }

  return { classification: 'NEW_MEAL' }
}

// ─── USDA Client ─────────────────────────────────────────────────────────────

function extractNutrient(nutrients: Array<{ nutrientId: number; value: number }>, id: number): number {
  return nutrients.find(n => n.nutrientId === id)?.value ?? 0
}

async function searchUSDA(foodName: string): Promise<NutrientsPer100g | null> {
  const searchTerm = foodName.toLowerCase().trim()

  const { data: cached } = await supabase
    .from('usda_cache')
    .select('nutrients_per_100g')
    .ilike('search_term', searchTerm)
    .limit(1)
    .maybeSingle()

  if (cached) {
    console.log(`[USDA] Cache hit: "${searchTerm}"`)
    return cached.nutrients_per_100g as NutrientsPer100g
  }

  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY'
  const url = `${USDA_API_URL}?query=${encodeURIComponent(foodName)}&pageSize=1&dataType=Foundation,SR%20Legacy&api_key=${apiKey}`

  console.log(`[USDA] API call: "${foodName}"`)

  try {
    const response = await fetch(url)
    if (!response.ok) { console.log(`[USDA] API error: ${response.status}`); return null }

    const data = (await response.json()) as { foods?: Array<{ fdcId?: number; foodCategory?: string; foodNutrients?: Array<{ nutrientId: number; value: number }> }> }
    if (!data.foods?.length) { console.log(`[USDA] No results: "${foodName}"`); return null }

    const food = data.foods[0]
    const nutrients = food.foodNutrients ?? []
    const result: NutrientsPer100g = {
      calories: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.ENERGY)),
      protein: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.PROTEIN) * 10) / 10,
      carbs: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.CARBS) * 10) / 10,
      fat: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.FAT) * 10) / 10,
      fiber: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.FIBER) * 10) / 10,
    }

    await supabase.from('usda_cache').insert({
      fdc_id: food.fdcId ?? null, search_term: searchTerm,
      nutrients_per_100g: result, food_category: food.foodCategory ?? null,
    })
    console.log(`[USDA] Cached: "${searchTerm}"`)
    return result
  } catch (err) {
    console.log(`[USDA] Error:`, err instanceof Error ? err.message : err)
    return null
  }
}

// ─── Personal DB ─────────────────────────────────────────────────────────────

async function findPersonalIngredient(foodName: string): Promise<{ nutrients_per_100g: NutrientsPer100g } | null> {
  const term = foodName.trim()
  const { data } = await supabase
    .from('personal_ingredients')
    .select('nutrients_per_100g')
    .or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)
    .limit(1)
    .maybeSingle()

  if (data) { console.log(`[PersonalDB] Hit: "${term}"`); return { nutrients_per_100g: data.nutrients_per_100g as NutrientsPer100g } }
  return null
}

async function findRecurringMeal(mealName: string): Promise<Record<string, unknown> | null> {
  const term = mealName.trim()
  const { data: byName } = await supabase.from('recurring_meals').select('*').ilike('name', term).limit(1).maybeSingle()
  if (byName) return byName as Record<string, unknown>

  const { data: byAlias } = await supabase.from('recurring_meals').select('*').contains('aliases', [term.toLowerCase()]).limit(1).maybeSingle()
  if (byAlias) return byAlias as Record<string, unknown>
  return null
}

// ─── Resolver ────────────────────────────────────────────────────────────────

async function resolveIngredients(items: LLMParsedItem[]): Promise<ResolvedIngredient[]> {
  console.log(`[Resolver] Resolving ${items.length} items`)
  return Promise.all(items.map(async (item): Promise<ResolvedIngredient> => {
    const name = item.food_name

    // Tier 1: Personal DB
    const personal = await findPersonalIngredient(name)
    if (personal) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(personal.nutrients_per_100g), source: 'personal' }

    // Tier 2: USDA
    const usda = await searchUSDA(name)
    if (usda) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(usda), source: 'usda' }

    // Tier 3: LLM fallback
    const llm = await estimateNutritionLLM(name)
    if (llm) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(llm), source: 'llm' }

    console.log(`[Resolver] No data for "${name}", using zeros`)
    return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }, source: 'llm' }
  }))
}

async function estimateNutritionLLM(foodName: string): Promise<NutrientsPer100g | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  console.log(`[Resolver] LLM fallback: "${foodName}"`)
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://nutrilog.vercel.app', 'X-Title': 'NutriLog' },
      body: JSON.stringify({
        model: FALLBACK_MODEL, temperature: 0.1,
        messages: [
          { role: 'system', content: 'You are a nutrition database. Return ONLY valid JSON, no other text.' },
          { role: 'user', content: `Estimate nutritional values per 100g for: ${foodName}. Return JSON: {"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number}` },
        ],
      }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const p = JSON.parse(match[0]) as Record<string, unknown>
    return clampNutrients({ calories: Number(p.calories) || 0, protein: Number(p.protein) || 0, carbs: Number(p.carbs) || 0, fat: Number(p.fat) || 0, fiber: Number(p.fiber) || 0 })
  } catch { return null }
}

// ─── Stage 1 LLM ────────────────────────────────────────────────────────────

interface Stage1Result {
  status: 'parsed' | 'needs_clarification'
  items?: LLMParsedItem[]
  question?: string
}

async function callStage1LLM(
  message: string, conversationHistory: ChatMessage[], currentWeight: number,
  settings: { daily_calorie_target: number; daily_protein_target: number },
  savedMeals: { name: string; aliases: string[] | null }[],
): Promise<Stage1Result | null> {
  const mealList = savedMeals.map(m => m.aliases?.length ? `${m.name} (aliases: ${m.aliases.join(', ')})` : m.name)
  const systemPrompt = STAGE1_SYSTEM_PROMPT + `\n\nCURRENT CONTEXT:\n- Current weight: ${currentWeight}kg\n- Daily targets: ${settings.daily_calorie_target} cal, ${settings.daily_protein_target}g protein\n- Saved recurring meals: ${mealList.length ? mealList.join('; ') : 'none yet'}`

  const messages = [{ role: 'system', content: systemPrompt }, ...conversationHistory.slice(-5), { role: 'user', content: message }]

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 50_000)

  let aiRes: Response
  try {
    aiRes = await fetch(OPENROUTER_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://nutrilog.vercel.app', 'X-Title': 'NutriLog' },
      body: JSON.stringify({ model: STAGE1_MODEL, messages, temperature: 0.1 }),
    })
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') console.error('[LogAPI] Stage 1 timeout')
    return null
  }
  clearTimeout(timeout)

  if (!aiRes.ok) { console.error('[LogAPI] OpenRouter error:', (await aiRes.text()).slice(0, 200)); return null }

  const aiData = await aiRes.json()
  const rawContent = aiData.choices?.[0]?.message?.content ?? ''

  try {
    const codeBlock = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/)
    const braceMatch = rawContent.match(/\{[\s\S]*\}/)
    const jsonStr = codeBlock?.[1]?.trim() ?? braceMatch?.[0] ?? rawContent.trim()
    return JSON.parse(jsonStr) as Stage1Result
  } catch {
    console.error('[LogAPI] Failed to parse Stage 1:', rawContent.slice(0, 300))
    return null
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { message, conversationHistory = [], lastEntryId } = req.body as {
      message: string; conversationHistory: ChatMessage[]; lastEntryId?: string
    }
    if (!message) return res.status(400).json({ error: 'message is required' })

    console.log(`[LogAPI] Input: "${message}"`)

    // Fetch context
    const [weightRes, todayRes, recurringRes, settingsRes] = await Promise.all([
      supabase.from('weight_log').select('weight_kg').order('logged_at', { ascending: false }).limit(1),
      supabase.from('nutrition_log').select('calories, protein_g').gte('created_at', new Date().toISOString().slice(0, 10)),
      supabase.from('recurring_meals').select('name, aliases'),
      supabase.from('user_settings').select('*').eq('id', 1).single(),
    ])

    const currentWeight = weightRes.data?.[0]?.weight_kg ?? 80
    const settings = settingsRes.data ?? { daily_protein_target: 145, daily_calorie_target: 2400 }
    const todayEntries = todayRes.data ?? []
    const todayCalories = todayEntries.reduce((sum: number, e: { calories: number | null }) => sum + (e.calories ?? 0), 0)
    const todayProtein = todayEntries.reduce((sum: number, e: { protein_g: number | null }) => sum + (e.protein_g ?? 0), 0)

    const savedMeals = (recurringRes.data ?? []) as { name: string; aliases: string[] | null }[]
    const savedMealNames = savedMeals.flatMap(m => [m.name, ...(m.aliases ?? [])])

    // Classify
    const classification = classifyInput(message, savedMealNames)
    console.log(`[LogAPI] Classification: ${classification.classification}`)

    // EXACT_MATCH: log from recurring meal
    if (classification.classification === 'EXACT_MATCH' && classification.matchedMeal) {
      const meal = await findRecurringMeal(classification.matchedMeal)
      if (meal) {
        const entryData = {
          raw_input: message, meal_description: meal.meal_description as string,
          ingredients_json: meal.ingredients_json, calories: meal.calories as number,
          protein_g: meal.protein_g as number, fiber_g: meal.fiber_g as number,
          carbs_g: meal.carbs_g as number, fat_g: meal.fat_g as number,
          recurring_meal_ref: meal.name as string, source_tier: 'personal' as SourceTier,
        }

        let entry, error
        if (lastEntryId) {
          ;({ data: entry, error } = await supabase.from('nutrition_log').update(entryData).eq('id', lastEntryId).select().single())
        } else {
          ;({ data: entry, error } = await supabase.from('nutrition_log').insert(entryData).select().single())
        }
        if (error) return res.status(500).json({ error: 'Failed to save entry' })
        console.log(`[LogAPI] Logged recurring "${meal.name}" — zero tokens`)
        return res.json({ status: 'ready_to_log', message: `Logged "${meal.name}"!`, logged_entry: entry })
      }
    }

    // NEW_MEAL (or fallthrough from REMOVE/QUANTITY/ADD_SUBSTITUTE)
    const stage1Result = await callStage1LLM(message, conversationHistory, currentWeight, settings, savedMeals)
    if (!stage1Result) return res.status(502).json({ error: 'Failed to get AI response' })

    if (stage1Result.status === 'needs_clarification') {
      return res.json({ status: 'needs_clarification', message: stage1Result.question })
    }

    if (stage1Result.status !== 'parsed' || !stage1Result.items?.length) {
      return res.status(502).json({ error: 'AI returned unexpected format' })
    }

    console.log(`[LogAPI] Stage 1 parsed ${stage1Result.items.length} items`)

    // Resolve ingredients
    const resolvedItems = await resolveIngredients(stage1Result.items)

    // Calculate totals & validate
    let totals = calculateTotals(resolvedItems)
    if (!atwaterCheck(totals)) {
      console.log('[LogAPI] Atwater correction applied')
      totals = atwaterCorrect(totals)
    }

    const sources = new Set(resolvedItems.map(i => i.source))
    const sourceTier: SourceTier = sources.size === 1 ? resolvedItems[0].source : 'mixed'
    const mealDescription = resolvedItems.map(i => `${i.food_name} (${i.weight_g}g)`).join(', ')

    // Write to DB
    const entryData = {
      raw_input: message, meal_description: mealDescription,
      ingredients_json: resolvedItems.map(i => ({ name: i.food_name, amount: `${i.weight_g}g` })),
      calories: totals.calories, protein_g: totals.protein, fiber_g: totals.fiber,
      carbs_g: totals.carbs, fat_g: totals.fat,
      ingredients: resolvedItems, source_tier: sourceTier,
    }

    let entry, error
    if (lastEntryId) {
      ;({ data: entry, error } = await supabase.from('nutrition_log').update(entryData).eq('id', lastEntryId).select().single())
    } else {
      ;({ data: entry, error } = await supabase.from('nutrition_log').insert(entryData).select().single())
    }
    if (error) { console.error('[LogAPI] DB error:', error); return res.status(500).json({ error: 'Failed to save entry' }) }

    console.log(`[LogAPI] Logged: ${totals.calories} cal, ${totals.protein}g protein [${sourceTier}]`)
    return res.json({ status: 'ready_to_log', message: lastEntryId ? 'Meal updated!' : 'Meal logged!', logged_entry: entry })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[LogAPI] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
