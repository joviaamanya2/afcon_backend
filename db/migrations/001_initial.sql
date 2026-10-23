CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  season TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Africa',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT,
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  short_name TEXT,
  country_code CHAR(3),
  region TEXT,
  crest_url TEXT,
  coach TEXT,
  competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT,
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT,
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  capacity INTEGER,
  accessibility_info TEXT,
  transport_info TEXT,
  timezone TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT,
  source_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  position TEXT,
  shirt_number INTEGER,
  date_of_birth DATE,
  club TEXT,
  photo_url TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT,
  source_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  stage TEXT,
  group_code TEXT,
  home_team_id UUID NOT NULL REFERENCES teams(id),
  away_team_id UUID NOT NULL REFERENCES teams(id),
  venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,
  kickoff_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','half_time','finished','postponed','cancelled')),
  home_score SMALLINT,
  away_score SMALLINT,
  half_time_home_score SMALLINT,
  half_time_away_score SMALLINT,
  home_penalty_score SMALLINT,
  away_penalty_score SMALLINT,
  broadcast TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT,
  source_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (home_team_id <> away_team_id)
);
CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches(kickoff_at);
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches(status);

CREATE TABLE IF NOT EXISTS match_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id),
  player_id UUID REFERENCES players(id),
  related_player_id UUID REFERENCES players(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('goal','own_goal','penalty','yellow_card','red_card','substitution','var','kickoff','half_time','full_time')),
  minute SMALLINT NOT NULL,
  added_time SMALLINT,
  detail TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS match_lineups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  is_starting BOOLEAN NOT NULL,
  shirt_number SMALLINT,
  position TEXT,
  formation TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(match_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_statistics (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  statistic TEXT NOT NULL,
  home_value NUMERIC,
  away_value NUMERIC,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(match_id, statistic)
);

CREATE TABLE IF NOT EXISTS standings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  group_code TEXT NOT NULL,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  played SMALLINT NOT NULL DEFAULT 0,
  won SMALLINT NOT NULL DEFAULT 0,
  drawn SMALLINT NOT NULL DEFAULT 0,
  lost SMALLINT NOT NULL DEFAULT 0,
  goals_for SMALLINT NOT NULL DEFAULT 0,
  goals_against SMALLINT NOT NULL DEFAULT 0,
  goal_difference SMALLINT NOT NULL DEFAULT 0,
  points SMALLINT NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_updated_at TIMESTAMPTZ,
  UNIQUE(competition_id, group_code, team_id)
);

CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body TEXT,
  author TEXT,
  category TEXT,
  region TEXT,
  image_url TEXT,
  image_rights TEXT,
  published_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  source_name TEXT
);

CREATE TABLE IF NOT EXISTS fan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  city TEXT NOT NULL,
  region TEXT,
  venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  booking_url TEXT,
  organizer TEXT,
  published BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','audio')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  captions JSONB NOT NULL DEFAULT '{}'::jsonb,
  territory TEXT,
  rights_start TIMESTAMPTZ,
  rights_end TIMESTAMPTZ,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  timezone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_follows (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, team_id)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  match_reminders BOOLEAN NOT NULL DEFAULT TRUE,
  kickoff_changes BOOLEAN NOT NULL DEFAULT TRUE,
  team_news BOOLEAN NOT NULL DEFAULT FALSE,
  tournament_news BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours_start TIME,
  quiet_hours_end TIME
);

CREATE TABLE IF NOT EXISTS community_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES community_comments(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((post_id IS NOT NULL)::int + (comment_id IS NOT NULL)::int = 1)
);

CREATE TABLE IF NOT EXISTS translation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  source_language TEXT NOT NULL DEFAULT 'en',
  target_language TEXT NOT NULL DEFAULT 'lg',
  state TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
-- Do not store raw audio by default. Any retention must be an explicit product choice.
