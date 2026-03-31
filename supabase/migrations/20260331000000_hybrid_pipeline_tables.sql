-- 1. personal_ingredients table
CREATE TABLE personal_ingredients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  name TEXT NOT NULL,
  aliases TEXT[],
  nutrients_per_100g JSONB NOT NULL,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_personal_ingredients_user_name
  ON personal_ingredients(user_id, name);

-- 2. personal_recipes table
CREATE TABLE personal_recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  name TEXT NOT NULL,
  aliases TEXT[],
  ingredients JSONB NOT NULL,
  total_nutrients JSONB,
  serving_weight_g NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_personal_recipes_user_name
  ON personal_recipes(user_id, name);

-- 3. usda_cache table
CREATE TABLE usda_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fdc_id INT,
  search_term TEXT NOT NULL,
  nutrients_per_100g JSONB NOT NULL,
  food_category TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usda_cache_search_term
  ON usda_cache(search_term);

-- 4. Alter nutrition_log
ALTER TABLE nutrition_log ADD COLUMN IF NOT EXISTS ingredients JSONB;
ALTER TABLE nutrition_log ADD COLUMN IF NOT EXISTS source_tier TEXT
  CHECK (source_tier IN ('personal','usda','llm','mixed'));
