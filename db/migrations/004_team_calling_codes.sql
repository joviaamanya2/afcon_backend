ALTER TABLE teams
  ALTER COLUMN country_code TYPE TEXT
  USING NULLIF(BTRIM(country_code), '');
