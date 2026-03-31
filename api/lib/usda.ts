import { createClient } from '@supabase/supabase-js'
import type { NutrientsPer100g } from './types'

const USDA_API_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'

// Nutrient IDs in USDA FoodData Central
const NUTRIENT_IDS = {
  ENERGY: 1008,
  PROTEIN: 1003,
  CARBS: 1005,
  FAT: 1004,
  FIBER: 1079,
} as const

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  )
}

function extractNutrient(nutrients: Array<{ nutrientId: number; value: number }>, id: number): number {
  return nutrients.find(n => n.nutrientId === id)?.value ?? 0
}

/**
 * Search USDA FoodData Central for nutrition data per 100g.
 * Checks usda_cache first, then hits the API on cache miss.
 */
export async function searchUSDA(foodName: string): Promise<NutrientsPer100g | null> {
  const supabase = getSupabase()
  const searchTerm = foodName.toLowerCase().trim()

  // Check cache first (case-insensitive via lowercased search_term)
  const { data: cached, error: cacheError } = await supabase
    .from('usda_cache')
    .select('nutrients_per_100g')
    .ilike('search_term', searchTerm)
    .limit(1)
    .maybeSingle()

  if (cacheError) {
    console.log('[USDA] Cache lookup error:', cacheError.message)
  }

  if (cached) {
    console.log(`[USDA] Cache hit for "${searchTerm}"`)
    return cached.nutrients_per_100g as NutrientsPer100g
  }

  // Cache miss — call USDA API
  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY'
  const url = `${USDA_API_URL}?query=${encodeURIComponent(foodName)}&pageSize=1&dataType=Foundation,SR%20Legacy&api_key=${apiKey}`

  console.log(`[USDA] API call for "${foodName}"`)

  try {
    const response = await fetch(url)

    if (!response.ok) {
      console.log(`[USDA] API error: ${response.status} ${response.statusText}`)
      return null
    }

    const data = (await response.json()) as { foods?: Array<{ fdcId?: number; foodCategory?: string; foodNutrients?: Array<{ nutrientId: number; value: number }> }> }
    const foods = data.foods

    if (!foods || foods.length === 0) {
      console.log(`[USDA] No results for "${foodName}"`)
      return null
    }

    const food = foods[0]
    const nutrients = food.foodNutrients ?? []

    const result: NutrientsPer100g = {
      calories: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.ENERGY)),
      protein: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.PROTEIN) * 10) / 10,
      carbs: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.CARBS) * 10) / 10,
      fat: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.FAT) * 10) / 10,
      fiber: Math.round(extractNutrient(nutrients, NUTRIENT_IDS.FIBER) * 10) / 10,
    }

    // Cache the result
    const { error: insertError } = await supabase.from('usda_cache').insert({
      fdc_id: food.fdcId ?? null,
      search_term: searchTerm,
      nutrients_per_100g: result,
      food_category: food.foodCategory ?? null,
    })

    if (insertError) {
      console.log('[USDA] Cache insert error:', insertError.message)
    } else {
      console.log(`[USDA] Cached result for "${searchTerm}"`)
    }

    return result
  } catch (err) {
    console.log(`[USDA] Fetch error:`, err instanceof Error ? err.message : err)
    return null
  }
}
