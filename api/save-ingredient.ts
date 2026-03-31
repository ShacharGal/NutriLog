import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

// ─── Types ───────────────────────────────────────────────────────────────────

interface NutrientsPer100g {
  calories: number; protein: number; carbs: number; fat: number; fiber: number
}

interface LLMParsedItem {
  food_name: string; quantity_grams: number
}

interface SavedIngredient {
  name: string; nutrients_per_100g: NutrientsPer100g; source: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STAGE1_MODEL = 'google/gemini-2.5-flash-lite'
const FALLBACK_MODEL = 'openai/gpt-4o-mini'

const USDA_API_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const NUTRIENT_IDS = { ENERGY: 1008, PROTEIN: 1003, CARBS: 1005, FAT: 1004, FIBER: 1079 } as const

const PARSE_SYSTEM_PROMPT = `You are an ingredient extraction assistant. Your job is to parse a food description into individual ingredients with gram weights.

RULES:
- Break composite foods into their components (e.g., "shakshuka" → tomatoes, eggs, onion, oil, etc.)
- Simple single ingredients (e.g., "chicken breast", "banana") → return as-is with a default 100g weight
- All output must be in English. Transliterate Hebrew/Arabic food names.
- If too vague to identify, respond with needs_clarification.

OUTPUT (valid JSON only):
{"status":"parsed","items":[{"food_name":"string","quantity_grams":number}]}
{"status":"needs_clarification","question":"string"}`

// ─── Helpers (duplicated from log.ts — Vercel single-file constraint) ───────

function clampNutrients(p: NutrientsPer100g): NutrientsPer100g {
  const c = (v: number, max: number) => Math.max(0, Math.min(v, max))
  return { calories: c(p.calories, 2000), protein: c(p.protein, 200), carbs: c(p.carbs, 200), fat: c(p.fat, 200), fiber: c(p.fiber, 200) }
}

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
    console.log(`[SaveIngredient] USDA cache hit: "${searchTerm}"`)
    return cached.nutrients_per_100g as NutrientsPer100g
  }

  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY'
  const url = `${USDA_API_URL}?query=${encodeURIComponent(queryTerm)}&pageSize=5&dataType=SR%20Legacy&api_key=${apiKey}`

  console.log(`[SaveIngredient] USDA API: "${queryTerm}"`)

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
    console.log(`[SaveIngredient] USDA error:`, err instanceof Error ? err.message : err)
    return null
  }
}

async function estimateNutritionLLM(foodName: string): Promise<NutrientsPer100g | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  console.log(`[SaveIngredient] LLM fallback: "${foodName}"`)
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

// ─── Stage 1: Parse input into ingredients ──────────────────────────────────

interface Stage1Result {
  status: 'parsed' | 'needs_clarification'
  items?: LLMParsedItem[]
  question?: string
}

async function parseIngredients(message: string): Promise<Stage1Result | null> {
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
          { role: 'user', content: message },
        ],
      }),
    })
  } catch (err) {
    clearTimeout(timeout)
    if ((err as Error).name === 'AbortError') console.error('[SaveIngredient] Stage 1 timeout')
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
    console.error('[SaveIngredient] Parse failed:', rawContent.slice(0, 300))
    return null
  }
}

// ─── Resolve & save each ingredient ─────────────────────────────────────────

async function resolveAndSave(items: LLMParsedItem[]): Promise<SavedIngredient[]> {
  const saved: SavedIngredient[] = []

  await Promise.all(items.map(async (item) => {
    const name = item.food_name
    let nutrients: NutrientsPer100g | null = null
    let source = 'usda'

    // Try USDA first
    nutrients = await searchUSDA(name)

    // Fallback to LLM
    if (!nutrients) {
      nutrients = await estimateNutritionLLM(name)
      source = 'llm'
    }

    if (!nutrients) {
      console.log(`[SaveIngredient] No data for "${name}", skipping`)
      return
    }

    nutrients = clampNutrients(nutrients)

    // Upsert into personal_ingredients (unique on user_id + name)
    const { error } = await supabase
      .from('personal_ingredients')
      .upsert(
        { name: name.toLowerCase(), nutrients_per_100g: nutrients, source, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,name' }
      )

    if (error) {
      console.error(`[SaveIngredient] DB error for "${name}":`, error.message)
      return
    }

    saved.push({ name: name.toLowerCase(), nutrients_per_100g: nutrients, source })
    console.log(`[SaveIngredient] Saved: "${name}" [${source}]`)
  }))

  return saved
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    // ─── GET: list all personal ingredients ─────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('personal_ingredients')
        .select('*')
        .order('name', { ascending: true })

      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }

    // ─── POST: parse + resolve + save ingredients ───────────────────────
    if (req.method === 'POST') {
      const { message } = req.body as { message: string }
      if (!message) return res.status(400).json({ error: 'message is required' })

      console.log(`[SaveIngredient] Input: "${message}"`)

      const parsed = await parseIngredients(message)
      if (!parsed) return res.status(502).json({ error: 'Failed to parse input' })

      if (parsed.status === 'needs_clarification') {
        return res.json({ status: 'needs_clarification', message: parsed.question })
      }

      if (!parsed.items?.length) {
        return res.status(502).json({ error: 'Could not identify any ingredients' })
      }

      console.log(`[SaveIngredient] Parsed ${parsed.items.length} items`)

      const saved = await resolveAndSave(parsed.items)

      if (!saved.length) {
        return res.json({ status: 'saved', message: 'Could not resolve nutritional data for these items.', ingredients: [] })
      }

      const names = saved.map(s => s.name).join(', ')
      return res.json({
        status: 'saved',
        message: saved.length === 1
          ? `Saved "${saved[0].name}" to your personal foods!`
          : `Saved ${saved.length} ingredients: ${names}`,
        ingredients: saved,
      })
    }

    // ─── DELETE: remove by id ───────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id as string
      if (!id) return res.status(400).json({ error: 'Missing query param: id' })

      const { error } = await supabase.from('personal_ingredients').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ success: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[SaveIngredient] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
