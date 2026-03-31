import type { LLMParsedItem, ResolvedIngredient, NutrientsPer100g } from '../types/nutrition'
import { searchUSDA } from './usda'
import { findPersonalIngredient } from './personalDb'
import { clampNutrients } from './validation'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const FALLBACK_MODEL = 'openai/gpt-4o-mini'

/**
 * Resolve a list of parsed items to full nutrition data.
 * Tries in order: Personal DB (Tier 1) → USDA (Tier 2) → returns null source for Tier 3.
 * Items with null source need LLM fallback (call estimateNutritionLLM separately).
 */
export async function resolveIngredients(
  items: LLMParsedItem[]
): Promise<ResolvedIngredient[]> {
  console.log(`[Resolver] Resolving ${items.length} items`)

  const results = await Promise.all(
    items.map(async (item): Promise<ResolvedIngredient> => {
      const foodName = item.food_name

      // Tier 1: Personal DB
      const personal = await findPersonalIngredient(foodName)
      if (personal) {
        console.log(`[Resolver] "${foodName}" → personal DB`)
        return {
          food_name: foodName,
          weight_g: item.quantity_grams,
          nutrients_per_100g: clampNutrients(personal.nutrients_per_100g),
          source: 'personal',
        }
      }

      // Tier 2: USDA
      const usda = await searchUSDA(foodName)
      if (usda) {
        console.log(`[Resolver] "${foodName}" → USDA`)
        return {
          food_name: foodName,
          weight_g: item.quantity_grams,
          nutrients_per_100g: clampNutrients(usda),
          source: 'usda',
        }
      }

      // Tier 3: LLM fallback (resolved here for completeness)
      console.log(`[Resolver] "${foodName}" → trying LLM fallback`)
      const llmResult = await estimateNutritionLLM(foodName)
      if (llmResult) {
        return {
          food_name: foodName,
          weight_g: item.quantity_grams,
          nutrients_per_100g: clampNutrients(llmResult),
          source: 'llm',
        }
      }

      // Last resort: zero nutrients (shouldn't normally happen)
      console.log(`[Resolver] "${foodName}" → no data found, using zeros`)
      return {
        food_name: foodName,
        weight_g: item.quantity_grams,
        nutrients_per_100g: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
        source: 'llm',
      }
    })
  )

  return results
}

/**
 * Tier 3 fallback: ask LLM to estimate nutrition per 100g for a food item.
 * Uses GPT-4o-mini via OpenRouter with low temperature for consistency.
 */
export async function estimateNutritionLLM(
  foodName: string
): Promise<NutrientsPer100g | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.log('[Resolver] No OPENROUTER_API_KEY, skipping LLM fallback')
    return null
  }

  console.log(`[Resolver] LLM fallback for "${foodName}"`)

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://nutrilog.vercel.app',
        'X-Title': 'NutriLog',
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              'You are a nutrition database. Return ONLY valid JSON, no other text.',
          },
          {
            role: 'user',
            content: `Estimate nutritional values per 100g for: ${foodName}. Return JSON: {"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number}`,
          },
        ],
      }),
    })

    if (!response.ok) {
      console.log(`[Resolver] LLM API error: ${response.status}`)
      return null
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const rawContent = data.choices?.[0]?.message?.content ?? ''

    // Parse JSON from response
    const braceMatch = rawContent.match(/\{[\s\S]*\}/)
    if (!braceMatch) {
      console.log('[Resolver] LLM response has no JSON:', rawContent.slice(0, 200))
      return null
    }

    const parsed = JSON.parse(braceMatch[0]) as Record<string, unknown>

    const result: NutrientsPer100g = {
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      carbs: Number(parsed.carbs) || 0,
      fat: Number(parsed.fat) || 0,
      fiber: Number(parsed.fiber) || 0,
    }

    console.log(`[Resolver] LLM estimate for "${foodName}":`, result)
    return clampNutrients(result)
  } catch (err) {
    console.log(`[Resolver] LLM fallback error:`, err instanceof Error ? err.message : err)
    return null
  }
}
