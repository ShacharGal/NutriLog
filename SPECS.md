# NutriLog — Technical Specification

## Architecture Overview

```
User Input
    │
    ▼
┌─────────────────────┐
│  Meal Modifier       │  string match + regex
│  Classifier          │  → EXACT_MATCH | REMOVE | QUANTITY | ADD_SUBSTITUTE | NEW_MEAL
└─────────┬───────────┘
          │
    ┌─────┴──────────────────────────────────┐
    │                                         │
    ▼ (EXACT/REMOVE/QUANTITY)                 ▼ (ADD_SUBSTITUTE / NEW_MEAL)
┌──────────────┐                    ┌──────────────────┐
│ Rules-based  │                    │ Stage 1: LLM     │
│ (zero tokens)│                    │ Parse text →      │
│              │                    │ [{food, grams}]   │
└──────┬───────┘                    └────────┬─────────┘
       │                                      │
       │                            ┌─────────▼──────────┐
       │                            │ Stage 2: Resolution │
       │                            │ Tier 1 → 2 → 3     │
       │                            └─────────┬──────────┘
       │                                      │
       ▼                                      ▼
┌──────────────────────────────────────────────────┐
│ Atwater Validation → Calculate Totals → DB Write │
└──────────────────────────────────────────────────┘
```

---

## Resolution Engine

Every tier returns the same contract:
```typescript
{
  per_100g: { calories, protein, carbs, fat, fiber },
  weight_g: number,
  source: "personal" | "usda" | "llm"
}
```

All final calculations (`value * weight_g / 100`) are done in server code. **Never in the LLM.**

### Tier 1 — Personal DB (highest priority)

User-defined ingredients and recipes. Exact name/alias match against `personal_ingredients` and `personal_recipes` tables.

- **Matching:** case-insensitive exact match on `name` or any value in `aliases[]`
- **Recipes:** stored as ingredient arrays with pre-computed `total_nutrients` and `serving_weight_g`
- **Modifications:** remove/quantity/substitute operations applied to ingredient arrays, totals recalculated server-side

### Tier 2 — USDA Cache

Deterministic values for standard whole foods via USDA FoodData Central API.

- **API:** `https://api.nal.usda.gov/fdc/v1/foods/search` (free, 1000 req/hr)
- **Strategy:** Search by food name, take top result from "Foundation" or "SR Legacy" data types
- **Cache:** Results stored permanently in `usda_cache` table by search term. Cache hit = no API call.
- **Parsing:** Extract per-100g values for: Energy (kcal, nutrient ID 1008), Protein (1003), Carbs (1005), Fat (1004), Fiber (1079)

### Tier 3 — LLM Fallback

For novel or composite items not found in Tier 1 or 2.

- **Model:** GPT-4o-mini via OpenRouter, temperature: 0.1
- **Prompt:** "Estimate per-100g nutritional values for: {food_name}. Return JSON: {calories, protein, carbs, fat, fiber}"
- **Post-call:** Flag item with `source: "llm"`. Prompt user: "Want to save this to your personal database?"
- **Contract:** Same `{ per_100g, weight_g, source }` as other tiers

---

## Shared Contracts

### NutrientsPer100g
```typescript
interface NutrientsPer100g {
  calories: number
  protein: number
  carbs: number
  fat: number
  fiber: number
}
```

### ResolvedIngredient
```typescript
interface ResolvedIngredient {
  food_name: string
  weight_g: number
  nutrients_per_100g: NutrientsPer100g
  source: "personal" | "usda" | "llm"
}
```

### ParsedMealResult
```typescript
interface ParsedMealResult {
  items: ResolvedIngredient[]
  totals: NutrientsPer100g
}
```

### LLMParsedItem (Stage 1 output)
```typescript
interface LLMParsedItem {
  food_name: string
  quantity_grams: number
}
```

### Atwater Validation

```
expected_cal = 4 * protein + 4 * carbs + 9 * fat + 2 * fiber
tolerance = ±15%
```

If `|calories - expected_cal| > 0.15 * expected_cal`, replace calories with `expected_cal`.

Clamp ranges: 0–2000 cal per ingredient, 0–200g per macro per ingredient.

---

## Meal Modification Routing (Pre-LLM Classifier)

Before any LLM call, classify input against saved meals:

| Pattern | Classification | Action |
|---------|---------------|--------|
| Exact name/alias match | `EXACT_MATCH` | Log from Tier 1, zero tokens |
| `/without\|remove\|no\s+\w+/i` | `REMOVE` | Filter ingredient array, recalculate |
| `/double\|half\|extra\|less\|more/i` | `QUANTITY` | Multiply ingredient values |
| `/add\|swap\|replace\|substitute\|with\s+\w+\s+instead/i` | `ADD_SUBSTITUTE` | Single LLM call for new ingredient only |
| No match | `NEW_MEAL` | Full Stage 1 parse |

**Classification uses string matching + regex only. No LLM needed.**

---

## Conversation Flow

### Exact Match → Instant Log
User says "green smoothie" → matches saved recipe → log all ingredients with Tier 1 values → return totals. Zero tokens.

### Modification → Rules-Based Delta
User says "green smoothie without banana" → load recipe → filter out banana → recalculate totals server-side. Zero tokens.

User says "green smoothie double the protein powder" → load recipe → multiply protein powder weight × 2 → recalculate. Zero tokens.

### New Meal → Full Pipeline
User says "shakshuka with 2 pitas" → Stage 1 LLM parse → `[{food_name:"tomato",quantity_grams:200}, {food_name:"egg",quantity_grams:100}, ...]` → resolve each via Tier 1→2→3 → validate → sum → log.

### Clarification
If Stage 1 LLM returns `needs_clarification`, relay question to user and wait. Max 2 rounds.

---

## Database Schema

### nutrition_log (existing, altered)
```sql
-- Existing columns unchanged
-- New columns:
ALTER TABLE nutrition_log ADD COLUMN ingredients JSONB;
-- Format: [{"food_name":"egg","weight_g":100,"per_100g":{...},"source":"usda"}]
ALTER TABLE nutrition_log ADD COLUMN source_tier TEXT
  CHECK (source_tier IN ('personal','usda','llm','mixed'));
```

Old rows (no `ingredients` or `source_tier`) remain as-is. No backfill.

### personal_ingredients (new)
```sql
CREATE TABLE personal_ingredients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  name TEXT NOT NULL,
  aliases TEXT[],
  nutrients_per_100g JSONB NOT NULL,
  -- { calories, protein, carbs, fat, fiber }
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_personal_ingredients_user_name
  ON personal_ingredients(user_id, name);
```

### personal_recipes (new)
```sql
CREATE TABLE personal_recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  name TEXT NOT NULL,
  aliases TEXT[],
  ingredients JSONB NOT NULL,
  -- [{ ingredient_id?, food_name, weight_g }]
  total_nutrients JSONB,
  -- { calories, protein, carbs, fat, fiber } (pre-computed for full recipe)
  serving_weight_g NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_personal_recipes_user_name
  ON personal_recipes(user_id, name);
```

### usda_cache (new)
```sql
CREATE TABLE usda_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fdc_id INT,
  search_term TEXT NOT NULL,
  nutrients_per_100g JSONB NOT NULL,
  -- { calories, protein, carbs, fat, fiber }
  food_category TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usda_cache_search_term
  ON usda_cache(search_term);
```

---

## API Endpoints

### POST /api/log (refactored)

**Input:** `{ message, conversationHistory[], lastEntryId? }`

**Flow:**
1. Fetch context (weight, today's totals, settings, personal meals list)
2. Run classifier against personal recipes/ingredients
3. If EXACT_MATCH/REMOVE/QUANTITY → resolve deterministically, skip LLM
4. If ADD_SUBSTITUTE → single LLM call for new ingredient, merge
5. If NEW_MEAL → Stage 1 LLM parse → resolution engine → validation
6. Calculate totals server-side
7. Atwater validate
8. Write to `nutrition_log` with `ingredients` JSONB and `source_tier`
9. Return result

### POST /api/ingredients (future)
CRUD for personal_ingredients table.

### POST /api/recipes (future)
CRUD for personal_recipes table.

---

## Model Configuration

| Stage | Model | Temperature | Purpose |
|-------|-------|-------------|---------|
| Stage 1 (extraction) | `google/gemini-2.5-flash-lite-preview` | 0.1 | Parse text → `[{food_name, quantity_grams}]` |
| Stage 3 (fallback) | `openai/gpt-4o-mini` | 0.1 | Estimate per-100g nutrition for unknown items |

All LLM calls use:
- `response_format: { type: "json_object" }` (where supported)
- OpenRouter with sticky provider routing
- Timeout: 50s
- Max conversation history: 6 messages

### Stage 1 System Prompt (extraction only)

```
You are a food ingredient parser. Given a meal description, extract individual
ingredients and estimate their weight in grams.

PORTION DEFAULTS:
- 1 egg = 50g, 1 chicken breast = 160g, 1 slice bread = 35g
- A bowl = 300ml, a plate = moderate adult serving
- A handful of nuts = 30g, olive oil for cooking = 15g
- 1 pita = 60g, 1 cup rice (cooked) = 200g

RULES:
- Output ONLY a JSON object with "items" array
- Each item: { "food_name": "string", "quantity_grams": number }
- Decompose composite dishes into individual ingredients
- Use generic ingredient names (not brand names)
- For Israeli/Mediterranean foods, transliterate Hebrew names
- Do NOT calculate calories, protein, or any nutritional values

EXAMPLES:

Input: "2 scrambled eggs with toast"
Output: {"items":[{"food_name":"egg","quantity_grams":100},{"food_name":"white bread","quantity_grams":35},{"food_name":"butter","quantity_grams":5}]}

Input: "shakshuka with 2 pitas and hummus"
Output: {"items":[{"food_name":"tomato","quantity_grams":200},{"food_name":"egg","quantity_grams":100},{"food_name":"onion","quantity_grams":50},{"food_name":"bell pepper","quantity_grams":50},{"food_name":"olive oil","quantity_grams":15},{"food_name":"pita bread","quantity_grams":120},{"food_name":"hummus","quantity_grams":80}]}

Input: "a big bowl of pasta with meat sauce"
Output: {"items":[{"food_name":"pasta","quantity_grams":250},{"food_name":"ground beef","quantity_grams":150},{"food_name":"tomato sauce","quantity_grams":120},{"food_name":"onion","quantity_grams":40},{"food_name":"olive oil","quantity_grams":10},{"food_name":"garlic","quantity_grams":5}]}
```

### Stage 3 Prompt (nutrition estimation)

```
Estimate the nutritional values per 100g for the following food item.
Return ONLY a JSON object: {"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number}
Use USDA-equivalent values. Be precise.

Food: {food_name}
```

---

## Existing Data Migration

- **No backfill.** Old `nutrition_log` rows keep their flat macros.
- New rows populate `ingredients` JSONB and `source_tier`.
- Frontend handles both: if `ingredients` exists, show per-ingredient breakdown; otherwise show flat totals.
- `recurring_meals` table continues to work for legacy matching; new personal_recipes table is the replacement going forward.
