-- PopCart Community platform schema. Decision 0001: store only what a feature needs.
-- No phone numbers, legal names or ID data live here: those belong in the separate sealed vault.

-- Places (decision 0005): the area hierarchy. Philippine codes follow the PSGC; other countries use
-- 'CC' (ISO 3166-1 alpha-2) and 'CC-city-slug'. 'WORLD' is the root.
CREATE TABLE areas (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  level       text NOT NULL CHECK (level IN ('world', 'country', 'region', 'province', 'city', 'barangay')),
  parent_code text REFERENCES areas(code),
  -- the ancestors used by the feed levels, filled on import
  city_code    text,
  region_code  text,
  country_code text
);
CREATE INDEX areas_parent ON areas (parent_code);
CREATE INDEX areas_name ON areas (lower(name));

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           text NOT NULL CHECK (handle ~ '^[a-z0-9._]{3,30}$'),
  first_name       text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 40),
  trade            text NOT NULL DEFAULT 'other' CHECK (trade IN ('rider', 'fresh', 'grill', 'grocery', 'creator', 'tutor', 'coder', 'other')),
  bio              text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  home_area        text REFERENCES areas(code),
  avatar_media_id  uuid,
  cover_media_id   uuid,
  role             text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'staff')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  terms_version    text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  -- improvement data (decision 0001, point 6): off unless the person switches it on
  improve_usage    boolean NOT NULL DEFAULT false,
  improve_surveys  boolean NOT NULL DEFAULT false,
  -- end-to-end messaging: the person's public key (JWK, ECDH P-256), made in their browser
  dm_public_key    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_handle ON users (handle);

-- Invite-only joining until the privacy lawyer's review (decision 0006, point 8).
CREATE TABLE invites (
  code_hash  bytea PRIMARY KEY,
  created_by uuid REFERENCES users(id),
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 80),
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'staff')),
  expires_at timestamptz NOT NULL,
  used_by    uuid REFERENCES users(id),
  used_at    timestamptz
);

CREATE TABLE passkeys (
  id           text PRIMARY KEY,               -- credential id, base64url
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   bytea NOT NULL,
  counter      bigint NOT NULL DEFAULT 0,
  transports   text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('register', 'login')),
  challenge  text NOT NULL,
  -- register: the pending profile (from an invite) waiting for its passkey
  pending    jsonb,
  expires_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  id_hash    bytea PRIMARY KEY,                 -- sha256 of the cookie value; the value is never stored
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes      integer NOT NULL CHECK (bytes > 0 AND bytes <= 4000000),
  width      integer,
  height     integer,
  sha256     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Posts and replies. Area codes are copied from the author's chosen place at write time, so each
-- Places level filters on one column. reach = the widest level the post may appear at.
CREATE TABLE posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  reply_to      uuid REFERENCES posts(id) ON DELETE CASCADE,
  space_id      uuid,
  media_ids     uuid[] NOT NULL DEFAULT '{}',
  reach         text NOT NULL DEFAULT 'city' CHECK (reach IN ('barangay', 'city', 'region', 'country', 'world')),
  area_code     text REFERENCES areas(code),  -- the precise area the author chose
  barangay_code text,
  city_code     text,
  region_code   text,
  country_code  text,
  lang          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX posts_author ON posts (author_id, created_at DESC);
CREATE INDEX posts_reply ON posts (reply_to, created_at);
CREATE INDEX posts_space ON posts (space_id, created_at DESC);
CREATE INDEX posts_city ON posts (city_code, created_at DESC);
CREATE INDEX posts_region ON posts (region_code, created_at DESC);
CREATE INDEX posts_country ON posts (country_code, created_at DESC);
CREATE INDEX posts_barangay ON posts (barangay_code, created_at DESC);

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON follows (followee_id);

-- Salamat: ten a week per person (Monday reset, Asia/Manila), one per post, never for yourself.
CREATE TABLE salamats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  giver_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  gig_id      uuid,
  tags        text[] NOT NULL DEFAULT '{}',
  week        text NOT NULL,                  -- ISO week in Asia/Manila, e.g. 2026-W43
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (giver_id <> receiver_id)
);
CREATE UNIQUE INDEX salamats_once_per_post ON salamats (giver_id, post_id) WHERE post_id IS NOT NULL;
CREATE INDEX salamats_week ON salamats (giver_id, week);
CREATE INDEX salamats_post ON salamats (post_id);

CREATE TABLE saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid REFERENCES posts(id) ON DELETE CASCADE,
  gig_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saves_post ON saves (user_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX saves_gig ON saves (user_id, gig_id) WHERE gig_id IS NOT NULL;

-- Spaces (decision 0003): groups per barangay, trade or crew, with channels, roles and public rules.
CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 60),
  kind       text NOT NULL CHECK (kind IN ('barangay', 'trade', 'crew')),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  area_code  text REFERENCES areas(code),
  about      text NOT NULL DEFAULT '' CHECK (char_length(about) <= 500),
  rules      text NOT NULL DEFAULT '' CHECK (char_length(rules) <= 2000),
  cover_media_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE space_members (
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  pinned       boolean NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user ON space_members (user_id);

CREATE TABLE channels (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name     text NOT NULL CHECK (name ~ '^[a-z0-9-]{2,30}$'),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (space_id, name)
);

-- Channel messages. In a private Space the body is ciphertext (decision 0001, point 4): `body` holds
-- the plaintext only for public Spaces; `sealed` holds the encrypted envelope for private ones.
CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text CHECK (char_length(body) <= 4000),
  sealed     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((body IS NULL) <> (sealed IS NULL))
);
CREATE INDEX messages_channel ON messages (channel_id, created_at);

-- Direct messages: always end-to-end encrypted. The server stores only the envelope it cannot read.
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- a stranger's first message waits in Requests until accepted
  accepted   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE TABLE dm_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed          jsonb NOT NULL,             -- { v, iv, ct } AES-GCM under an ECDH-derived key
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dm_messages_conv ON dm_messages (conversation_id, created_at);

-- Work: gigs, applications with proof, person-to-person pay, criteria ratings.
CREATE TABLE gigs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id      uuid REFERENCES spaces(id) ON DELETE SET NULL,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 80),
  body          text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 2000),
  pay_amount    integer NOT NULL CHECK (pay_amount > 0),   -- whole pesos
  pay_currency  text NOT NULL DEFAULT 'PHP',
  pay_unit      text NOT NULL CHECK (pay_unit IN ('fixed', 'hour', 'day', 'night', 'run')),
  pay_note      text NOT NULL DEFAULT '' CHECK (char_length(pay_note) <= 60),
  when_text     text NOT NULL CHECK (char_length(when_text) BETWEEN 2 AND 80),
  paid_how      text NOT NULL CHECK (char_length(paid_how) BETWEEN 2 AND 60),
  skills        text[] NOT NULL DEFAULT '{}',
  area_code     text REFERENCES areas(code),
  barangay_code text,
  city_code     text,
  region_code   text,
  country_code  text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gigs_open ON gigs (status, created_at DESC);
CREATE INDEX gigs_city ON gigs (city_code, created_at DESC);

CREATE TABLE applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gig_id         uuid NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  applicant_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  credential_ids uuid[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'picked', 'declined', 'withdrawn')),
  done_by_poster    timestamptz,
  done_by_applicant timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gig_id, applicant_id)
);

CREATE TABLE ratings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gig_id     uuid NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  rater_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  on_time    smallint NOT NULL CHECK (on_time BETWEEN 1 AND 5),
  quality    smallint NOT NULL CHECK (quality BETWEEN 1 AND 5),
  easy       smallint NOT NULL CHECK (easy BETWEEN 1 AND 5),
  again      smallint NOT NULL CHECK (again BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gig_id, rater_id),
  CHECK (rater_id <> ratee_id)
);

-- Signed proof (decision 0001, point 2): a W3C Verifiable Credential the person holds and shows.
CREATE TABLE credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer      text NOT NULL,
  type        text NOT NULL,
  summary     text NOT NULL CHECK (char_length(summary) <= 120),  -- e.g. "1,240 deliveries · 97% on time"
  as_of       timestamptz NOT NULL,
  vc          jsonb NOT NULL,             -- the credential as issued, with its proof
  verified    boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  shown       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Safety: reports, moderation actions (every action logged and shown to the person), appeals.
CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind  text NOT NULL CHECK (target_kind IN ('post', 'message', 'dm', 'user', 'gig', 'space')),
  target_id    uuid NOT NULL,
  space_id     uuid,
  reason       text NOT NULL CHECK (reason IN ('scam', 'harassment', 'private_info', 'violence', 'child_safety', 'other')),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  -- for a reported DM: the messages the reporter chose to reveal, decrypted on their phone
  revealed     jsonb,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'warned', 'removed', 'escalated')),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  decision_note text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_open ON reports (status, created_at);

CREATE TABLE mod_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES users(id),
  subject_id  uuid REFERENCES users(id) ON DELETE SET NULL,  -- whose content it was
  action      text NOT NULL CHECK (action IN ('keep', 'warn', 'remove', 'suspend', 'restore', 'escalate')),
  target_kind text NOT NULL,
  target_id   uuid NOT NULL,
  report_id   uuid REFERENCES reports(id) ON DELETE SET NULL,
  reason      text NOT NULL DEFAULT '',
  appealed_at timestamptz,
  appeal_decision text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mod_actions_subject ON mod_actions (subject_id, created_at DESC);

-- Legal requests: counts only here, for the transparency report. Who and what live in the vault.
CREATE TABLE legal_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL,
  basis       text NOT NULL CHECK (basis IN ('court_order', 'warrant', 'risk_to_life', 'other')),
  outcome     text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'produced', 'refused')),
  decided_at  timestamptz
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('salamat', 'reply', 'follow', 'space_post', 'gig', 'application', 'picked', 'mod_action', 'records_opened')),
  actor_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  ref_kind   text,
  ref_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

INSERT INTO areas (code, name, level, parent_code, country_code) VALUES ('WORLD', 'World', 'world', NULL, NULL);
