import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const HAIKU = 'anthropic/claude-haiku-4-5'
const SONNET = 'anthropic/claude-sonnet-4-6'

function getSystemPrompt(): string {
  // Vercel bundles includeFiles relative to project root
  // Try multiple resolution strategies
  const paths = [
    resolve(process.cwd(), 'config', 'system_prompt.txt'),
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'system_prompt.txt'),
  ]
  for (const p of paths) {
    try { return readFileSync(p, 'utf-8') } catch { /* try next */ }
  }
  throw new Error('system_prompt.txt not found')
}

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
    const systemPrompt = getSystemPrompt() + `

CURRENT CONTEXT:
- Current weight: ${currentWeight}kg
- Today's totals so far: ${todayCalories} cal, ${todayProtein}g protein
- Daily targets: ${settings.daily_calorie_target} cal, ${settings.daily_protein_target}g protein
- Saved recurring meals: ${recurringMeals.length ? recurringMeals.join('; ') : 'none yet'}`

    // Model selection: haiku for single-turn, sonnet for multi-turn
    const isMultiTurn = conversationHistory.length > 0
    const model = isMultiTurn ? SONNET : HAIKU

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
      return res.status(502).json({ error: 'AI service error' })
    }

    const aiData = await aiRes.json()
    const rawContent = aiData.choices?.[0]?.message?.content ?? ''

    // Parse AI JSON response
    let parsed: AiResponse
    try {
      // Extract JSON from possible markdown code blocks
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawContent]
      parsed = JSON.parse(jsonMatch[1]!.trim())
    } catch {
      console.error('Failed to parse AI response:', rawContent)
      return res.status(502).json({ error: 'Failed to parse AI response', raw: rawContent })
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
  } catch (err) {
    console.error('Handler error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
