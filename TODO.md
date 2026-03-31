# NutriLog — Build Plan & TODO

## Overview
Mobile-first PWA (Android) for logging meals via natural language chat. Two-stage hybrid pipeline: LLM parses ingredients + grams only, deterministic databases provide nutrition values, server-side code does all math.

## Tech Stack
- Frontend: React + TypeScript + Vite (PWA)
- Styling: Tailwind CSS
- Backend: Vercel serverless functions
- Database: Supabase (project ref: nvaxzlfpwrfmnttsfent, region: eu-central-1)
- AI: OpenRouter API
  - Stage 1 (extraction): google/gemini-2.5-flash-lite-preview, temp 0.1
  - Stage 3 (fallback nutrition): openai/gpt-4o-mini, temp 0.1
- Resolution: USDA FoodData Central API (free, 1000 req/hr)
- Deployment: Vercel
- Repo: github.com/ShacharGal/NutriLog (private)

---

## Completed (pre-pivot)

### Step 1 — Repo + Supabase + Vercel setup ✅
- [x] GitHub repo created (private)
- [x] Supabase project created + linked
- [x] Vercel project created + linked
- [x] .env.local with all 5 env vars

### Step 2 — Database tables ✅
- [x] Create `nutrition_log` table
- [x] Create `recurring_meals` table
- [x] Create `weight_log` table
- [x] Create `user_settings` table
- [x] Insert default user_settings row
- [x] Insert starting weight (80kg)

### Step 3 — Environment variables in Vercel ✅
- [x] Set SUPABASE_URL, SUPABASE_ANON_KEY, OPENROUTER_API_KEY in Vercel

### Step 4 — Vite + React + Tailwind + PWA base config ✅
- [x] Initialize Vite React-TS project
- [x] Install & configure Tailwind CSS
- [x] Configure PWA plugin
- [x] Dark theme setup

### Step 5 — Supabase client & TypeScript types ✅
- [x] src/lib/supabase.ts — Supabase client
- [x] src/lib/types.ts — shared TypeScript types

### Step 6 — Original serverless function + system prompt ✅ (to be refactored)
- [x] config/system_prompt.txt — original AI instructions
- [x] api/log.ts — original single-LLM pipeline

### Step 7 — LogTab (core chat UI) ✅
- [x] src/components/LogTab.tsx — chat interface, mobile-optimized
- [x] Confirmation cards, today's summary bar, conversation sessions

### Step 8a — Entries API ✅
- [x] api/entries.ts — GET: fetch log rows with filters

### Step 10 — MealsTab ✅
- [x] src/components/MealsTab.tsx — list/expand/delete recurring meals

---

## Pipeline Pivot — Two-Stage Hybrid Architecture

### Step P1 — Specs & Planning ✅
- [x] Write SPECS.md with full architecture
- [x] Update TODO.md with new plan

### Step P2 — Prompt & Config Updates
- [ ] Rewrite config/system_prompt.txt for Stage 1 extraction only (no macro calculation)
- [ ] Update api/log.ts: model → gemini-2.5-flash-lite, temperature: 0.1
- [ ] Add response_format: { type: "json_object" } to LLM call
- [ ] Verify build passes

### Step P3 — Database Schema Migration
- [ ] Create migration: personal_ingredients table
- [ ] Create migration: personal_recipes table
- [ ] Create migration: usda_cache table
- [ ] ALTER nutrition_log: add ingredients JSONB, source_tier TEXT
- [ ] Run migration against Supabase

### Step P4 — Shared Types & Validation
- [ ] Create src/types/nutrition.ts (NutrientsPer100g, ResolvedIngredient, ParsedMealResult, LLMParsedItem)
- [ ] Create src/lib/validation.ts (atwaterCheck, atwaterCorrect, clampNutrients, calculateTotals)
- [ ] Create src/lib/portionDefaults.ts
- [ ] Verify types compile

### Step P5 — USDA Client
- [ ] Create src/lib/usda.ts — search USDA FoodData Central API
- [ ] Parse response to NutrientsPer100g
- [ ] Write results to usda_cache table
- [ ] Cache-first: check usda_cache before API call

### Step P6 — Personal DB Client
- [ ] Create src/lib/personalDb.ts — query personal_ingredients by name/alias
- [ ] Query personal_recipes by name/alias
- [ ] Return ResolvedIngredient contract

### Step P7 — Modification Classifier
- [ ] Create src/lib/modificationClassifier.ts
- [ ] Regex classifier: EXACT_MATCH | REMOVE | QUANTITY | ADD_SUBSTITUTE | NEW_MEAL
- [ ] Handle remove (filter ingredients), quantity (multiply weights)

### Step P8 — Pipeline Refactor (api/log.ts)
- [ ] Integrate classifier → resolution engine → validation
- [ ] Stage 1: LLM extraction only (food_name + quantity_grams)
- [ ] Stage 2: Parallel tier resolution (personal → USDA → LLM fallback)
- [ ] Stage 3: LLM fallback for unresolved items
- [ ] Atwater validation on all results
- [ ] Calculate totals server-side
- [ ] Write ingredients JSONB + source_tier to nutrition_log
- [ ] Verify build, test end-to-end

---

## Remaining Original Steps (post-pivot)

### Step 8b — Remaining API Routes
- [ ] api/recurring-meals.ts — GET/POST/DELETE recurring meals
- [ ] api/settings.ts — GET/PUT user settings + weight log

### Step 9 — GraphsTab
- [ ] src/components/GraphsTab.tsx (using Recharts)
- [ ] Protein over time, Calories over time, Macro breakdown charts
- [ ] Date range selector: 7 / 14 / 30 days

### Step 11 — SettingsTab
- [ ] src/components/SettingsTab.tsx
- [ ] Editable targets, log weight, weight history, export CSV

### Step 12 — BottomNav + App.tsx routing
- [ ] src/components/BottomNav.tsx — 4 tabs
- [ ] src/App.tsx — tab routing

### Step 13 — PWA manifest + service worker
- [ ] public/manifest.json, icons, sw.js
- [ ] Installable on Android Chrome

### Step 14 — Deploy + test
- [ ] Deploy to Vercel, test on Android, verify PWA install

### Step 15 — Design polish
- [ ] Review and adjust overall look & feel

---

## Deferred (do NOT implement yet)
- [ ] Fuzzy matching for recurring meal names (Levenshtein or embedding-based)
- [ ] "Save to personal DB?" prompt flow in frontend
- [ ] Semantic caching layer
- [ ] Personal DB CRUD UI (ingredients/recipes management screens)
- [ ] CSV export updates for new schema
- [ ] Response caching for identical meal descriptions
- [ ] Frontend: per-ingredient breakdown display for new entries

---

## Database Schema

### nutrition_log (existing + new columns)
```sql
-- Existing columns: id, created_at, raw_input, meal_description,
--   ingredients_json, calories, protein_g, fiber_g, carbs_g, fat_g,
--   health_grade, grade_reasoning, recurring_meal_ref
-- New:
ALTER TABLE nutrition_log ADD COLUMN ingredients JSONB;
ALTER TABLE nutrition_log ADD COLUMN source_tier TEXT
  CHECK (source_tier IN ('personal','usda','llm','mixed'));
```

### personal_ingredients (new)
See SPECS.md for full schema.

### personal_recipes (new)
See SPECS.md for full schema.

### usda_cache (new)
See SPECS.md for full schema.

### recurring_meals (existing, legacy)
### weight_log (existing)
### user_settings (existing)
