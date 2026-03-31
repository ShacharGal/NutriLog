import type { NutrientsPer100g, ResolvedIngredient } from './types'

/** Atwater equation check: calories ≈ 4*P + 4*C + 9*F + 2*Fi, ±15% */
export function atwaterCheck(profile: NutrientsPer100g): boolean {
  const expected = 4 * profile.protein + 4 * profile.carbs + 9 * profile.fat + 2 * profile.fiber
  if (expected === 0 && profile.calories === 0) return true
  return Math.abs(profile.calories - expected) <= 0.15 * expected
}

/** Recalculate calories from macros using Atwater factors */
export function atwaterCorrect(profile: NutrientsPer100g): NutrientsPer100g {
  return {
    ...profile,
    calories: Math.round(4 * profile.protein + 4 * profile.carbs + 9 * profile.fat + 2 * profile.fiber),
  }
}

/** Clamp nutrient values to reject obvious hallucinations */
export function clampNutrients(profile: NutrientsPer100g): NutrientsPer100g {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))
  return {
    calories: clamp(profile.calories, 2000),
    protein: clamp(profile.protein, 200),
    carbs: clamp(profile.carbs, 200),
    fat: clamp(profile.fat, 200),
    fiber: clamp(profile.fiber, 200),
  }
}

/** Calculate weighted totals from resolved ingredients — the ONLY place totals are computed */
export function calculateTotals(items: ResolvedIngredient[]): NutrientsPer100g {
  const totals: NutrientsPer100g = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  for (const item of items) {
    const factor = item.weight_g / 100
    totals.calories += item.nutrients_per_100g.calories * factor
    totals.protein += item.nutrients_per_100g.protein * factor
    totals.carbs += item.nutrients_per_100g.carbs * factor
    totals.fat += item.nutrients_per_100g.fat * factor
    totals.fiber += item.nutrients_per_100g.fiber * factor
  }
  // Round all values
  totals.calories = Math.round(totals.calories)
  totals.protein = Math.round(totals.protein * 10) / 10
  totals.carbs = Math.round(totals.carbs * 10) / 10
  totals.fat = Math.round(totals.fat * 10) / 10
  totals.fiber = Math.round(totals.fiber * 10) / 10
  return totals
}
