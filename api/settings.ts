import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'GET') {
      console.log('[Settings] GET — fetching settings + weight log')

      const [settingsRes, weightRes] = await Promise.all([
        supabase.from('user_settings').select('*').eq('id', 1).single(),
        supabase.from('weight_log').select('*').order('logged_at', { ascending: false }).limit(5),
      ])

      if (settingsRes.error) {
        console.log('[Settings] GET settings error:', settingsRes.error.message)
        return res.status(500).json({ error: settingsRes.error.message })
      }

      console.log('[Settings] GET OK — settings:', settingsRes.data, 'weight entries:', weightRes.data?.length ?? 0)
      return res.json({ settings: settingsRes.data, weight_log: weightRes.data ?? [] })
    }

    if (req.method === 'PUT') {
      const { daily_protein_target, daily_calorie_target } = req.body as {
        daily_protein_target?: number; daily_calorie_target?: number
      }

      console.log('[Settings] PUT — updating settings:', { daily_protein_target, daily_calorie_target })

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (daily_protein_target !== undefined) updates.daily_protein_target = daily_protein_target
      if (daily_calorie_target !== undefined) updates.daily_calorie_target = daily_calorie_target

      const { data, error } = await supabase
        .from('user_settings')
        .upsert({ id: 1, ...updates })
        .select()
        .single()

      if (error) {
        console.log('[Settings] PUT error:', error.message)
        return res.status(500).json({ error: error.message })
      }

      console.log('[Settings] PUT OK:', data)
      return res.json({ settings: data })
    }

    if (req.method === 'POST') {
      const { weight_kg } = req.body as { weight_kg: number }

      if (!weight_kg || typeof weight_kg !== 'number') {
        console.log('[Settings] POST — invalid weight_kg:', weight_kg)
        return res.status(400).json({ error: 'weight_kg is required and must be a number' })
      }

      console.log('[Settings] POST — logging weight:', weight_kg)

      const { data, error } = await supabase
        .from('weight_log')
        .insert({ weight_kg })
        .select()
        .single()

      if (error) {
        console.log('[Settings] POST error:', error.message)
        return res.status(500).json({ error: error.message })
      }

      console.log('[Settings] POST OK:', data)
      return res.json({ weight_entry: data })
    }

    return res.status(405).json({ error: 'Method not allowed' })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Settings] Handler error:', msg)
    return res.status(500).json({ error: msg })
  }
}
