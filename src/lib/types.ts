export interface NutritionLog {
  id: string
  created_at: string
  raw_input: string
  meal_description: string | null
  ingredients_json: Record<string, unknown>[] | null
  calories: number | null
  protein_g: number | null
  fiber_g: number | null
  carbs_g: number | null
  fat_g: number | null
  recurring_meal_ref: string | null
}

export interface MyFood {
  id: string
  name: string
  aliases: string[] | null
  description: string | null
  ingredients_json: { name: string; weight_g: number }[] | null
  nutrients_per_100g: { calories: number; protein: number; carbs: number; fat: number; fiber: number }
  total_weight_g: number | null
  source: string
  created_at: string
}

export interface WeightLog {
  id: string
  logged_at: string
  weight_kg: number
}

export interface UserSettings {
  id: number
  daily_protein_target: number
  daily_calorie_target: number
  updated_at: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LogApiResponse {
  status: 'ready_to_log' | 'needs_clarification' | 'save_recurring' | 'update_recurring'
  message: string
  logged_entry?: NutritionLog
}
