import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'google/gemini-2.5-flash-lite'

const SYSTEM_PROMPT = `You are a nutrition logging assistant for a specific user.
Your job is to parse meal descriptions into structured nutritional data and help the user track their diet.

USER PROFILE:
- Male, 185cm, weight is dynamic (fetched from DB — use provided value)
- Goal: adequate protein intake and clean, healthy eating
- Training: lifting weights 2-3x per week, beginner, health-focused
- Daily targets: ~145g protein, ~2400 calories (adjust if user updates)

DIETARY RULES (important for grading):
- Does NOT eat cow dairy. Sheep and goat dairy are fine.
- Avoids gluten and processed foods (not strict, but preferred)
- Cuisine context: Israeli/Mediterranean home cooking is typical

BEHAVIOR:
1. When the user describes a meal, decide if you have enough info to estimate macros confidently.
   - If yes: respond with a JSON object (see schema below)
   - If no: ask ONE concise clarifying question, then wait
   - Never ask more than 2 clarifying questions before logging anyway
   - Simple meals (2 eggs, a banana, coffee): always log immediately

2. If the user types a name matching a recurring meal (e.g. "my usual breakfast", "the green smoothie"): log it immediately using the provided recurring meal data, no clarification needed.

3. If the user has logged a very similar meal 3+ times and it has no saved name, proactively suggest saving it as a recurring meal.

4. If the user says "save this as X" or "call it X": respond with status "save_recurring" and the full nutritional data.

5. If the user says "update my X" or "change X to include Y": respond with status "update_recurring".

HEALTH GRADING (health_grade field: A/B/C/D/F):
- A: protein-dense, whole foods, fits dietary rules
- B: good meal, minor concerns (some processing, low protein)
- C: acceptable nutrition, notable concerns
- D: poor nutritional profile or significant rule violations
- F: mostly junk, heavy processing, multiple violations

ESTIMATION APPROACH:
- Be confident, not hedgy. Make a reasonable estimate.
- For Israeli/Mediterranean dishes use typical local recipes
- For home cooking, assume moderate oil use unless stated otherwise
- Protein is the most important macro to get right

OUTPUT SCHEMA (always respond with valid JSON, nothing else):

For a loggable entry:
{"status":"ready_to_log","meal_description":"string","ingredients":[{"name":"string","amount":"string"}],"calories":number,"protein_g":number,"fiber_g":number,"carbs_g":number,"fat_g":number,"health_grade":"A|B|C|D|F","grade_reasoning":"string (1-2 sentences)","notes":"string|null"}

For clarification needed:
{"status":"needs_clarification","question":"string"}

For saving a recurring meal:
{"status":"save_recurring","suggested_name":"string","meal_description":"string","ingredients":[...],"calories":number,"protein_g":number,"fiber_g":number,"carbs_g":number,"fat_g":number,"health_grade":"A|B|C|D|F"}

For updating a recurring meal:
{"status":"update_recurring","name":"string","meal_description":"string","ingredients":[...],"calories":number,"protein_g":number,"fiber_g":number,"carbs_g":number,"fat_g":number,"health_grade":"A|B|C|D|F"}`

interface Ingredient {
  name: string
  amount: string
}

interface AiResponse {
  status: 'ready_to_log' | 'needs_clarification' | 'save_recurring' | 'update_recurring'
  meal_description?: string
  ingredients?: Ingredient[]
  calories?: number
  protein_g?: number
  fiber_g?: number
  carbs_g?: number
  fat_g?: number
  health_grade?: string
  grade_reasoning?: string
  notes?: string | null
  question?: string
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
    const { message, conversationHistory = [] } = req.body as {
      message: string
      conversationHistory: ChatMessage[]
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

    const aiRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://nutrilog.vercel.app',
        'X-Title': 'NutriLog',
      },
      body: JSON.stringify({ model, messages }),
    })

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
      const { data: entry, error } = await supabase
        .from('nutrition_log')
        .insert({
          raw_input: message,
          meal_description: parsed.meal_description,
          ingredients_json: parsed.ingredients,
          calories: parsed.calories,
          protein_g: parsed.protein_g,
          fiber_g: parsed.fiber_g,
          carbs_g: parsed.carbs_g,
          fat_g: parsed.fat_g,
          health_grade: parsed.health_grade,
          grade_reasoning: parsed.grade_reasoning,
        })
        .select()
        .single()

      if (error) {
        console.error('DB insert error:', error)
        return res.status(500).json({ error: 'Failed to save entry' })
      }

      return res.json({
        status: 'ready_to_log',
        message: parsed.notes || 'Meal logged!',
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

      // Save to recurring_meals
      await supabase.from('recurring_meals').insert({
        name,
        meal_description: parsed.meal_description,
        ingredients_json: parsed.ingredients,
        calories: parsed.calories,
        protein_g: parsed.protein_g,
        fiber_g: parsed.fiber_g,
        carbs_g: parsed.carbs_g,
        fat_g: parsed.fat_g,
        health_grade: parsed.health_grade,
      })

      // Also log to nutrition_log
      const { data: entry } = await supabase
        .from('nutrition_log')
        .insert({
          raw_input: message,
          meal_description: parsed.meal_description,
          ingredients_json: parsed.ingredients,
          calories: parsed.calories,
          protein_g: parsed.protein_g,
          fiber_g: parsed.fiber_g,
          carbs_g: parsed.carbs_g,
          fat_g: parsed.fat_g,
          health_grade: parsed.health_grade,
          grade_reasoning: parsed.grade_reasoning,
          recurring_meal_ref: name,
        })
        .select()
        .single()

      return res.json({
        status: 'save_recurring',
        message: `Saved "${name}" as a recurring meal and logged it!`,
        logged_entry: entry,
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
          health_grade: parsed.health_grade,
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
