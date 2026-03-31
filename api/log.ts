import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { classifyInput } from './lib/modificationClassifier'
import { resolveIngredients } from './lib/resolver'
import { calculateTotals, atwaterCheck, atwaterCorrect } from './lib/validation'
import { findRecurringMeal } from './lib/personalDb'
import type { LLMParsedItem, ResolvedIngredient, NutrientsPer100g, SourceTier } from './lib/types'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STAGE1_MODEL = 'google/gemini-2.5-flash-lite-preview'

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

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { message, conversationHistory = [], lastEntryId } = req.body as {
      message: string
      conversationHistory: ChatMessage[]
      lastEntryId?: string
    }

    if (!message) {
      return res.status(400).json({ error: 'message is required' })
    }

    console.log(`[LogAPI] Input: "${message}"`)

    // Fetch context in parallel
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

    // Build list of saved meal names for classifier
    const savedMeals = (recurringRes.data ?? []) as { name: string; aliases: string[] | null }[]
    const savedMealNames = savedMeals.flatMap(m => [m.name, ...(m.aliases ?? [])])

    // --- STEP 1: Classify input ---
    const classification = classifyInput(message, savedMealNames)

    // --- STEP 2: Handle based on classification ---

    // EXACT_MATCH: log from recurring meal, zero tokens
    if (classification.classification === 'EXACT_MATCH' && classification.matchedMeal) {
      const meal = await findRecurringMeal(classification.matchedMeal)
      if (meal) {
        console.log(`[LogAPI] Exact match: "${classification.matchedMeal}"`)
        return await logFromRecurringMeal(res, message, meal, lastEntryId)
      }
      // If not found in DB (shouldn't happen), fall through to NEW_MEAL
    }

    // REMOVE: filter ingredients from recurring meal
    if (classification.classification === 'REMOVE' && classification.matchedMeal) {
      const meal = await findRecurringMeal(classification.matchedMeal)
      if (meal && meal.ingredients_json) {
        console.log(`[LogAPI] Remove modifier on: "${classification.matchedMeal}"`)
        const ingredients = meal.ingredients_json as Array<{ name: string; amount: string }>
        const modifier = (classification.modifier ?? '').toLowerCase()
        // Filter out ingredients that match the remove keyword
        const filtered = ingredients.filter(ing => !modifier.includes(ing.name.toLowerCase()))
        // For now, log the recurring meal as-is but note the modification
        // Full ingredient-level recalculation requires the ingredients to have per_100g data
        // which legacy recurring_meals don't have. Fall through to NEW_MEAL for re-parsing.
      }
      // Fall through — legacy recurring_meals don't have per_100g data for recalculation
    }

    // QUANTITY: handled similarly — fall through for now
    // ADD_SUBSTITUTE: needs LLM for new ingredient — fall through to parse

    // --- STEP 3: NEW_MEAL (or fallthrough) — Stage 1 LLM Parse ---
    const stage1Result = await callStage1LLM(message, conversationHistory, currentWeight, settings, savedMeals)

    if (!stage1Result) {
      return res.status(502).json({ error: 'Failed to get AI response' })
    }

    // Handle clarification
    if (stage1Result.status === 'needs_clarification') {
      return res.json({
        status: 'needs_clarification',
        message: stage1Result.question,
      })
    }

    if (stage1Result.status !== 'parsed' || !stage1Result.items?.length) {
      console.log('[LogAPI] Unexpected Stage 1 result:', JSON.stringify(stage1Result))
      return res.status(502).json({ error: 'AI returned unexpected format' })
    }

    console.log(`[LogAPI] Stage 1 parsed ${stage1Result.items.length} items`)

    // --- STEP 4: Resolve ingredients (Tier 1 → 2 → 3) ---
    const resolvedItems = await resolveIngredients(stage1Result.items)

    // --- STEP 5: Calculate totals & validate ---
    let totals = calculateTotals(resolvedItems)
    if (!atwaterCheck(totals)) {
      console.log('[LogAPI] Atwater check failed, correcting calories')
      totals = atwaterCorrect(totals)
    }

    // Determine source tier
    const sources = new Set(resolvedItems.map(i => i.source))
    const sourceTier: SourceTier = sources.size === 1 ? resolvedItems[0].source : 'mixed'

    // Build meal description from ingredients
    const mealDescription = resolvedItems.map(i => `${i.food_name} (${i.weight_g}g)`).join(', ')

    // --- STEP 6: Write to DB ---
    const entryData = {
      raw_input: message,
      meal_description: mealDescription,
      ingredients_json: resolvedItems.map(i => ({ name: i.food_name, amount: `${i.weight_g}g` })),
      calories: totals.calories,
      protein_g: totals.protein,
      fiber_g: totals.fiber,
      carbs_g: totals.carbs,
      fat_g: totals.fat,
      ingredients: resolvedItems,
      source_tier: sourceTier,
    }

    let entry, error
    if (lastEntryId) {
      ;({ data: entry, error } = await supabase
        .from('nutrition_log')
        .update(entryData)
        .eq('id', lastEntryId)
        .select()
        .single())
    } else {
      ;({ data: entry, error } = await supabase
        .from('nutrition_log')
        .insert(entryData)
        .select()
        .single())
    }

    if (error) {
      console.error('[LogAPI] DB error:', error)
      return res.status(500).json({ error: 'Failed to save entry' })
    }

    console.log(`[LogAPI] Logged: ${totals.calories} cal, ${totals.protein}g protein [${sourceTier}]`)

    return res.json({
      status: 'ready_to_log',
      message: lastEntryId ? 'Meal updated!' : 'Meal logged!',
      logged_entry: entry,
    })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[LogAPI] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}

// --- Helper: Log from a recurring meal (zero LLM tokens) ---

async function logFromRecurringMeal(
  res: VercelResponse,
  rawInput: string,
  meal: Record<string, unknown>,
  lastEntryId?: string,
) {
  const entryData = {
    raw_input: rawInput,
    meal_description: meal.meal_description as string,
    ingredients_json: meal.ingredients_json,
    calories: meal.calories as number,
    protein_g: meal.protein_g as number,
    fiber_g: meal.fiber_g as number,
    carbs_g: meal.carbs_g as number,
    fat_g: meal.fat_g as number,
    recurring_meal_ref: meal.name as string,
    source_tier: 'personal' as SourceTier,
  }

  let entry, error
  if (lastEntryId) {
    ;({ data: entry, error } = await supabase
      .from('nutrition_log')
      .update(entryData)
      .eq('id', lastEntryId)
      .select()
      .single())
  } else {
    ;({ data: entry, error } = await supabase
      .from('nutrition_log')
      .insert(entryData)
      .select()
      .single())
  }

  if (error) {
    console.error('[LogAPI] DB error (recurring):', error)
    return res.status(500).json({ error: 'Failed to save entry' })
  }

  console.log(`[LogAPI] Logged recurring "${meal.name}" — zero tokens`)

  return res.json({
    status: 'ready_to_log',
    message: `Logged "${meal.name}"!`,
    logged_entry: entry,
  })
}

// --- Helper: Stage 1 LLM call ---

interface Stage1Result {
  status: 'parsed' | 'needs_clarification'
  items?: LLMParsedItem[]
  question?: string
}

async function callStage1LLM(
  message: string,
  conversationHistory: ChatMessage[],
  currentWeight: number,
  settings: { daily_calorie_target: number; daily_protein_target: number },
  savedMeals: { name: string; aliases: string[] | null }[],
): Promise<Stage1Result | null> {
  const mealList = savedMeals
    .map(m => m.aliases?.length ? `${m.name} (aliases: ${m.aliases.join(', ')})` : m.name)

  const systemPrompt = STAGE1_SYSTEM_PROMPT + `

CURRENT CONTEXT:
- Current weight: ${currentWeight}kg
- Daily targets: ${settings.daily_calorie_target} cal, ${settings.daily_protein_target}g protein
- Saved recurring meals: ${mealList.length ? mealList.join('; ') : 'none yet'}`

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-5),
    { role: 'user', content: message },
  ]

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 50_000)

  let aiRes: Response
  try {
    aiRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://nutrilog.vercel.app',
        'X-Title': 'NutriLog',
      },
      body: JSON.stringify({
        model: STAGE1_MODEL,
        messages,
        temperature: 0.1,
      }),
    })
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') {
      console.error('[LogAPI] Stage 1 LLM timeout')
      return null
    }
    throw err
  }
  clearTimeout(timeout)

  if (!aiRes.ok) {
    const errText = await aiRes.text()
    console.error('[LogAPI] OpenRouter error:', errText.slice(0, 200))
    return null
  }

  const aiData = await aiRes.json()
  const rawContent = aiData.choices?.[0]?.message?.content ?? ''

  try {
    const codeBlock = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/)
    const braceMatch = rawContent.match(/\{[\s\S]*\}/)
    const jsonStr = codeBlock?.[1]?.trim() ?? braceMatch?.[0] ?? rawContent.trim()
    return JSON.parse(jsonStr) as Stage1Result
  } catch {
    console.error('[LogAPI] Failed to parse Stage 1 response:', rawContent.slice(0, 300))
    return null
  }
}
