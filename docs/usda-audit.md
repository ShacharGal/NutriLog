# USDA Pipeline Audit — api/log.ts

## 1. Pipeline Diagram

```
User input (Hebrew/English/mixed)
       |
       v
+------------------+
| classifyInput()  |  Compare against savedMealNames (recurring_meals table)
+------------------+
       |
       +-- EXACT_MATCH -----> findRecurringMeal() --> write to nutrition_log --> DONE
       |                      (query by name ilike, then aliases contains)
       |
       +-- REMOVE / QUANTITY / ADD_SUBSTITUTE --> (falls through to NEW_MEAL path)
       |
       +-- NEW_MEAL
             |
             v
+----------------------------+
| callStage1LLM()            |  Gemini 2.5 Flash Lite via OpenRouter
| Decomposes meal into       |  Returns: { food_name, quantity_grams }[]
| individual ingredients     |  Or: needs_clarification + question
+----------------------------+
             |
             v  (for each ingredient, in parallel)
+----------------------------+
| resolveIngredients()       |
|                            |
|  Tier 1: findPersonalIngredient(name)
|     query personal_ingredients by name (ilike) or aliases (cs array contains)
|     HIT? --> use it, source='personal'
|              |
|     MISS     v
|  Tier 2: searchUSDA(name)
|     check usda_cache first, then hit USDA FoodData Central API
|     apply USDA_SEARCH_OVERRIDES map, score results, pick best
|     HIT? --> cache result, source='usda'
|              |
|     MISS     v
|  Tier 3: estimateNutritionLLM(name)
|     GPT-4o-mini via OpenRouter
|     "Estimate nutritional values per 100g for: {name}"
|     HIT? --> source='llm'
|              |
|     MISS     v
|     Return zeros, source='llm'
+----------------------------+
             |
             v
+----------------------------+
| Validation                 |
|  clampNutrients() per item |
|  calculateTotals()         |
|  atwaterCheck() -> atwaterCorrect() if off by >15%
+----------------------------+
             |
             v
+----------------------------+
| Write to nutrition_log     |
| (insert or update if       |
|  lastEntryId provided)     |
+----------------------------+
```

---

## 2. Override Map (Current State)

All entries from `USDA_SEARCH_OVERRIDES` (lines 139-161):

| Input term       | USDA query sent                       | Category       |
|------------------|---------------------------------------|----------------|
| `egg`            | `egg whole raw`                       | Protein/Dairy  |
| `eggs`           | `egg whole raw`                       | Protein/Dairy  |
| `white bread`    | `bread white commercially prepared`   | Grains         |
| `butter`         | `butter salted`                       | Fats           |
| `olive oil`      | `oil olive`                           | Fats           |
| `rice`           | `rice white cooked`                   | Grains         |
| `chicken breast` | `chicken breast meat cooked roasted`  | Protein        |
| `chicken thigh`  | `chicken thigh meat cooked`           | Protein        |
| `pasta`          | `pasta cooked`                        | Grains         |
| `spaghetti`      | `spaghetti cooked`                    | Grains         |
| `avocado`        | `avocado raw`                         | Produce        |
| `banana`         | `banana raw`                          | Produce        |
| `apple`          | `apple raw`                           | Produce        |
| `tomato`         | `tomato red ripe raw`                 | Produce        |
| `onion`          | `onion raw`                           | Produce        |
| `garlic`         | `garlic raw`                          | Produce        |
| `pita bread`     | `pita bread white`                    | Grains         |
| `hummus`         | `hummus commercial`                   | Legumes/Dips   |
| `ground beef`    | `beef ground 85 lean cooked`          | Protein        |
| `salmon`         | `salmon atlantic cooked`              | Protein        |
| `cheese`         | `cheese cheddar`                      | Dairy          |

**21 entries total.**

### Coverage by category:
- **Proteins (5):** egg, chicken breast, chicken thigh, ground beef, salmon
- **Grains (5):** white bread, rice, pasta, spaghetti, pita bread
- **Produce (5):** avocado, banana, apple, tomato, onion, garlic (6 actually)
- **Fats (2):** butter, olive oil
- **Legumes/Dips (1):** hummus
- **Dairy (1):** cheese

### Missing categories:
- **Nuts/Seeds:** no overrides for almonds, tahini, chia seeds, etc.
- **Legumes:** chickpeas, lentils (only hummus is covered)
- **Spices:** cumin, paprika, turmeric
- **Dairy alternatives:** goat cheese, sheep yogurt, labneh
- **Vegetables:** cucumber, lettuce, bell pepper, eggplant, carrot, spinach
- **Israeli staples:** tahini, amba, schug, za'atar
- **Other proteins:** lamb, turkey, tuna, tofu

---

## 3. USDA Scoring Logic

Located in `searchUSDA()` (lines 202-223). For each of the 5 results returned by USDA:

| Rule                      | Score impact | Notes |
|---------------------------|-------------|-------|
| **Exact match**           | +100        | description === searchTerm |
| **Starts with**           | +50         | description starts with searchTerm + comma or space |
| **Contains**              | +30         | description includes searchTerm anywhere |
| **Derivative penalty**    | -40         | If description contains "oil", "powder", "dried", "extract", "dehydrated", "concentrate" AND user did NOT search for one of those words. Applied once (breaks after first match). |
| **Length penalty**         | -0.1 * len  | Shorter descriptions preferred (more likely "whole food"). A 50-char description gets -5. |
| **Position penalty**      | -2 * index  | Earlier USDA results get slight preference (index 0 = no penalty, index 4 = -8). |

Results are sorted descending by score; the top scorer is selected.

**Key behavior notes:**
- The override map is applied BEFORE the API call (`queryTerm`), but scoring compares against the original `searchTerm` (lowercased food_name). This means when an override like `egg` -> `egg whole raw` is used, the USDA query is `egg whole raw` but scoring checks description against `egg` (the original). This actually helps -- "egg, whole, raw" would get the starts-with bonus (+50) against `egg`.
- The derivative check uses the original search term words, not the override. So searching for `olive oil` correctly sets `userWantsDerivative = true` and skips the -40 penalty for "oil" in descriptions.

---

## 4. Test Meal Traces

### 4.1 Shakshuka with pita

LLM would decompose per the system prompt example into: canned crushed tomatoes, egg, onion, bell pepper, olive oil, pita bread, and possibly spices.

| Ingredient              | Override?                          | USDA match quality | Notes |
|-------------------------|------------------------------------|--------------------|-------|
| canned crushed tomatoes | NO override                        | FAIR -- USDA has "tomatoes, crushed, canned" but query wording may not score well | Potential gap |
| egg                     | YES -> `egg whole raw`             | GOOD               | |
| onion                   | YES -> `onion raw`                 | GOOD               | |
| bell pepper             | NO override                        | FAIR -- USDA has "peppers, sweet, green/red, raw" but "bell pepper" may score poorly | Needs override |
| olive oil               | YES -> `oil olive`                 | GOOD               | |
| pita bread              | YES -> `pita bread white`          | GOOD               | |
| spices (cumin etc.)     | NO override                        | POOR -- generic "spices" will get scattered results | Low calorie impact, acceptable |

### 4.2 Sabich

LLM decomposes into: eggplant, hard-boiled egg, hummus, tahini, pita bread, amba.

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| eggplant        | NO override                        | GOOD -- USDA has "eggplant, raw/cooked" | Should add override for cooked state |
| egg (hard-boiled)| YES -> `egg whole raw`            | OK -- override sends "egg whole raw" but ingredient is boiled. Nutrient diff is minor. | |
| hummus          | YES -> `hummus commercial`         | GOOD               | |
| tahini          | NO override                        | FAIR -- USDA has "tahini" entries but may match "butter, sesame tahini" | Needs override |
| pita bread      | YES -> `pita bread white`          | GOOD               | |
| amba            | NO override                        | POOR -- amba (mango pickle condiment) is unlikely in USDA SR Legacy | Will fall to LLM tier |

### 4.3 Overnight oats

LLM decomposes into: oats, milk (non-dairy), chia seeds, honey.

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| oats            | NO override                        | FAIR -- USDA has multiple oat entries; "oats" alone may match cereal products | Needs override -> `oats regular cooked` or `oats dry` |
| milk (non-dairy)| NO override                        | POOR -- "milk" with no override will match cow's milk. LLM may output "almond milk" or "oat milk" which also lack overrides | Needs override |
| chia seeds      | NO override                        | FAIR -- USDA has "seeds, chia seeds, dried" | Acceptable |
| honey           | NO override                        | GOOD -- USDA has "honey" as a clear match | |

### 4.4 Grilled chicken salad

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| chicken breast  | YES -> `chicken breast meat cooked roasted` | GOOD        | |
| lettuce         | NO override                        | FAIR -- multiple lettuce types in USDA | Needs override -> `lettuce green leaf raw` |
| tomato          | YES -> `tomato red ripe raw`       | GOOD               | |
| cucumber        | NO override                        | GOOD -- USDA has "cucumber, with peel, raw" | Could add override for reliability |
| olive oil       | YES -> `oil olive`                 | GOOD               | |

### 4.5 Pasta bolognese

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| pasta           | YES -> `pasta cooked`              | GOOD               | |
| ground beef     | YES -> `beef ground 85 lean cooked`| GOOD               | |
| tomato sauce    | NO override                        | FAIR -- "tomato sauce" should match "sauce, pasta, spaghetti/marinara" but may get penalized by derivative words or length | Needs override |
| onion           | YES -> `onion raw`                 | GOOD               | |
| garlic          | YES -> `garlic raw`                | GOOD               | |

### 4.6 Hummus plate

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| hummus          | YES -> `hummus commercial`         | GOOD               | |
| chickpeas       | NO override                        | FAIR -- USDA has "chickpeas (garbanzo beans)" but description is long | Needs override |
| olive oil       | YES -> `oil olive`                 | GOOD               | |
| pita bread      | YES -> `pita bread white`          | GOOD               | |

### 4.7 Avocado toast

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| avocado         | YES -> `avocado raw`               | GOOD               | |
| bread           | NO override (only "white bread" is mapped) | FAIR -- "bread" alone will match many types | Needs override |
| egg             | YES -> `egg whole raw`             | GOOD               | |
| salt            | NO override                        | OK -- zero-calorie, matching doesn't matter much | |

### 4.8 Lamb kebab

| Ingredient      | Override?                          | USDA match quality | Notes |
|-----------------|------------------------------------|--------------------|-------|
| lamb            | NO override                        | FAIR -- USDA has many lamb cuts; "lamb" alone may match "lamb, domestic, composite" | Needs override |
| onion           | YES -> `onion raw`                 | GOOD               | |
| spices          | NO override                        | POOR -- too generic | Low calorie impact |
| rice            | YES -> `rice white cooked`         | GOOD               | |

---

## 5. Gap Analysis

### Ingredients with NO override that would get bad USDA matches

| Ingredient          | Problem | Risk level |
|---------------------|---------|------------|
| bell pepper         | USDA lists as "peppers, sweet, ..." -- name mismatch | MEDIUM |
| tomato sauce        | Matches marinara/pasta sauce variants, long descriptions | MEDIUM |
| tahini              | May match "butter, sesame tahini" or wrong form | MEDIUM |
| oats                | Matches cereal products, multiple forms | MEDIUM |
| lettuce             | Multiple types, no default | LOW |
| lamb                | Many cuts, no default | MEDIUM |
| bread               | Too generic without qualifier | MEDIUM |
| milk / almond milk  | "milk" defaults to cow's milk (user avoids cow dairy!) | HIGH |
| amba                | Not in USDA at all | LOW (condiment) |
| eggplant            | Works but cooked vs raw nutrient diff | LOW |

### Recommended override map additions

```typescript
// Vegetables
'bell pepper': 'peppers sweet red raw',
'cucumber': 'cucumber with peel raw',
'lettuce': 'lettuce green leaf raw',
'eggplant': 'eggplant cooked boiled',
'spinach': 'spinach raw',
'carrot': 'carrots raw',
'cabbage': 'cabbage raw',

// Nuts & Seeds
'tahini': 'seeds sesame butter tahini',
'chia seeds': 'seeds chia seeds dried',
'almonds': 'nuts almonds',
'walnuts': 'nuts walnuts english',
'peanut butter': 'peanut butter smooth',

// Legumes
'chickpeas': 'chickpeas garbanzo beans mature seeds cooked',
'lentils': 'lentils mature seeds cooked boiled',

// Grains
'oats': 'oats regular and quick cooked',
'bread': 'bread whole wheat commercially prepared',
'tortilla': 'tortillas ready to bake flour',
'couscous': 'couscous cooked',

// Proteins
'lamb': 'lamb ground cooked broiled',
'turkey': 'turkey ground cooked',
'tuna': 'tuna light canned in water',
'tofu': 'tofu firm prepared with calcium sulfate',

// Dairy alternatives & Israeli staples
'goat cheese': 'cheese goat soft type',
'labneh': 'yogurt greek plain whole milk',  // closest USDA proxy
'feta': 'cheese feta',
'almond milk': 'almond milk unsweetened',

// Sauces & condiments
'tomato sauce': 'sauce ready to serve tomato',
'canned crushed tomatoes': 'tomatoes crushed canned',
'soy sauce': 'soy sauce',
'honey': 'honey',

// Cooking fats
'coconut oil': 'oil coconut',
'sesame oil': 'oil sesame',
```

### Israeli/Mediterranean ingredients needing special handling

| Ingredient | Issue | Recommendation |
|------------|-------|----------------|
| **tahini** | Core staple, multiple USDA entries | Add override |
| **labneh** | Not in USDA SR Legacy | Map to Greek yogurt as proxy, or add to personal_ingredients with accurate data |
| **amba** | Not in USDA at all | Add to personal_ingredients (mango-based, ~150 cal/100g) |
| **schug** | Not in USDA | Add to personal_ingredients (~100 cal/100g hot pepper paste) |
| **za'atar** | Spice blend, not in USDA as-is | Add to personal_ingredients |
| **halva** | In USDA but may match wrong items | Add override -> `candy halva plain` |
| **bamba** | Israeli snack, not in USDA | Add to personal_ingredients |
| **ptitim** | Israeli couscous, not in USDA by this name | Map to `couscous cooked` or add personal |
| **jachnun/malawach** | Yemenite pastries, not in USDA | Add to personal_ingredients |
| **burekas** | Not in USDA | Add to personal_ingredients (phyllo + cheese filling) |

---

## 6. Personal DB & Recurring Meals Wiring

### Personal Ingredients (Tier 1)

**Function:** `findPersonalIngredient()` (lines 250-261)

**Query logic:**
```
personal_ingredients WHERE name ILIKE '{term}' OR aliases @> ARRAY['{term_lower}']
```
- Uses `.or()` with `name.ilike` (case-insensitive exact match) and `aliases.cs` (array contains, case-sensitive on the lowercased term)
- Returns `nutrients_per_100g` only
- `.maybeSingle()` -- returns null if no match, errors if >1 match

**Status:** Wiring looks correct. The `ilike` on name means "Tahini" matches "tahini". The aliases array-contains check is case-sensitive but uses `term.toLowerCase()`, so aliases must be stored lowercase to match.

**Potential issue:** The `.or()` filter syntax uses string interpolation directly: `.or(`name.ilike.${term},aliases.cs.{${term.toLowerCase()}}`)`. If `term` contains commas or special PostgREST characters, the filter could break. Low risk for food names but worth noting.

### Recurring Meals (EXACT_MATCH path)

**Function:** `findRecurringMeal()` (lines 263-271)

**Query logic:**
1. First: `recurring_meals WHERE name ILIKE '{term}'`
2. Fallback: `recurring_meals WHERE aliases @> ARRAY['{term_lower}']`

**Classification flow:**
1. `classifyInput()` checks if input exactly equals any saved meal name (case-insensitive)
2. If EXACT_MATCH, calls `findRecurringMeal()` to fetch the full meal record
3. Writes all fields (calories, protein, carbs, fat, fiber, ingredients_json, meal_description) directly to nutrition_log
4. Sets `source_tier = 'personal'` and `recurring_meal_ref = meal.name`

**Status:** Code path is complete and would work when the `recurring_meals` table is populated. The classifier does a strict `lower === name.toLowerCase()` comparison, while `findRecurringMeal` uses `ilike` -- these are consistent for exact matches.

**Issue with REMOVE/QUANTITY/ADD_SUBSTITUTE:** These classifications detect a modifier + a recurring meal name, but then fall through to the NEW_MEAL path (LLM decomposition). The LLM does NOT receive the recurring meal's ingredients -- it only gets the meal names in the system prompt context. This means for "shakshuka without bell pepper" where shakshuka is a saved meal, the LLM has to guess the standard shakshuka ingredients rather than using the saved recipe. This is acceptable for now but could be improved by injecting the matched meal's ingredients into the LLM prompt.

**Other notes:**
- The recurring meal fields (`meal_description`, `ingredients_json`, `calories`, `protein_g`, etc.) are cast with `as` but no runtime validation. If a recurring meal row has null macros, they'd be written as null to nutrition_log.
- `lastEntryId` support works for recurring meals too (update vs insert), which is correct for the "re-log" flow.
