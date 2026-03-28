import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { days, since, until } = req.query

    let query = supabase
      .from('nutrition_log')
      .select('*')
      .order('created_at', { ascending: false })

    if (days) {
      const d = new Date()
      d.setDate(d.getDate() - Number(days))
      query = query.gte('created_at', d.toISOString())
    } else if (since) {
      query = query.gte('created_at', String(since))
      if (until) {
        query = query.lte('created_at', String(until))
      }
    }

    const { data, error } = await query

    if (error) {
      console.error('[entries] Supabase error:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.json({ entries: data })
  } catch (err) {
    console.error('[entries] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
