export interface NutrientsPer100g {
  calories: number
  protein: number
  carbs: number
  fat: number
  fiber: number
}

export interface ResolvedIngredient {
  food_name: string
  weight_g: number
  nutrients_per_100g: NutrientsPer100g
  source: 'personal' | 'usda' | 'llm'
}

export interface ParsedMealResult {
  items: ResolvedIngredient[]
  totals: NutrientsPer100g
}

export interface LLMParsedItem {
  food_name: string
  quantity_grams: number
}

export type SourceTier = 'personal' | 'usda' | 'llm' | 'mixed'

export type MealClassification = 'EXACT_MATCH' | 'REMOVE' | 'QUANTITY' | 'ADD_SUBSTITUTE' | 'NEW_MEAL'
