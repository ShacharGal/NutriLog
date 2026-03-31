import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Test 1: basic imports
    const { classifyInput } = await import('./_lib/modificationClassifier')
    const { resolveIngredients } = await import('./_lib/resolver')
    const { calculateTotals } = await import('./_lib/validation')

    res.json({
      ok: true,
      imports: 'all loaded',
      classifyInput: typeof classifyInput,
      resolveIngredients: typeof resolveIngredients,
      calculateTotals: typeof calculateTotals,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.stack : String(err)
    res.status(500).json({ error: msg })
  }
}
