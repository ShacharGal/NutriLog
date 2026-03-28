# NutriLog — Build Plan & TODO

## Overview
Mobile-first PWA (Android) for logging meals via natural language chat. AI parses free text into structured nutritional data, stores in Supabase, visualizes over time.

## Tech Stack
- Frontend: React + TypeScript + Vite (PWA)
- Styling: Tailwind CSS
- Backend: Vercel serverless functions
- Database: Supabase (project ref: nvaxzlfpwrfmnttsfent, region: eu-central-1)
- AI: OpenRouter API (openrouter.ai/api/v1/chat/completions)
  - Parsing: anthropic/claude-haiku-4-5
  - Ambiguous/multi-turn: anthropic/claude-sonnet-4-6
- Deployment: Vercel
- Repo: github.com/ShacharGal/NutriLog (private)

---

## Build Steps

### Step 1 — Repo + Supabase + Vercel setup ✅
- [x] GitHub repo created (private)
- [x] Supabase project created + linked
- [x] Vercel project created + linked
- [x] .env.local with all 5 env vars

### Step 2 — Database tables ✅
- [x] Create `nutrition_log` table
- [x] Create `recurring_meals` table
- [x] Create `weight_log` table (date + weight_kg)
- [x] Create `user_settings` table (protein target, calorie target — no weight field)
- [x] Insert default user_settings row
- [x] Insert starting weight (80kg)

### Step 3 — Environment variables in Vercel ✅
- [x] Set SUPABASE_URL, SUPABASE_ANON_KEY, OPENROUTER_API_KEY in Vercel
- [x] Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY in Vercel

### Step 4 — Vite + React + Tailwind + PWA base config ✅
- [x] Initialize Vite React-TS project
- [x] Install & configure Tailwind CSS
- [x] Configure PWA plugin
- [x] Dark theme setup

### Step 5 — Supabase client & TypeScript types ✅
- [x] src/lib/supabase.ts — Supabase client
- [x] src/lib/types.ts — shared TypeScript types

### Step 6 — Core serverless function + system prompt
- [ ] config/system_prompt.txt — AI instructions (see spec below)
- [ ] api/log.ts — POST: chat turn → AI → maybe write to DB
  - Reads system_prompt.txt at runtime
  - Appends context: current weight (latest weight_log), today's totals, recurring meal names
  - Calls OpenRouter with conversation history (max 6 messages)
  - Handles statuses: ready_to_log, needs_clarification, save_recurring, update_recurring
  - Uses haiku for single-turn, sonnet for multi-turn

### Step 7 — LogTab (core chat UI)
- [ ] src/components/LogTab.tsx
- [ ] Chat interface, mobile-optimized
- [ ] Message thread (scrollable) + fixed input at bottom
- [ ] Loading indicator during API calls
- [ ] Confirmation cards: calories | protein | fiber | grade (colored badge) + grade_reasoning
- [ ] Today's summary bar at top: calories/target, protein/target with progress bars
- [ ] Conversation session rules:
  - Each meal = own thread, resets after "ready_to_log"
  - Resets on "done", "next", "new meal"
  - Multi-turn clarification keeps thread alive
  - History scoped to current meal only
  - Max 6 messages per thread before forcing log

### Step 8 — Supporting API routes
- [ ] api/entries.ts — GET: fetch log rows with filters
- [ ] api/recurring-meals.ts — GET/POST/DELETE recurring meals
- [ ] api/settings.ts — GET/PUT user settings + weight log

### Step 9 — GraphsTab
- [ ] src/components/GraphsTab.tsx (using Recharts)
- [ ] Protein over time — line chart, last 14 days, target line
- [ ] Calories over time — bar chart, last 14 days, target line
- [ ] Macro breakdown — stacked bar, last 7 days (protein/carbs/fat)
- [ ] Health grade trend — line chart, grades as numbers (A=5..F=1)
- [ ] Date range selector: 7 / 14 / 30 days

### Step 10 — MealsTab
- [ ] src/components/MealsTab.tsx
- [ ] List of saved recurring meals (name, calories, protein, grade badge)
- [ ] Tap to expand: full macros + ingredients
- [ ] Delete button with confirm
- [ ] Note: "Create and edit meals by chatting in the Log tab"

### Step 11 — SettingsTab
- [ ] src/components/SettingsTab.tsx
- [ ] Editable fields (auto-save on blur): daily protein target, daily calorie target
- [ ] "Log weight" input: number field + Save → inserts into weight_log
- [ ] Weight history: last 5 entries (date + value)
- [ ] Export CSV button (date range: 7/30/90 days / all)
- [ ] "Copy week summary" button → plain text to clipboard

### Step 12 — BottomNav + App.tsx routing
- [ ] src/components/BottomNav.tsx — 4 tabs: Log (chat bubble) | Graphs (chart) | Meals (bookmark) | Settings (gear)
- [ ] src/App.tsx — tab routing

### Step 13 — PWA manifest + service worker
- [ ] public/manifest.json (name: NutriLog, theme: #16a34a, bg: #0f172a, standalone, portrait)
- [ ] Icons: green circle with "N" at 192x192 and 512x512
- [ ] public/sw.js — basic offline support, cache shell assets
- [ ] Installable on Android Chrome

### Step 14 — Deploy + test
- [ ] Deploy to Vercel
- [ ] Test on Android
- [ ] Verify PWA install

---

## Database Schema

### nutrition_log
```sql
create table nutrition_log (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  raw_input text not null,
  meal_description text,
  ingredients_json jsonb,
  calories integer,
  protein_g numeric(5,1),
  fiber_g numeric(5,1),
  carbs_g numeric(5,1),
  fat_g numeric(5,1),
  health_grade text,
  grade_reasoning text,
  recurring_meal_ref text
);
```

### recurring_meals
```sql
create table recurring_meals (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  name text not null unique,
  aliases text[],
  meal_description text,
  ingredients_json jsonb,
  calories integer,
  protein_g numeric(5,1),
  fiber_g numeric(5,1),
  carbs_g numeric(5,1),
  fat_g numeric(5,1),
  health_grade text
);
```

### weight_log
```sql
create table weight_log (
  id uuid default gen_random_uuid() primary key,
  logged_at date default current_date,
  weight_kg numeric(4,1) not null
);
insert into weight_log (weight_kg) values (80);
```

### user_settings
```sql
create table user_settings (
  id integer primary key default 1,
  daily_protein_target integer default 145,
  daily_calorie_target integer default 2400,
  updated_at timestamptz default now()
);
insert into user_settings (id) values (1);
```

---

## System Prompt (config/system_prompt.txt)

AI nutrition logging assistant. Key behaviors:
- Parse meal descriptions into structured JSON with macros
- Health grading: A/B/C/D/F based on nutritional quality
- Recurring meal matching by name/alias
- Suggest saving meals logged 3+ times
- Max 2 clarifying questions before logging anyway
- Simple meals: log immediately

User profile context (appended at runtime):
- Male, 185cm, weight from latest weight_log entry
- Goal: adequate protein, clean eating
- Training: lifting 2-3x/week, beginner
- Dietary rules: no cow dairy (sheep/goat OK), avoids gluten/processed, Israeli/Mediterranean cooking
- Daily targets from user_settings

Output statuses: ready_to_log, needs_clarification, save_recurring, update_recurring

---

## App Structure
```
src/
  components/
    LogTab.tsx
    GraphsTab.tsx
    MealsTab.tsx
    SettingsTab.tsx
    BottomNav.tsx
  lib/
    supabase.ts
    types.ts
  App.tsx
  main.tsx
api/
  log.ts
  entries.ts
  recurring-meals.ts
  settings.ts
config/
  system_prompt.txt
public/
  manifest.json
  sw.js
```

## Design
- Dark theme (#0f172a background)
- Green (#16a34a) primary accent
- Mobile-first, one-thumb use
- Bottom nav with icons
- Satisfying confirmation cards after logging

## OpenRouter Config
- Base URL: https://openrouter.ai/api/v1
- Headers: HTTP-Referer: https://nutrilog.vercel.app, X-Title: NutriLog

## Important Constraints
- system_prompt.txt must be readable/editable by non-developer
- Past nutrition_log entries are immutable snapshots
- Cap conversation history at 6 messages
- Only send recurring meal names/aliases (not full data) in every request
- Use haiku for single-turn entries, sonnet for multi-turn
