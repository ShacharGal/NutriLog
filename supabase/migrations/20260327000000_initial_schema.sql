-- nutrition_log
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

-- recurring_meals
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

-- weight_log
create table weight_log (
  id uuid default gen_random_uuid() primary key,
  logged_at date default current_date,
  weight_kg numeric(4,1) not null
);
insert into weight_log (weight_kg) values (80);

-- user_settings
create table user_settings (
  id integer primary key default 1,
  daily_protein_target integer default 145,
  daily_calorie_target integer default 2400,
  updated_at timestamptz default now()
);
insert into user_settings (id) values (1);
