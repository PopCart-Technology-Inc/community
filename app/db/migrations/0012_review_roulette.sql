-- Live site review roulette: people send a website to be reviewed on the PopCart Community live, one
-- entry per device per round; staff check each entry before it joins the wheel, and the host's wheel
-- draws who is next. Nothing that identifies the sender's device or connection is stored in the
-- clear: only keyed hashes scoped to the round, cleared when the next round starts. Entries are
-- deleted 90 days after they were sent (sweepReviews, on a timer).
CREATE TABLE review_rounds (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,           -- "live-202610221936", Manila time the round was made
  accepting  boolean NOT NULL DEFAULT false, -- entries open
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
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
  device_hash     bytea,                     -- HMAC(round, device cookie): one entry per device
  ip_hash         bytea,                     -- HMAC(round, address): a loose cap per connection
  -- pending: not yet checked by staff; waiting: in the draw; picked: on screen now
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'waiting', 'picked', 'reviewed', 'skipped')),
  picked_at       timestamptz,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, device_hash)
);
CREATE INDEX review_entries_round ON review_entries (round_id, created_at);
CREATE INDEX review_entries_ip ON review_entries (round_id, ip_hash);
CREATE INDEX review_entries_age ON review_entries (created_at);
-- one site on screen at a time per round, whatever races
CREATE UNIQUE INDEX review_entries_one_picked ON review_entries (round_id) WHERE status = 'picked';
