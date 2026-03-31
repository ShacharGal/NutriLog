-- Add unique constraint on (user_id, name) for personal_ingredients to support upsert
ALTER TABLE personal_ingredients
  ADD CONSTRAINT personal_ingredients_user_name_unique UNIQUE (user_id, name);
