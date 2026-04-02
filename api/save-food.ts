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

interface ChatMessage {
  role: 'user' | 'assistant'; content: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STAGE1_MODEL = 'google/gemini-2.5-flash-lite'
const FALLBACK_MODEL = 'openai/gpt-4o-mini'

const USDA_API_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const NUTRIENT_IDS = { ENERGY: 1008, PROTEIN: 1003, CARBS: 1005, FAT: 1004, FIBER: 1079 } as const

const PARSE_SYSTEM_PROMPT = `You are a food/recipe extraction assistant for a nutrition tracker.
Your job is to parse a food description into individual ingredients with gram weights, AND generate a clean short name for it.

USER PROFILE:
- Cuisine context: Israeli/Mediterranean home cooking is typical
- Does NOT eat cow dairy. Sheep and goat dairy are fine.

LANGUAGE:
- The user writes in Hebrew, English, or a mix of both.
- All JSON output fields MUST be in English.
- For Israeli/Middle-Eastern foods, transliterate (e.g., לבנה → "labneh", פרגית → "chicken thigh").
- Clarification questions: respond in the same language the user used.

PORTION DEFAULTS:
- 1 egg = 50g, 1 chicken breast = 160g, 1 slice bread = 35g
- A bowl = 300ml, a plate = moderate adult serving
- A handful of nuts = 30g, olive oil for cooking = 15g
- 1 pita = 60g, 1 cup rice (cooked) = 200g

BEHAVIOR:
1. Generate a clean, short English name for the food (e.g., "buckwheat granola", "shakshuka", "chicken breast").
   - Strip "my", "homemade", verbose descriptions. Keep it concise and recognizable.
   - For single ingredients, use the standard food name (e.g., "chicken breast" not "grilled chicken breast fillet").
2. Break down into ALL individual ingredients with gram weights.
   - Include cooking fats even if not explicitly mentioned.
   - Decompose composite dishes into components.
3. For simple single ingredients (e.g., "chicken breast", "banana"), return just one item.
4. CLARIFICATION RULES:
   - If the user describes a MULTI-INGREDIENT recipe (3+ ingredients) WITHOUT specific gram weights for most of them, you MUST respond with needs_clarification.
   - Ask about approximate proportions of key ingredients AND total batch/serving size in one question.
   - Example: user says "my granola is buckwheat, oil, nuts, seeds, maple, cinnamon" → ask "What are the approximate amounts of each ingredient? For example: 100g buckwheat, 50g nuts, etc. Also, what's the total weight of one batch or serving?"
   - EXCEPTIONS — parse directly without asking:
     * Single ingredients (e.g., "chicken breast", "banana")
     * Well-known dishes with standard ratios (e.g., "shakshuka", "hummus", "omelette")
     * When the user provides specific gram weights for ALL ingredients
   - Max 1 question per response. Ask for all missing info at once.

OUTPUT (valid JSON only):
{"status":"parsed","recipe_name":"string","items":[{"food_name":"string","quantity_grams":number}]}
{"status":"needs_clarification","question":"string"}`

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    console.log(`[SaveFood] USDA cache hit: "${searchTerm}"`)
    return cached.nutrients_per_100g as NutrientsPer100g
  }

  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY'
  const url = `${USDA_API_URL}?query=${encodeURIComponent(queryTerm)}&pageSize=5&dataType=SR%20Legacy&api_key=${apiKey}`
  console.log(`[SaveFood] USDA API: "${queryTerm}"`)

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
    console.log(`[SaveFood] USDA error:`, err instanceof Error ? err.message : err)
    return null
  }
}

// ─── My Foods DB (Tier 1) ───────────────────────────────────────────────────

async function findMyFood(foodName: string): Promise<{ nutrients_per_100g: NutrientsPer100g } | null> {
  const term = foodName.trim()
  const { data } = await supabase
    .from('my_foods')
    .select('nutrients_per_100g')
    .or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)
    .limit(1)
    .maybeSingle()

  if (data) { console.log(`[SaveFood] My Foods hit: "${term}"`); return { nutrients_per_100g: data.nutrients_per_100g as NutrientsPer100g } }
  return null
}

// ─── LLM Fallback ───────────────────────────────────────────────────────────

async function estimateNutritionLLM(foodName: string): Promise<NutrientsPer100g | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  console.log(`[SaveFood] LLM fallback: "${foodName}"`)
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
  console.log(`[SaveFood] Resolving ${items.length} items`)
  return Promise.all(items.map(async (item): Promise<ResolvedIngredient> => {
    const name = item.food_name

    // Tier 1: My Foods
    const saved = await findMyFood(name)
    if (saved) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(saved.nutrients_per_100g), source: 'personal' }

    // Tier 2: USDA
    const usda = await searchUSDA(name)
    if (usda) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(usda), source: 'usda' }

    // Tier 3: LLM fallback
    const llm = await estimateNutritionLLM(name)
    if (llm) return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: clampNutrients(llm), source: 'llm' }

    console.log(`[SaveFood] No data for "${name}", using zeros`)
    return { food_name: name, weight_g: item.quantity_grams, nutrients_per_100g: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }, source: 'llm' }
  }))
}

// ─── Stage 1: Parse input ───────────────────────────────────────────────────

interface Stage1Result {
  status: 'parsed' | 'needs_clarification'
  recipe_name?: string
  items?: LLMParsedItem[]
  question?: string
}

async function parseFood(message: string, conversationHistory: ChatMessage[] = []): Promise<Stage1Result | null> {
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
          { role: 'system', content: PARSE_SYSTEM_PROMPT },
          ...conversationHistory.slice(-4),
          { role: 'user', content: message },
        ],
      }),
    })
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') console.error('[SaveFood] Stage 1 timeout')
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
    console.error('[SaveFood] Parse failed:', rawContent.slice(0, 300))
    return null
  }
}

// ─── Edit Detection ────────────────────────────────────────────────────────

const EDIT_CLASSIFY_PROMPT = `You classify user messages about food/recipe edits.
The user may want to:
1. SCALE a food to a new serving/total weight (e.g., "edit X such that serving is 150g", "make X 200g", "change X to 100 gram serving")
2. MODIFY ingredients in a food (e.g., "add oats to X", "remove nuts from X", "use coconut oil instead of olive oil in X")
3. Something else — NOT an edit of an existing food (e.g., creating a new food, logging a meal)

Return ONLY valid JSON, nothing else:
{"is_edit":true,"food_name":"name","edit_type":"scale","target_weight_g":150}
{"is_edit":true,"food_name":"name","edit_type":"modify","description":"what to change"}
{"is_edit":false}`

interface EditClassification {
  is_edit: boolean
  food_name?: string
  edit_type?: 'scale' | 'modify'
  target_weight_g?: number | null
  description?: string
}

async function classifyEdit(message: string, conversationHistory: ChatMessage[] = []): Promise<EditClassification> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://nutrilog.vercel.app', 'X-Title': 'NutriLog' },
      body: JSON.stringify({
        model: STAGE1_MODEL, temperature: 0,
        messages: [
          { role: 'system', content: EDIT_CLASSIFY_PROMPT },
          ...conversationHistory.slice(-4),
          { role: 'user', content: message },
        ],
      }),
    })
    clearTimeout(timeout)
    if (!response.ok) return { is_edit: false }
    const data = await response.json()
    const raw = data.choices?.[0]?.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return { is_edit: false }
    return JSON.parse(match[0]) as EditClassification
  } catch {
    return { is_edit: false }
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    // ─── GET: list all my foods ─────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('my_foods')
        .select('*')
        .order('name', { ascending: true })

      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }

    // ─── POST: parse + resolve + save food ──────────────────────────────
    if (req.method === 'POST') {
      const { message, conversationHistory = [], lastSavedFoodName } = req.body as { message: string; conversationHistory: ChatMessage[]; lastSavedFoodName?: string }
      if (!message) return res.status(400).json({ error: 'message is required' })

      console.log(`[SaveFood] Input: "${message}"`)

      // ─── Edit detection: scale/modify existing foods ──────────────────
      const editInfo = await classifyEdit(message, conversationHistory)

      if (editInfo.is_edit && editInfo.food_name) {
        const foodName = editInfo.food_name.toLowerCase().trim()
        console.log(`[SaveFood] Edit detected: "${foodName}", type=${editInfo.edit_type}, target=${editInfo.target_weight_g}g`)

        let { data: existing } = await supabase
          .from('my_foods')
          .select('*')
          .ilike('name', foodName)
          .limit(1)
          .maybeSingle()

        // Fallback: user may refer to the food by a casual name (e.g. "breakfast bowl")
        // while it was saved under a generated name (e.g. "chia pudding with yogurt and granola")
        if (!existing && lastSavedFoodName) {
          console.log(`[SaveFood] Food "${foodName}" not found, trying lastSavedFoodName: "${lastSavedFoodName}"`)
          const { data: fallback } = await supabase
            .from('my_foods')
            .select('*')
            .ilike('name', lastSavedFoodName)
            .limit(1)
            .maybeSingle()
          if (fallback) existing = fallback
        }

        if (!existing) {
          return res.json({ status: 'needs_clarification', message: `I couldn't find "${editInfo.food_name}" in your foods. Can you check the name?` })
        }

        if (editInfo.edit_type === 'scale' && editInfo.target_weight_g && existing.ingredients_json) {
          const oldIngredients = existing.ingredients_json as { name: string; weight_g: number }[]
          const oldTotal = Number(existing.total_weight_g) || oldIngredients.reduce((s, i) => s + i.weight_g, 0)
          const newTotal = editInfo.target_weight_g
          const scaleFactor = newTotal / oldTotal

          const newIngredients = oldIngredients.map(i => ({
            name: i.name,
            weight_g: Math.round(i.weight_g * scaleFactor * 10) / 10,
          }))

          // nutrients_per_100g is invariant under scaling — density doesn't change
          const nutrientsPer100g = existing.nutrients_per_100g as NutrientsPer100g

          const { error } = await supabase
            .from('my_foods')
            .upsert({
              name: existing.name,
              description: newIngredients.map(i => `${i.name} (${i.weight_g}g)`).join(', '),
              ingredients_json: newIngredients,
              nutrients_per_100g: nutrientsPer100g,
              total_weight_g: newTotal,
              source: existing.source,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'name' })

          if (error) {
            console.error('[SaveFood] Edit DB error:', error.message)
            return res.status(500).json({ error: 'Failed to update food' })
          }

          const displayTotals = {
            calories: Math.round(nutrientsPer100g.calories * newTotal / 100),
            protein: Math.round(nutrientsPer100g.protein * newTotal / 100 * 10) / 10,
            carbs: Math.round(nutrientsPer100g.carbs * newTotal / 100 * 10) / 10,
            fat: Math.round(nutrientsPer100g.fat * newTotal / 100 * 10) / 10,
            fiber: Math.round(nutrientsPer100g.fiber * newTotal / 100 * 10) / 10,
          }

          console.log(`[SaveFood] Scaled "${existing.name}": ${oldTotal}g → ${newTotal}g`)

          return res.json({
            status: 'saved',
            message: `Saved "${existing.name}" (${newIngredients.length} ingredients, ${displayTotals.calories} cal total)`,
            food: {
              name: existing.name,
              nutrients_per_100g: nutrientsPer100g,
              ingredients: newIngredients,
              total_weight_g: newTotal,
              totals: displayTotals,
              source: existing.source,
            },
          })
        }

        // For 'modify' edits: inject existing recipe context so LLM can modify with awareness
        if (editInfo.edit_type === 'modify' && existing.ingredients_json) {
          const ingredients = existing.ingredients_json as { name: string; weight_g: number }[]
          const context = `EXISTING RECIPE "${existing.name}" (${existing.total_weight_g}g total): ${ingredients.map(i => `${i.name} ${i.weight_g}g`).join(', ')}.\nUSER REQUEST: ${message}`
          console.log(`[SaveFood] Modify edit — injecting existing recipe context`)
          // Fall through to parseFood with enriched message
          req.body.message = context
        }
      }

      const parsed = await parseFood(req.body.message ?? message, conversationHistory)
      if (!parsed) return res.status(502).json({ error: 'Failed to parse input' })

      if (parsed.status === 'needs_clarification') {
        return res.json({ status: 'needs_clarification', message: parsed.question })
      }

      if (!parsed.items?.length) {
        return res.status(502).json({ error: 'Could not identify any ingredients' })
      }

      const recipeName = (parsed.recipe_name || parsed.items[0].food_name).toLowerCase().trim()
      const isComposite = parsed.items.length > 1

      console.log(`[SaveFood] "${recipeName}" — ${parsed.items.length} items, composite=${isComposite}`)

      // Resolve all sub-ingredients
      const resolvedItems = await resolveIngredients(parsed.items)

      let nutrientsPer100g: NutrientsPer100g
      let totalWeightG: number | null = null
      let ingredientsJson: { name: string; weight_g: number }[] | null = null
      let source: string

      if (isComposite) {
        // Composite food: calculate totals then derive per-100g
        const totalWeight = resolvedItems.reduce((sum, i) => sum + i.weight_g, 0)
        const totals: NutrientsPer100g = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
        for (const item of resolvedItems) {
          const f = item.weight_g / 100
          totals.calories += item.nutrients_per_100g.calories * f
          totals.protein += item.nutrients_per_100g.protein * f
          totals.carbs += item.nutrients_per_100g.carbs * f
          totals.fat += item.nutrients_per_100g.fat * f
          totals.fiber += item.nutrients_per_100g.fiber * f
        }

        // Derive per-100g from totals
        const scale = totalWeight > 0 ? 100 / totalWeight : 1
        nutrientsPer100g = {
          calories: Math.round(totals.calories * scale),
          protein: Math.round(totals.protein * scale * 10) / 10,
          carbs: Math.round(totals.carbs * scale * 10) / 10,
          fat: Math.round(totals.fat * scale * 10) / 10,
          fiber: Math.round(totals.fiber * scale * 10) / 10,
        }

        if (!atwaterCheck(nutrientsPer100g)) {
          nutrientsPer100g = atwaterCorrect(nutrientsPer100g)
        }

        totalWeightG = totalWeight
        ingredientsJson = resolvedItems.map(i => ({ name: i.food_name, weight_g: i.weight_g }))
        source = 'homemade'
      } else {
        // Simple food: use resolved nutrients directly
        nutrientsPer100g = clampNutrients(resolvedItems[0].nutrients_per_100g)
        source = resolvedItems[0].source === 'personal' ? 'usda' : resolvedItems[0].source
      }

      const description = isComposite
        ? resolvedItems.map(i => `${i.food_name} (${i.weight_g}g)`).join(', ')
        : null

      // Upsert into my_foods
      const { error } = await supabase
        .from('my_foods')
        .upsert({
          name: recipeName,
          description,
          ingredients_json: ingredientsJson,
          nutrients_per_100g: nutrientsPer100g,
          total_weight_g: totalWeightG,
          source,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'name' })

      if (error) {
        console.error('[SaveFood] DB error:', error.message)
        return res.status(500).json({ error: 'Failed to save food' })
      }

      console.log(`[SaveFood] Saved: "${recipeName}" [${source}]`)

      // Calculate display totals for composite
      const displayTotals = isComposite && totalWeightG ? {
        calories: Math.round(nutrientsPer100g.calories * totalWeightG / 100),
        protein: Math.round(nutrientsPer100g.protein * totalWeightG / 100 * 10) / 10,
        carbs: Math.round(nutrientsPer100g.carbs * totalWeightG / 100 * 10) / 10,
        fat: Math.round(nutrientsPer100g.fat * totalWeightG / 100 * 10) / 10,
        fiber: Math.round(nutrientsPer100g.fiber * totalWeightG / 100 * 10) / 10,
      } : null

      return res.json({
        status: 'saved',
        message: isComposite
          ? `Saved "${recipeName}" (${resolvedItems.length} ingredients, ${displayTotals?.calories ?? 0} cal total)`
          : `Saved "${recipeName}" to your foods!`,
        food: {
          name: recipeName,
          nutrients_per_100g: nutrientsPer100g,
          ingredients: ingredientsJson,
          total_weight_g: totalWeightG,
          totals: displayTotals,
          source,
        },
      })
    }

    // ─── DELETE: remove by id ───────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id as string
      if (!id) return res.status(400).json({ error: 'Missing query param: id' })

      const { error } = await supabase.from('my_foods').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ success: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[SaveFood] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
