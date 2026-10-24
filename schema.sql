-- Svinn – PostgreSQL schema (Aiven)
-- Kjør: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- ── Brukere ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name           TEXT        NOT NULL,
  display_name   TEXT,
  email          TEXT        UNIQUE NOT NULL,
  phone          TEXT,
  password_hash  TEXT        NOT NULL,
  role           TEXT        DEFAULT 'buyer' CHECK (role IN ('buyer','seller','both')),
  mattilsynet_registered BOOLEAN DEFAULT FALSE,
  seller_verified        BOOLEAN DEFAULT FALSE,
  tos_accepted           BOOLEAN DEFAULT FALSE,
  tos_accepted_at        TIMESTAMPTZ,
  buyer_rating           NUMERIC(3,2),
  seller_rating          NUMERIC(3,2),
  buyer_rating_count     INT     DEFAULT 0,
  seller_rating_count    INT     DEFAULT 0,
  can_buy                BOOLEAN DEFAULT TRUE,
  can_sell               BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ── Annonser ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  seller_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  category         TEXT,
  price            NUMERIC(10,2),
  original_price   NUMERIC(10,2),
  deal_price       NUMERIC(10,2),
  address          TEXT,
  lat              NUMERIC(10,7),
  lng              NUMERIC(10,7),
  expiry_date      DATE,
  pickup_deadline  TIMESTAMPTZ,
  status           TEXT        DEFAULT 'active',
  barcode          TEXT,
  image_url        TEXT,
  description      TEXT,
  distance_km      NUMERIC(5,2),
  store            TEXT,
  is_opened        BOOLEAN     DEFAULT FALSE,
  is_homemade      BOOLEAN     DEFAULT FALSE,
  allergens        TEXT[],
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Avtaler ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  listing_id                     TEXT        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id                       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id                      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                          TEXT,
  category                       TEXT,
  address                        TEXT,
  deal_price                     NUMERIC(10,2),
  original_price                 NUMERIC(10,2),
  status                         TEXT        DEFAULT 'reserved',
  pickup_deadline                TIMESTAMPTZ,
  reserved_at                    TIMESTAMPTZ DEFAULT NOW(),
  delay_notified                 BOOLEAN     DEFAULT FALSE,
  delay_notified_at              TIMESTAMPTZ,
  cancel_reason                  TEXT,
  completion_confirmed_by_buyer  BOOLEAN     DEFAULT FALSE,
  completion_confirmed_by_seller BOOLEAN     DEFAULT FALSE,
  archived                       BOOLEAN     DEFAULT FALSE,
  archived_at                    TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Meldinger ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  deal_id    TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  sender_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT        NOT NULL,
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Vurderinger ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  deal_id      TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_user_id TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_context TEXT        NOT NULL CHECK (role_context IN ('buyer_rates_seller','seller_rates_buyer')),
  score        SMALLINT    NOT NULL CHECK (score BETWEEN 1 AND 5),
  reason_tags  TEXT[],
  comment      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (deal_id, from_user_id)
);

-- ── Rapporter ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  reporter_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT        NOT NULL CHECK (target_type IN ('user','listing','deal','problem')),
  target_id    TEXT,
  reason       TEXT        NOT NULL,
  note         TEXT,
  reviewed     BOOLEAN     DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_reviewed ON reports(reviewed);

-- ── Push-tokens ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  platform   TEXT,       -- 'ios' | 'android'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indekser ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_listings_seller   ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_deals_buyer       ON deals(buyer_id);
CREATE INDEX IF NOT EXISTS idx_deals_seller      ON deals(seller_id);
CREATE INDEX IF NOT EXISTS idx_deals_listing     ON deals(listing_id);
CREATE INDEX IF NOT EXISTS idx_messages_deal     ON messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_ratings_to_user   ON ratings(to_user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user  ON push_tokens(user_id);

-- ── v1.1: Sign in with Apple, bilder, møteavtaler, blokkering ────────────────
-- Alle endringer under er idempotente fordi migrate() kjører hele filen ved oppstart.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS storage TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS weight_g INT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS product_image_url TEXT;

CREATE TABLE IF NOT EXISTS listing_images (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  listing_id  TEXT        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('front','date','extra')),
  mime        TEXT        NOT NULL DEFAULT 'image/jpeg',
  data        BYTEA       NOT NULL,
  sort        SMALLINT    DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id);

ALTER TABLE deals ADD COLUMN IF NOT EXISTS meetup_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS proposed_by TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text';

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS no_show_party TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reported_user_id TEXT;

-- Cache for Kassalapp-oppslag (60 kall/min per nøkkel deles av alle brukere)
CREATE TABLE IF NOT EXISTS product_cache (
  ean         TEXT        PRIMARY KEY,
  product     JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);
