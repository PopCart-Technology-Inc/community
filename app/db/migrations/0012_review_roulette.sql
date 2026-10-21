-- Live site review roulette: people send a website to be reviewed on the PopCart Community live, one
-- entry per person per round, and the host's wheel draws who is next. The address of the person who
-- sent it is never stored: only a keyed hash, scoped to the round, to hold one entry per viewer.
-- Entries are deleted 90 days after they were sent (swept by the module on every visit).
CREATE TABLE review_rounds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,           -- "live-202610221936", Manila time the round was made
  accepting  boolean NOT NULL DEFAULT false, -- entries open
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_rounds_latest ON review_rounds (created_at DESC);

CREATE TABLE review_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  url             text NOT NULL,
  name            text NOT NULL,             -- the name read out on the live
  handle          text NOT NULL DEFAULT '',  -- chat handle, optional
  signature       text NOT NULL,             -- the typed full name
  consent_version text NOT NULL,
  consented_at    timestamptz NOT NULL DEFAULT now(),
  ip_hash         bytea NOT NULL,            -- HMAC(round, address): one entry per viewer per round
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'picked', 'reviewed', 'skipped')),
  picked_at       timestamptz,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, ip_hash)
);
CREATE INDEX review_entries_round ON review_entries (round_id, created_at);
CREATE INDEX review_entries_age ON review_entries (created_at);
