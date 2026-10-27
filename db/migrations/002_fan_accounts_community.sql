ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_unique
  ON app_users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_post_likes (
  post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_posts_feed_idx
  ON community_posts (status, created_at DESC);

CREATE INDEX IF NOT EXISTS community_comments_post_feed_idx
  ON community_comments (post_id, status, created_at);

CREATE INDEX IF NOT EXISTS content_reports_post_idx
  ON content_reports (post_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_post_media (
  post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position >= 0),
  url TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  PRIMARY KEY (post_id, position)
);

CREATE TABLE IF NOT EXISTS community_media_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime'
  )),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
