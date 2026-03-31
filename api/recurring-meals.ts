import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    // ─── GET: list all recurring meals ────────────────────────────────
    if (req.method === 'GET') {
      console.log('[RecurringMeals] GET all')
      const { data, error } = await supabase
        .from('recurring_meals')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        console.log('[RecurringMeals] GET error:', error.message)
        return res.status(500).json({ error: error.message })
      }

      console.log(`[RecurringMeals] Returned ${data.length} meals`)
      return res.json(data)
    }

    // ─── POST: create a new recurring meal ────────────────────────────
    if (req.method === 'POST') {
      const {
        name, meal_description, aliases, ingredients_json,
        calories, protein_g, fiber_g, carbs_g, fat_g, health_grade,
      } = req.body as {
        name: string
        meal_description?: string
        aliases?: string[]
        ingredients_json?: unknown
        calories: number
        protein_g: number
        fiber_g: number
        carbs_g: number
        fat_g: number
        health_grade?: string
      }

      if (!name || calories == null || protein_g == null || fiber_g == null || carbs_g == null || fat_g == null) {
        return res.status(400).json({ error: 'Missing required fields: name, calories, protein_g, fiber_g, carbs_g, fat_g' })
      }

      console.log(`[RecurringMeals] POST: "${name}"`)

      const { data, error } = await supabase
        .from('recurring_meals')
        .insert({
          name,
          meal_description: meal_description ?? null,
          aliases: aliases ?? null,
          ingredients_json: ingredients_json ?? null,
          calories,
          protein_g,
          fiber_g,
          carbs_g,
          fat_g,
          health_grade: health_grade ?? null,
        })
        .select()
        .single()

      if (error) {
        console.log('[RecurringMeals] POST error:', error.message)
        return res.status(500).json({ error: error.message })
      }

      console.log(`[RecurringMeals] Created: "${name}" (${data.id})`)
      return res.status(201).json(data)
    }

    // ─── DELETE: remove by id ─────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id as string
      if (!id) return res.status(400).json({ error: 'Missing query param: id' })

      console.log(`[RecurringMeals] DELETE: ${id}`)

      const { error } = await supabase
        .from('recurring_meals')
        .delete()
        .eq('id', id)

      if (error) {
        console.log('[RecurringMeals] DELETE error:', error.message)
        return res.status(500).json({ error: error.message })
      }

      console.log(`[RecurringMeals] Deleted: ${id}`)
      return res.json({ success: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[RecurringMeals] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
