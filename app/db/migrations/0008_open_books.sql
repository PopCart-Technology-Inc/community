-- Open Books (decision 0009): the community's money, in public. Every amount is in centavos.
-- Sealed entries, anchors and published rules are append-only: the database refuses to change them.

CREATE FUNCTION books_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Open Books is append-only: % on % is refused', TG_OP, TG_TABLE_NAME;
END $$;

-- Trustees: members appointed by staff, in public.
CREATE TABLE books_trustees (
  user_id      uuid PRIMARY KEY REFERENCES users(id),
  appointed_by uuid REFERENCES users(id),
  appointed_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

-- Signing keys (ECDSA P-256 public JWK), made in the trustee's browser. Old keys stay so old signatures check.
-- The handle is kept as it was, so the ledger still names the signer after an account is deleted.
CREATE TABLE books_keys (
  key_id     text PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{16}$'),
  user_id    uuid NOT NULL REFERENCES users(id),
  handle     text NOT NULL,
  public_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX books_keys_active ON books_keys (user_id) WHERE retired_at IS NULL;

-- The published signing limit: one signature up to it, two above it. The latest row is the rule.
CREATE TABLE books_rules (
  id           serial PRIMARY KEY,
  two_sig_over bigint NOT NULL CHECK (two_sig_over >= 0),
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO books_rules (two_sig_over, set_by) VALUES (2000000, NULL);
CREATE TRIGGER books_rules_append_only BEFORE UPDATE OR DELETE ON books_rules FOR EACH ROW EXECUTE FUNCTION books_append_only();

-- Budgets per year and category. The latest row for a (year, category) is the budget; every change stays.
CREATE TABLE books_budgets (
  id       serial PRIMARY KEY,
  year     int NOT NULL CHECK (year BETWEEN 2026 AND 2100),
  category text NOT NULL,
  amount   bigint NOT NULL CHECK (amount >= 0),
  set_by   text NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER books_budgets_append_only BEFORE UPDATE OR DELETE ON books_budgets FOR EACH ROW EXECUTE FUNCTION books_append_only();

-- Drafts waiting for signatures. Not part of the ledger until sealed; public to read.
CREATE TABLE books_drafts (
  id         uuid PRIMARY KEY,
  body       jsonb NOT NULL,
  drafted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE books_draft_sigs (
  draft_id  uuid NOT NULL REFERENCES books_drafts(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  key_id    text NOT NULL REFERENCES books_keys(key_id),
  sig       text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, user_id)
);
CREATE TABLE books_draft_conflicts (
  draft_id    uuid NOT NULL REFERENCES books_drafts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  handle      text NOT NULL,
  note        text NOT NULL CHECK (char_length(note) <= 200),
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, user_id)
);

-- The ledger. `entry` is exactly what was hashed: { seq, prev, sealed_at, body, sigs, conflicted }.
CREATE TABLE books_entries (
  seq       int PRIMARY KEY CHECK (seq >= 1),
  hash      text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  entry     jsonb NOT NULL,
  sealed_at timestamptz NOT NULL
);
CREATE TRIGGER books_entries_append_only BEFORE UPDATE OR DELETE ON books_entries FOR EACH ROW EXECUTE FUNCTION books_append_only();
CREATE TRIGGER books_entries_no_truncate BEFORE TRUNCATE ON books_entries FOR EACH STATEMENT EXECUTE FUNCTION books_append_only();

-- Anchors: the Merkle root of entries 1..upto_seq. The OpenTimestamps proof may be attached once, later.
CREATE TABLE books_anchors (
  id         serial PRIMARY KEY,
  upto_seq   int NOT NULL UNIQUE REFERENCES books_entries(seq),
  root       text NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  made_by    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ots        bytea,
  stamped_at timestamptz
);
CREATE FUNCTION books_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ots IS NOT NULL OR NEW.root <> OLD.root OR NEW.upto_seq <> OLD.upto_seq
     OR NEW.made_by <> OLD.made_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Open Books anchors are append-only (a proof can be attached once)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER books_anchors_guard BEFORE UPDATE OR DELETE ON books_anchors FOR EACH ROW EXECUTE FUNCTION books_anchor_guard();

-- Bank match: the statement's closing balance for a date, next to the ledger's balance for that date.
CREATE TABLE books_reconciliations (
  id               serial PRIMARY KEY,
  statement_date   date NOT NULL,
  bank_balance     bigint NOT NULL,
  ledger_balance   bigint NOT NULL,
  statement_sha256 text CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  made_by          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER books_reconciliations_append_only BEFORE UPDATE OR DELETE ON books_reconciliations FOR EACH ROW EXECUTE FUNCTION books_append_only();
