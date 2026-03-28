# NutriLog — Full Specification

## OVERVIEW

A mobile-first Progressive Web App (Android) for logging meals via
natural language chat. An AI parses free text into structured
nutritional data, stores it in Supabase, and visualizes it over time.

---

## TECH STACK

- Frontend: React + TypeScript + Vite, configured as a PWA
- Styling: Tailwind CSS
- Backend: Vercel serverless functions (API routes)
- Database: Supabase
- AI: OpenRouter API
  - Use: openrouter.ai/api/v1/chat/completions
  - Model for parsing: anthropic/claude-haiku-4-5 (cheap, fast)
  - Model for ambiguous/multi-turn: anthropic/claude-sonnet-4-6
- Deployment: Vercel
- Repo: GitHub (private)

---

## SETUP APPROACH — use CLIs throughout, no manual dashboard clicks

Step 1 — Supabase:
- Install Supabase CLI: brew install supabase/tap/supabase (Mac)
  or via npm: npx supabase
- supabase login
- supabase projects create nutrilog (note the project ref)
- supabase link --project-ref <ref>
- Run all SQL schema via: supabase db push
- Fetch keys via: supabase projects api-keys --project-ref <ref>

Step 2 — GitHub repo:
- gh repo create nutrilog --private --clone (requires GitHub CLI)
- Or walk me through creating it manually if gh CLI not installed

Step 3 — Vercel:
- npm i -g vercel
- vercel login
- vercel link (from project root)
- vercel env add (for each env variable)
- vercel --prod for deployment

All credentials stay in .env.local locally
and in Vercel's env dashboard (set via CLI).

---

## DATABASE SCHEMA (Supabase)

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
-- insert starting weight
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

## ENVIRONMENT VARIABLES

The app needs these env vars, both in .env.local and in Vercel:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- OPENROUTER_API_KEY
- VITE_SUPABASE_URL (same value, exposed to frontend)
- VITE_SUPABASE_ANON_KEY (same value, exposed to frontend)

---

## APP STRUCTURE

```
src/
  components/
    LogTab.tsx      ← main chat logger
    GraphsTab.tsx   ← visualizations
    MealsTab.tsx    ← recurring meals management
    SettingsTab.tsx ← weight logging, targets, export
    BottomNav.tsx   ← 4-tab navigation
  lib/
    supabase.ts     ← supabase client
    types.ts        ← shared TypeScript types
  App.tsx
  main.tsx

api/
  log.ts              ← POST: chat turn → AI → maybe write to DB
  entries.ts          ← GET: fetch log rows with filters
  recurring-meals.ts  ← GET/POST/DELETE recurring meals
  settings.ts         ← GET/PUT user settings

config/
  system_prompt.txt   ← AI instructions (editable)

public/
  manifest.json       ← PWA manifest
  sw.js               ← service worker
```

---

## SYSTEM PROMPT (save to config/system_prompt.txt)

The serverless function reads this file at runtime. Here is the
exact content:

---
You are a nutrition logging assistant for a specific user.
Your job is to parse meal descriptions into structured nutritional
data and help the user track their diet.

USER PROFILE:
- Male, 185cm, weight is dynamic (fetched from DB — use provided value)
- Goal: adequate protein intake and clean, healthy eating
- Training: lifting weights 2-3x per week, beginner, health-focused
- Daily targets: ~145g protein, ~2400 calories (adjust if user updates)

DIETARY RULES (important for grading):
- Does NOT eat cow dairy. Sheep and goat dairy are fine.
- Avoids gluten and processed foods (not strict, but preferred)
- Cuisine context: Israeli/Mediterranean home cooking is typical

BEHAVIOR:
1. When the user describes a meal, decide if you have enough info
   to estimate macros confidently.
   - If yes: respond with a JSON object (see schema below)
   - If no: ask ONE concise clarifying question, then wait
   - Never ask more than 2 clarifying questions before logging anyway
   - Simple meals (2 eggs, a banana, coffee): always log immediately

2. If the user types a name matching a recurring meal (e.g. "my
   usual breakfast", "the green smoothie"): log it immediately using
   the provided recurring meal data, no clarification needed.

3. If the user has logged a very similar meal 3+ times and it has
   no saved name, proactively suggest saving it as a recurring meal.
   Example: "You've had this a few times — want me to save it?
   What should I call it?"

4. If the user says "save this as X" or "call it X": respond with
   status "save_recurring" and the full nutritional data.

5. If the user says "update my X" or "change X to include Y":
   respond with status "update_recurring".

HEALTH GRADING (health_grade field: A/B/C/D/F):
- A: protein-dense, whole foods, fits dietary rules
- B: good meal, minor concerns (some processing, low protein)
- C: acceptable nutrition, notable concerns
- D: poor nutritional profile or significant rule violations
- F: mostly junk, heavy processing, multiple violations

ESTIMATION APPROACH:
- Be confident, not hedgy. Make a reasonable estimate.
- For Israeli/Mediterranean dishes use typical local recipes
- For home cooking, assume moderate oil use unless stated otherwise
- Protein is the most important macro to get right

OUTPUT SCHEMA (always respond with valid JSON, nothing else):

For a loggable entry:
```json
{
  "status": "ready_to_log",
  "meal_description": "string",
  "ingredients": [{"name": "string", "amount": "string"}],
  "calories": number,
  "protein_g": number,
  "fiber_g": number,
  "carbs_g": number,
  "fat_g": number,
  "health_grade": "A|B|C|D|F",
  "grade_reasoning": "string (1-2 sentences)",
  "notes": "string|null"
}
```

For clarification needed:
```json
{
  "status": "needs_clarification",
  "question": "string"
}
```

For saving a recurring meal:
```json
{
  "status": "save_recurring",
  "suggested_name": "string",
  "meal_description": "string",
  "ingredients": [...],
  "calories": number,
  "protein_g": number,
  "fiber_g": number,
  "carbs_g": number,
  "fat_g": number,
  "health_grade": "A|B|C|D|F"
}
```

For updating a recurring meal:
```json
{
  "status": "update_recurring",
  "name": "string",
  "meal_description": "string",
  "ingredients": [...],
  "calories": number,
  "protein_g": number,
  "fiber_g": number,
  "carbs_g": number,
  "fat_g": number,
  "health_grade": "A|B|C|D|F"
}
```
---

---

## SERVERLESS FUNCTION: api/log.ts

This is the core function. It:
1. Receives: { message, conversationHistory, todaysSummary,
              recurringMeals, userSettings }
2. Reads config/system_prompt.txt
3. Appends context to the system prompt:
   - User's current weight from latest weight_log entry
   - Today's running totals (calories so far, protein so far)
   - List of saved recurring meal names and aliases
4. Calls OpenRouter with the full conversation history
5. Parses the JSON response
6. If status is "ready_to_log": writes to nutrition_log table,
   returns the logged entry + confirmation message
7. If status is "needs_clarification": returns the question,
   does NOT write to DB
8. If status is "save_recurring": writes to recurring_meals table,
   also writes to nutrition_log, returns confirmation
9. If status is "update_recurring": updates recurring_meals row,
   does NOT modify past nutrition_log entries (snapshots are sacred)
10. Returns structured response to frontend

Important: conversation history is capped at 6 messages max
(3 turns) to control token usage. Older turns are dropped.

---

## LOG TAB (src/components/LogTab.tsx)

UI: chat interface, mobile-optimized
- Message thread at top (scrollable)
- Text input + send button fixed at bottom
- Input auto-focuses on load

Behavior:
- User types meal description, hits send
- Message appears in thread immediately
- Loading indicator while API call is in flight
- On response:
  - If clarification: Claude's question appears, user can reply
  - If logged: confirmation card appears showing:
    calories | protein | fiber | grade (colored badge)
    + brief grade_reasoning
  - Thread resets after successful log (fresh conversation for
    next meal), but shows a persistent "today's log" summary
    at the top: "Today: Xkcal | Xg protein"

Today's summary bar (top of tab):
- Pulls today's entries from Supabase on mount
- Shows: calories so far / target, protein so far / target
- Simple progress bars, updates after each log

CONVERSATION SESSION RULES:
- Each meal entry is its own conversation thread
- Thread resets automatically after status "ready_to_log"
  is received and confirmed
- Thread also resets if user types "done", "next", or "new meal"
- Multi-turn clarification (status "needs_clarification")
  keeps the thread alive — same meal, continuing conversation
- Conversation history sent to API is always scoped to the
  current meal thread only (never bleeds across meals)
- Max 6 messages per thread before forcing a log anyway

---

## GRAPHS TAB (src/components/GraphsTab.tsx)

Use Recharts library.

Charts (all use data from nutrition_log):

1. Protein over time — line chart, last 14 days
   - Daily protein vs. target line (dashed)

2. Calories over time — bar chart, last 14 days
   - Target line overlay

3. Macro breakdown — stacked bar, last 7 days
   - protein / carbs / fat per day

4. Health grade trend — last 14 days
   - Convert grades to numbers (A=5, B=4, C=3, D=2, F=1)
   - Line chart with colored dots per grade

Date range selector: 7 days / 14 days / 30 days (toggle buttons)

---

## MY MEALS TAB (src/components/MealsTab.tsx)

- List of all saved recurring meals
- Each card shows: name, calories, protein, grade badge
- Tap to expand: full macro breakdown + ingredients list
- Delete button (with confirm prompt)
- Note at top: "Create and edit meals by chatting in the Log tab"

---

## SETTINGS TAB (src/components/SettingsTab.tsx)

Fields (editable, auto-save on blur):
- Daily protein target (g)
- Daily calorie target (kcal)

Weight logging:
- "Log weight" input: number field + "Save" button that inserts
  a new row into weight_log with today's date
- Show weight history: last 5 entries with date + value
- The system prompt context uses the most recent weight_log entry
  as current weight

Export section:
- "Export CSV" button: downloads nutrition_log as CSV
  (all time, or date range picker: last 7/30/90 days / all)
- "Copy week summary" button: generates a plain text summary
  of the last 7 days (total calories, protein, avg grade,
  meals logged) and copies to clipboard — ready to paste into
  Claude for analysis

---

## PWA CONFIGURATION

manifest.json:
- name: "NutriLog"
- short_name: "NutriLog"
- theme_color: #16a34a (green-600)
- background_color: #0f172a (dark)
- display: standalone
- orientation: portrait
- icons: generate a simple green circle with "N"
  at 192x192 and 512x512

Service worker: basic offline support, cache shell assets.
The app should be installable on Android Chrome.

---

## DESIGN

- Dark theme throughout
- Green (#16a34a) as primary accent (health/food association)
- Mobile-first, designed for one-thumb use
- Bottom navigation bar with icons:
  Log (chat bubble) | Graphs (chart) | Meals (bookmark) | Settings (gear)
- Smooth, clean — not cluttered
- Confirmation cards after logging should feel satisfying,
  like a small reward

---

## IMPORTANT CONSTRAINTS

1. The system_prompt.txt file must be readable and editable
   by a non-developer. Make it a clean plaintext file with
   clear sections, not embedded in code.

2. All past nutrition_log entries are immutable snapshots.
   Updating a recurring meal NEVER touches past log entries.

3. Token efficiency:
   - Cap conversation history at 6 messages
   - Do not embed full recurring meal nutritional data in every
     request — only send names/aliases for matching, then fetch
     full data only when a match is detected
   - Use haiku for all single-turn entries

4. OpenRouter specific:
   - Base URL: https://openrouter.ai/api/v1
   - Add header: HTTP-Referer: https://nutrilog.vercel.app
   - Add header: X-Title: NutriLog

---

## BUILD ORDER

1. Repo + Supabase + Vercel setup (guided)
2. Database tables creation (SQL provided above)
3. Environment variables setup
4. Vite + React + Tailwind + PWA base config
5. Supabase client and TypeScript types
6. api/log.ts serverless function + system_prompt.txt
7. LogTab — core chat UI + logging flow
8. api/entries.ts + api/recurring-meals.ts + api/settings.ts
9. GraphsTab with Recharts
10. MealsTab
11. SettingsTab with export
12. BottomNav + App.tsx routing
13. PWA manifest + service worker
14. Deploy to Vercel + test on Android
