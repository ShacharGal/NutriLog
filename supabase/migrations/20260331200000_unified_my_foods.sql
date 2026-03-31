-- Unified my_foods table: replaces personal_ingredients + recurring_meals
create table my_foods (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  name text not null unique,
  aliases text[],
  description text,
  ingredients_json jsonb,
  nutrients_per_100g jsonb not null,
  total_weight_g numeric(7,1),
  source text not null default 'usda'
);

-- Migrate personal_ingredients (simple foods)
insert into my_foods (name, aliases, nutrients_per_100g, source, created_at, updated_at)
select name, aliases, nutrients_per_100g, source, created_at, coalesce(updated_at, now())
from personal_ingredients
on conflict (name) do nothing;

-- Migrate recurring_meals (composite foods)
-- Calculate nutrients_per_100g from stored totals and estimated total weight
insert into my_foods (name, aliases, description, ingredients_json, nutrients_per_100g, total_weight_g, source, created_at, updated_at)
select
  name,
  aliases,
  meal_description,
  ingredients_json,
  jsonb_build_object(
    'calories', case when coalesce(tw.total_w, 0) > 0 then round(coalesce(calories, 0)::numeric / tw.total_w * 100) else coalesce(calories, 0) end,
    'protein',  case when coalesce(tw.total_w, 0) > 0 then round(coalesce(protein_g, 0) / tw.total_w * 100, 1) else coalesce(protein_g, 0) end,
    'carbs',    case when coalesce(tw.total_w, 0) > 0 then round(coalesce(carbs_g, 0) / tw.total_w * 100, 1) else coalesce(carbs_g, 0) end,
    'fat',      case when coalesce(tw.total_w, 0) > 0 then round(coalesce(fat_g, 0) / tw.total_w * 100, 1) else coalesce(fat_g, 0) end,
    'fiber',    case when coalesce(tw.total_w, 0) > 0 then round(coalesce(fiber_g, 0) / tw.total_w * 100, 1) else coalesce(fiber_g, 0) end
  ),
  tw.total_w,
  'homemade',
  created_at,
  updated_at
from recurring_meals rm
cross join lateral (
  select coalesce(sum((elem->>'amount')::numeric), 0) as total_w
  from jsonb_array_elements(rm.ingredients_json) as elem
  where (elem->>'amount') ~ '^\d+(\.\d+)?g?$'
) tw
on conflict (name) do nothing;

-- Drop old tables
drop table if exists personal_ingredients;
drop table if exists recurring_meals;
