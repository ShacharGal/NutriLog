import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface NutrientsPer100g {
  calories: number; protein: number; carbs: number; fat: number; fiber: number
}

interface LLMParsedItem {
  food_name: string; quantity_grams: number
}

interface ResolvedIngredient {
  food_name: string; weight_g: number; nutrients_per_100g: NutrientsPer100g; source: 'personal' | 'usda' | 'llm'
}

// ─── Constants ──────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STAGE1_MODEL = 'google/gemini-2.5-flash-lite'
const FALLBACK_MODEL = 'openai/gpt-4o-mini'

const USDA_API_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const NUTRIENT_IDS = { ENERGY: 1008, PROTEIN: 1003, CARBS: 1005, FAT: 1004, FIBER: 1079 } as const

const STAGE1_SYSTEM_PROMPT = `You are a meal-ingredient extraction assistant for a nutrition tracker.
Your ONLY job is to parse a meal/recipe description into a list of individual ingredients with estimated gram weights.
You do NOT calculate calories, protein, or any macros — that is handled by a separate lookup step.

USER PROFILE:
- Male, 185cm
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

OUTPUT (valid JSON only):
{"status":"parsed","items":[{"food_name":"string","quantity_grams":number}]}
{"status":"needs_clarification","question":"string"}`

// ─── Helpers (duplicated — Vercel single-file constraint) ──────────────────

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

// ─── USDA ───────────────────────────────────────────────────────────────────

const USDA_SEARCH_OVERRIDES: Record<string, string> = {
  'egg': 'egg whole raw', 'eggs': 'egg whole raw',
  'white bread': 'bread white commercially prepared', 'butter': 'butter salted',
  'olive oil': 'oil olive', 'rice': 'rice white cooked',
  'chicken breast': 'chicken breast meat cooked roasted', 'chicken thigh': 'chicken thigh meat cooked',
  'pasta': 'pasta cooked', 'spaghetti': 'spaghetti cooked',
  'avocado': 'avocado raw', 'banana': 'banana raw', 'apple': 'apple raw',
  'tomato': 'tomato red ripe raw', 'onion': 'onion raw', 'garlic': 'garlic raw',
  'pita bread': 'pita bread white', 'hummus': 'hummus commercial',
  'ground beef': 'beef ground 85 lean cooked', 'salmon': 'salmon atlantic cooked',
  'cheese': 'cheese cheddar',
}

function extractNutrient(nutrients: Array<{ nutrientId: number; value: number }>, id: number): number {
  return nutrients.find(n => n.nutrientId === id)?.value ?? 0
}

async function searchUSDA(foodName: string): Promise<NutrientsPer100g | null> {
  const searchTerm = foodName.toLowerCase().trim()
  const queryTerm = USDA_SEARCH_OVERRIDES[searchTerm] ?? foodName

  const { data: cached } = await supabase
    .from('usda_cache')
    .select('nutrients_per_100g')
    .ilike('search_term', searchTerm)
    .limit(1)
    .maybeSingle()

  if (cached) {
    console.log(`[SaveRecipe] USDA cache hit: "${searchTerm}"`)
    return cached.nutrients_per_100g as NutrientsPer100g
  }

  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY'
  const url = `${USDA_API_URL}?query=${encodeURIComponent(queryTerm)}&pageSize=5&dataType=SR%20Legacy&api_key=${apiKey}`

  console.log(`[SaveRecipe] USDA API: "${queryTerm}"`)

  try {
    const response = await fetch(url)
    if (!response.ok) return null

    const data = (await response.json()) as { foods?: Array<{ fdcId?: number; description?: string; foodCategory?: string; foodNutrients?: Array<{ nutrientId: number; value: number }> }> }
    if (!data.foods?.length) return null

    const derivativeWords = ['oil', 'powder', 'dried', 'extract', 'dehydrated', 'concentrate']
    const searchLower = searchTerm.toLowerCase()
    const searchWordsSet = new Set(searchLower.split(/\s+/))
    const userWantsDerivative = derivativeWords.some(w => searchWordsSet.has(w))

    const scored = data.foods.map((f, idx) => {
      const desc = (f.description ?? '').toLowerCase()
      let score = 0
      if (desc === searchLower) score += 100
      else if (desc.startsWith(searchLower + ',') || desc.startsWith(searchLower + ' ')) score += 50
      else if (desc.includes(searchLower)) score += 30
      if (!userWantsDerivative) {
        for (const dw of derivativeWords) {
          if (desc.includes(dw)) { score -= 40; break }
        }
      }
      score -= desc.length * 0.1
      score -= idx * 2
      return { food: f, score, desc }
    })
    scored.sort((a, b) => b.score - a.score)

    const food = scored[0].food
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
    return result
  } catch (err) {
    console.log(`[SaveRecipe] USDA error:`, err instanceof Error ? err.message : err)
    return null
  }
}

// ─── Personal DB ────────────────────────────────────────────────────────────

async function findPersonalIngredient(foodName: string): Promise<{ nutrients_per_100g: NutrientsPer100g } | null> {
  const term = foodName.trim()
  const { data } = await supabase
    .from('personal_ingredients')
    .select('nutrients_per_100g')
    .or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)
    .limit(1)
    .maybeSingle()

  if (data) { console.log(`[SaveRecipe] Personal DB hit: "${term}"`); return { nutrients_per_100g: data.nutrients_per_100g as NutrientsPer100g } }
  return null
}

// ─── LLM Fallback ───────────────────────────────────────────────────────────

async function estimateNutritionLLM(foodName: string): Promise<NutrientsPer100g | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  console.log(`[SaveRecipe] LLM fallback: "${foodName}"`)
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

// ─── Resolver ───────────────────────────────────────────────────────────────

async function resolveIngredients(items: LLMParsedItem[]): Promise<ResolvedIngredient[]> {
  console.log(`[SaveRecipe] Resolving ${items.length} items`)
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

    console.log(`[SaveRecipe] No data for "${name}", using zeros`)
    return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }, source: 'llm' }
  }))
}

// ─── Stage 1: Parse input into ingredients ─────────────────────────────────

interface Stage1Result {
  status: 'parsed' | 'needs_clarification'
  items?: LLMParsedItem[]
  question?: string
}

async function parseRecipe(message: string): Promise<Stage1Result | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 50_000)

  let aiRes: Response
  try {
    aiRes = await fetch(OPENROUTER_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://nutrilog.vercel.app', 'X-Title': 'NutriLog' },
      body: JSON.stringify({
        model: STAGE1_MODEL, temperature: 0.1,
        messages: [
          { role: 'system', content: STAGE1_SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
    })
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') console.error('[SaveRecipe] Stage 1 timeout')
    return null
  }
  clearTimeout(timeout)

  if (!aiRes.ok) return null

  const aiData = await aiRes.json()
  const rawContent = aiData.choices?.[0]?.message?.content ?? ''

  try {
    const codeBlock = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/)
    const braceMatch = rawContent.match(/\{[\s\S]*\}/)
    const jsonStr = codeBlock?.[1]?.trim() ?? braceMatch?.[0] ?? rawContent.trim()
    return JSON.parse(jsonStr) as Stage1Result
  } catch {
    console.error('[SaveRecipe] Parse failed:', rawContent.slice(0, 300))
    return null
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    // ─── GET: list all recurring meals ──────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('recurring_meals')
        .select('*')
        .order('name', { ascending: true })

      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }

    // ─── POST: parse + resolve + save recipe ────────────────────────────
    if (req.method === 'POST') {
      const { message } = req.body as { message: string }
      if (!message) return res.status(400).json({ error: 'message is required' })

      console.log(`[SaveRecipe] Input: "${message}"`)

      const parsed = await parseRecipe(message)
      if (!parsed) return res.status(502).json({ error: 'Failed to parse input' })

      if (parsed.status === 'needs_clarification') {
        return res.json({ status: 'needs_clarification', message: parsed.question })
      }

      if (!parsed.items?.length) {
        return res.status(502).json({ error: 'Could not identify any ingredients' })
      }

      console.log(`[SaveRecipe] Parsed ${parsed.items.length} items`)

      // Resolve all ingredients
      const resolvedItems = await resolveIngredients(parsed.items)

      // Calculate totals & validate
      let totals = calculateTotals(resolvedItems)
      if (!atwaterCheck(totals)) {
        console.log('[SaveRecipe] Atwater correction applied')
        totals = atwaterCorrect(totals)
      }

      const mealDescription = resolvedItems.map(i => `${i.food_name} (${i.weight_g}g)`).join(', ')
      const recipeName = message.trim()

      // Upsert into recurring_meals
      const { data: saved, error } = await supabase
        .from('recurring_meals')
        .upsert({
          name: recipeName.toLowerCase(),
          meal_description: mealDescription,
          ingredients_json: resolvedItems.map(i => ({ name: i.food_name, amount: `${i.weight_g}g` })),
          calories: totals.calories,
          protein_g: totals.protein,
          fiber_g: totals.fiber,
          carbs_g: totals.carbs,
          fat_g: totals.fat,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'name' })
        .select()
        .single()

      if (error) {
        console.error('[SaveRecipe] DB error:', error.message)
        return res.status(500).json({ error: 'Failed to save recipe' })
      }

      console.log(`[SaveRecipe] Saved: "${recipeName}" — ${totals.calories} cal`)

      return res.json({
        status: 'saved',
        message: `Saved "${recipeName}" as a recipe!`,
        recipe: {
          id: saved.id,
          name: recipeName,
          ingredients: resolvedItems.map(i => ({
            name: i.food_name,
            weight_g: i.weight_g,
            nutrients_per_100g: i.nutrients_per_100g,
            source: i.source,
          })),
          totals,
        },
      })
    }

    // ─── DELETE: remove by id ───────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id as string
      if (!id) return res.status(400).json({ error: 'Missing query param: id' })

      const { error } = await supabase.from('recurring_meals').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ success: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[SaveRecipe] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
