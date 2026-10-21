-- The staff host (decision 0009, points 7-9 and 12): the gate address of each staff member, staff
-- passkeys bound to the staff host, short staff sessions, one-time setup codes, and the audit log.

-- Keyed hash of the address on the gate list (same key as invites, decision 0008). The gate tells us
-- the address it let through; it must be this person's. The address itself is never stored.
ALTER TABLE staff_members ADD COLUMN email_hash bytea;
CREATE UNIQUE INDEX staff_members_email ON staff_members (email_hash);

CREATE TABLE staff_passkeys (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   bytea NOT NULL,
  counter      bigint NOT NULL DEFAULT 0,
  transports   text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX staff_passkeys_user ON staff_passkeys (user_id);

CREATE TABLE staff_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('enroll', 'login')),
  challenge  text NOT NULL,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Ends after 15 idle minutes, and after 12 hours whatever happens.
CREATE TABLE staff_sessions (
  id_hash      bytea PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX staff_sessions_user ON staff_sessions (user_id);

-- A code made on the public site by a signed-in staff member, typed on the staff host to set up a staff
-- passkey. Hash only, 10 minutes, one use.
CREATE TABLE staff_setup_codes (
  code_hash  bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Every staff action. Append-only: no one can change or delete a row, Overseers included. Handles are
-- copied in so an entry still reads correctly after an account is deleted.
CREATE TABLE staff_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid,
  actor_handle   text NOT NULL,
  kind           text NOT NULL CHECK (kind ~ '^[a-z_]{2,20}$'),
  text           text NOT NULL CHECK (char_length(text) <= 500),
  subject_id     uuid,
  subject_handle text,
  detail         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX staff_actions_at ON staff_actions (at DESC);
CREATE INDEX staff_actions_subject ON staff_actions (subject_id, at DESC);

CREATE FUNCTION staff_actions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_actions is append-only';
END
$$;
CREATE TRIGGER staff_actions_no_update BEFORE UPDATE OR DELETE ON staff_actions FOR EACH ROW EXECUTE FUNCTION staff_actions_append_only();
CREATE TRIGGER staff_actions_no_truncate BEFORE TRUNCATE ON staff_actions FOR EACH STATEMENT EXECUTE FUNCTION staff_actions_append_only();
