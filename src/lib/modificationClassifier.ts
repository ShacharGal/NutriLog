import type { MealClassification } from '../types/nutrition'

interface ClassificationResult {
  classification: MealClassification
  matchedMeal?: string
  modifier?: string
}

const REMOVE_PATTERN = /\b(without|remove|no|בלי|ללא)\s+/i
const QUANTITY_PATTERN = /\b(double|half|extra|less|more|כפול|חצי)\b/i
const ADD_SUB_PATTERN = /\b(add|swap|replace|substitute|instead|עם|במקום|להוסיף|להחליף)\b/i

/**
 * Classify user input against saved meal names.
 * Returns the classification type, matched meal (if any), and modifier text.
 */
export function classifyInput(
  input: string,
  savedMealNames: string[]
): ClassificationResult {
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()

  console.log(`[Classifier] Input: "${trimmed}", saved meals: [${savedMealNames.join(', ')}]`)

  // 1. Exact match
  for (const name of savedMealNames) {
    if (lower === name.toLowerCase()) {
      console.log(`[Classifier] EXACT_MATCH: "${name}"`)
      return { classification: 'EXACT_MATCH', matchedMeal: name }
    }
  }

  // For modification checks, find which meal name appears in the input
  const matchedMeal = findMealInInput(lower, savedMealNames)

  // 2. Remove pattern
  if (REMOVE_PATTERN.test(lower) && matchedMeal) {
    const modifier = extractModifier(trimmed, matchedMeal, REMOVE_PATTERN)
    console.log(`[Classifier] REMOVE: meal="${matchedMeal}", modifier="${modifier}"`)
    return { classification: 'REMOVE', matchedMeal, modifier }
  }

  // 3. Quantity pattern
  if (QUANTITY_PATTERN.test(lower) && matchedMeal) {
    const modifier = extractModifier(trimmed, matchedMeal, QUANTITY_PATTERN)
    console.log(`[Classifier] QUANTITY: meal="${matchedMeal}", modifier="${modifier}"`)
    return { classification: 'QUANTITY', matchedMeal, modifier }
  }

  // 4. Add/substitute pattern
  if (ADD_SUB_PATTERN.test(lower) && matchedMeal) {
    const modifier = extractModifier(trimmed, matchedMeal, ADD_SUB_PATTERN)
    console.log(`[Classifier] ADD_SUBSTITUTE: meal="${matchedMeal}", modifier="${modifier}"`)
    return { classification: 'ADD_SUBSTITUTE', matchedMeal, modifier }
  }

  // 5. Default: new meal
  console.log('[Classifier] NEW_MEAL')
  return { classification: 'NEW_MEAL' }
}

/**
 * Find which saved meal name appears in the input string (case-insensitive).
 * Returns the original meal name if found, or undefined.
 */
function findMealInInput(lowerInput: string, savedMealNames: string[]): string | undefined {
  // Sort by length descending so longer names match first (e.g., "morning shake" before "shake")
  const sorted = [...savedMealNames].sort((a, b) => b.length - a.length)
  for (const name of sorted) {
    if (lowerInput.includes(name.toLowerCase())) {
      return name
    }
  }
  return undefined
}

/**
 * Extract the modifier text: the part of the input that isn't the meal name,
 * focused around the modification keyword.
 */
function extractModifier(
  input: string,
  _matchedMeal: string,
  pattern: RegExp
): string {
  const match = input.match(pattern)
  if (!match) return input
  // Return the keyword and everything after it
  const idx = input.toLowerCase().indexOf(match[0].toLowerCase())
  return input.slice(idx).trim()
}
