import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'google/gemini-2.5-flash-lite-preview'

const SYSTEM_PROMPT = `You are a meal-ingredient extraction assistant for a nutrition tracker.
Your ONLY job is to parse a meal description into a list of individual ingredients with estimated gram weights.
You do NOT calculate calories, protein, or any macros — that is handled by a separate lookup step.

USER PROFILE:
- Male, 185cm, weight is dynamic (provided at runtime)
- Goal: adequate protein intake and clean, healthy eating
- Training: lifting weights 2-3x per week, beginner, health-focused
- Cuisine context: Israeli/Mediterranean home cooking is typical

DIETARY CONTEXT (for accurate ingredient guessing):
- Does NOT eat cow dairy. Sheep and goat dairy are fine.
- Avoids gluten and processed foods (not strict, but preferred)

LANGUAGE:
- The user writes in Hebrew, English, or a mix of both (e.g., "200g chicken פרגית").
- Understand Hebrew and mixed-language input naturally.
- All JSON output fields MUST be in English.
- For Israeli/Middle-Eastern foods with no standard English name, transliterate (e.g., לבנה → "labneh", פרגית → "chicken thigh/pargiyot", חומוס → "hummus", טחינה → "tahini").
- When the user mixes languages, parse both parts: "200g chicken פרגית" → food_name: "chicken thigh (pargiyot)", quantity_grams: 200.
- Clarification questions: respond in the same language the user used.

PORTION DEFAULTS:
- 1 egg = 50g, 1 chicken breast = 160g, 1 slice bread = 35g
- A bowl = 300ml, a plate = moderate adult serving
- A handful of nuts = 30g, olive oil for cooking = 15g
- 1 pita = 60g, 1 cup rice (cooked) = 200g
- 1 slice cheese = 28g, 1 tablespoon oil/butter = 14g
- When the user says "a slice" or "a piece", use the standard weight for that food item.

BEHAVIOR:
1. When the user describes a meal, break it down into ALL individual ingredients with gram weights.
   - Include cooking fats (oil, butter) even if not explicitly mentioned for cooked dishes.
   - Decompose composite dishes into their components (e.g., shakshuka → tomatoes, eggs, onion, oil, spices).
   - If an ingredient is clearly stated with a weight, use that weight exactly.
   - If no weight is given, use reasonable defaults from PORTION DEFAULTS or common sense.

2. If the input is too vague to determine the ingredients (e.g., "food", "something I ate"):
   - Respond with needs_clarification and ask ONE concise question.
   - Never ask more than 1 clarifying question — if still unclear, make your best guess.
   - Simple meals (2 eggs, a banana, coffee): always parse immediately, never ask for clarification.

FEW-SHOT EXAMPLES:

User: "2 scrambled eggs with toast"
Response:
{"status":"parsed","items":[{"food_name":"egg","quantity_grams":100},{"food_name":"white bread","quantity_grams":35},{"food_name":"butter","quantity_grams":5}]}

User: "shakshuka with 2 pitas and hummus"
Response:
{"status":"parsed","items":[{"food_name":"canned crushed tomatoes","quantity_grams":200},{"food_name":"egg","quantity_grams":100},{"food_name":"onion","quantity_grams":50},{"food_name":"bell pepper","quantity_grams":40},{"food_name":"olive oil","quantity_grams":15},{"food_name":"pita bread","quantity_grams":120},{"food_name":"hummus","quantity_grams":80}]}

User: "a big bowl of pasta with meat sauce"
Response:
{"status":"parsed","items":[{"food_name":"spaghetti (cooked)","quantity_grams":300},{"food_name":"ground beef","quantity_grams":150},{"food_name":"canned crushed tomatoes","quantity_grams":150},{"food_name":"onion","quantity_grams":40},{"food_name":"olive oil","quantity_grams":15},{"food_name":"parmesan cheese","quantity_grams":15}]}

OUTPUT CONTRACT (always respond with valid JSON, nothing else):

For parseable input:
{"status":"parsed","items":[{"food_name":"string","quantity_grams":number}]}

For clarification needed:
{"status":"needs_clarification","question":"string"}`

interface ParsedItem {
  food_name: string
  quantity_grams: number
}

interface AiResponse {
  status: 'parsed' | 'needs_clarification' | 'ready_to_log' | 'save_recurring' | 'update_recurring'
  items?: ParsedItem[]
  question?: string
  // Legacy fields still used by DB write logic (Phase 3 will refactor these)
  meal_description?: string
  ingredients?: { name: string; amount: string }[]
  calories?: number
  protein_g?: number
  fiber_g?: number
  carbs_g?: number
  fat_g?: number
  notes?: string | null
  suggested_name?: string
  name?: string
}

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

    const recurringMeals = (recurringRes.data ?? [])
      .map((m: { name: string; aliases: string[] | null }) =>
        m.aliases?.length ? `${m.name} (aliases: ${m.aliases.join(', ')})` : m.name
      )

    // Build system message with runtime context
    const systemPrompt = SYSTEM_PROMPT + `

CURRENT CONTEXT:
- Current weight: ${currentWeight}kg
- Today's totals so far: ${todayCalories} cal, ${todayProtein}g protein
- Daily targets: ${settings.daily_calorie_target} cal, ${settings.daily_protein_target}g protein
- Saved recurring meals: ${recurringMeals.length ? recurringMeals.join('; ') : 'none yet'}`

    // Model selection: haiku for single-turn, sonnet for multi-turn
    const model = MODEL

    // Build messages (cap at 6)
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
        body: JSON.stringify({ model, messages, temperature: 0.1 }),
      })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === 'AbortError') {
        return res.status(504).json({ error: 'AI response timed out — try a shorter message or try again' })
      }
      throw err
    }
    clearTimeout(timeout)

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      console.error('OpenRouter error:', errText)
      return res.status(502).json({ error: `AI service error: ${aiRes.status} ${errText.slice(0, 200)}` })
    }

    const aiData = await aiRes.json()
    const rawContent = aiData.choices?.[0]?.message?.content ?? ''

    // Parse AI JSON response — try multiple extraction strategies
    let parsed: AiResponse
    try {
      // Strategy 1: code block
      const codeBlock = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/)
      // Strategy 2: first { to last }
      const braceMatch = rawContent.match(/\{[\s\S]*\}/)
      const jsonStr = codeBlock?.[1]?.trim() ?? braceMatch?.[0] ?? rawContent.trim()
      parsed = JSON.parse(jsonStr)
    } catch {
      console.error('Failed to parse AI response:', rawContent)
      return res.status(502).json({ error: `Failed to parse AI response: ${rawContent.slice(0, 300)}` })
    }

    // Handle DB writes based on status
    if (parsed.status === 'ready_to_log') {
      const entryData = {
        raw_input: message,
        meal_description: parsed.meal_description,
        ingredients_json: parsed.ingredients,
        calories: parsed.calories,
        protein_g: parsed.protein_g,
        fiber_g: parsed.fiber_g,
        carbs_g: parsed.carbs_g,
        fat_g: parsed.fat_g,
      }

      let entry, error
      if (lastEntryId) {
        // Amend existing entry
        ;({ data: entry, error } = await supabase
          .from('nutrition_log')
          .update(entryData)
          .eq('id', lastEntryId)
          .select()
          .single())
      } else {
        // New entry
        ;({ data: entry, error } = await supabase
          .from('nutrition_log')
          .insert(entryData)
          .select()
          .single())
      }

      if (error) {
        console.error('DB error:', error)
        return res.status(500).json({ error: 'Failed to save entry' })
      }

      return res.json({
        status: 'ready_to_log',
        message: lastEntryId ? 'Meal updated!' : (parsed.notes || 'Meal logged!'),
        logged_entry: entry,
      })
    }

    if (parsed.status === 'needs_clarification') {
      return res.json({
        status: 'needs_clarification',
        message: parsed.question,
      })
    }

    if (parsed.status === 'save_recurring') {
      const name = parsed.suggested_name ?? parsed.name ?? 'Unnamed meal'

      // Use macros from the already-logged entry if available, otherwise fall back to AI response
      let macros = {
        meal_description: parsed.meal_description,
        ingredients_json: parsed.ingredients,
        calories: parsed.calories,
        protein_g: parsed.protein_g,
        fiber_g: parsed.fiber_g,
        carbs_g: parsed.carbs_g,
        fat_g: parsed.fat_g,
      }

      if (lastEntryId) {
        const { data: existing } = await supabase
          .from('nutrition_log')
          .select('meal_description, ingredients_json, calories, protein_g, fiber_g, carbs_g, fat_g')
          .eq('id', lastEntryId)
          .single()
        if (existing) {
          macros = existing
        }
      }

      // Save to recurring_meals (don't create a duplicate nutrition_log entry)
      await supabase.from('recurring_meals').insert({
        name,
        ...macros,
      })

      return res.json({
        status: 'save_recurring',
        message: `Saved "${name}" as a recurring meal!`,
      })
    }

    if (parsed.status === 'update_recurring') {
      const name = parsed.name ?? ''

      const { error } = await supabase
        .from('recurring_meals')
        .update({
          meal_description: parsed.meal_description,
          ingredients_json: parsed.ingredients,
          calories: parsed.calories,
          protein_g: parsed.protein_g,
          fiber_g: parsed.fiber_g,
          carbs_g: parsed.carbs_g,
          fat_g: parsed.fat_g,
          updated_at: new Date().toISOString(),
        })
        .eq('name', name)

      if (error) {
        console.error('Recurring meal update error:', error)
        return res.status(500).json({ error: 'Failed to update recurring meal' })
      }

      return res.json({
        status: 'update_recurring',
        message: `Updated "${name}"!`,
      })
    }

    // Fallback
    return res.json({ status: parsed.status, message: rawContent })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
