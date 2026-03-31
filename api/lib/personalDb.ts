import { createClient } from '@supabase/supabase-js'
import type { NutrientsPer100g } from './types'

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  )
}

// Hardcoded single-user ID for now
const USER_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Find a personal ingredient by name or alias (case-insensitive).
 */
export async function findPersonalIngredient(
  foodName: string
): Promise<{ nutrients_per_100g: NutrientsPer100g } | null> {
  const supabase = getSupabase()
  const term = foodName.trim()

  console.log(`[PersonalDB] Looking up ingredient: "${term}"`)

  // Check by name (ILIKE) or if term is in the aliases array
  const { data, error } = await supabase
    .from('personal_ingredients')
    .select('nutrients_per_100g')
    .eq('user_id', USER_ID)
    .or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.log('[PersonalDB] Ingredient lookup error:', error.message)
    return null
  }

  if (data) {
    console.log(`[PersonalDB] Found personal ingredient: "${term}"`)
    return { nutrients_per_100g: data.nutrients_per_100g as NutrientsPer100g }
  }

  console.log(`[PersonalDB] No personal ingredient found for: "${term}"`)
  return null
}

/**
 * Find a personal recipe by name or alias (case-insensitive).
 */
export async function findPersonalRecipe(
  mealName: string
): Promise<{
  name: string
  ingredients: unknown[]
  total_nutrients: NutrientsPer100g
  serving_weight_g: number
} | null> {
  const supabase = getSupabase()
  const term = mealName.trim()

  console.log(`[PersonalDB] Looking up recipe: "${term}"`)

  const { data, error } = await supabase
    .from('personal_recipes')
    .select('name, ingredients, total_nutrients, serving_weight_g')
    .eq('user_id', USER_ID)
    .or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.log('[PersonalDB] Recipe lookup error:', error.message)
    return null
  }

  if (data) {
    console.log(`[PersonalDB] Found personal recipe: "${data.name}"`)
    return {
      name: data.name,
      ingredients: (data.ingredients as unknown[]) ?? [],
      total_nutrients: data.total_nutrients as NutrientsPer100g,
      serving_weight_g: Number(data.serving_weight_g) || 0,
    }
  }

  console.log(`[PersonalDB] No personal recipe found for: "${term}"`)
  return null
}

/**
 * Find a recurring meal by name or alias (case-insensitive).
 * Backward-compatible with the existing recurring_meals table.
 */
export async function findRecurringMeal(
  mealName: string
): Promise<Record<string, unknown> | null> {
  const supabase = getSupabase()
  const term = mealName.trim()

  console.log(`[PersonalDB] Looking up recurring meal: "${term}"`)

  // Try exact name match first (ILIKE)
  const { data: byName, error: nameErr } = await supabase
    .from('recurring_meals')
    .select('*')
    .ilike('name', term)
    .limit(1)
    .maybeSingle()

  if (nameErr) {
    console.log('[PersonalDB] Recurring meal lookup error:', nameErr.message)
    return null
  }

  if (byName) {
    console.log(`[PersonalDB] Found recurring meal by name: "${byName.name}"`)
    return byName as Record<string, unknown>
  }

  // Try alias match
  const { data: byAlias, error: aliasErr } = await supabase
    .from('recurring_meals')
    .select('*')
    .contains('aliases', [term.toLowerCase()])
    .limit(1)
    .maybeSingle()

  if (aliasErr) {
    console.log('[PersonalDB] Recurring meal alias lookup error:', aliasErr.message)
    return null
  }

  if (byAlias) {
    console.log(`[PersonalDB] Found recurring meal by alias: "${byAlias.name}"`)
    return byAlias as Record<string, unknown>
  }

  console.log(`[PersonalDB] No recurring meal found for: "${term}"`)
  return null
}
