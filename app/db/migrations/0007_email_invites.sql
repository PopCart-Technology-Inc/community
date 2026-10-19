-- Invites go to an email address (decision 0008). The address is never stored: only a keyed hash of
-- it, to match the person who types it on the join page. It is cleared when the invite is used.
-- Link-only invites (a code in the URL, which anyone could pass on) stop working here.
ALTER TABLE invites ADD COLUMN email_hash bytea;
-- After the emailed code is checked, a short-lived join ticket (hash only) carries the invite to the passkey step.
ALTER TABLE invites ADD COLUMN ticket_hash bytea;
ALTER TABLE invites ADD COLUMN ticket_expires_at timestamptz;
UPDATE invites SET expires_at = now() WHERE email_hash IS NULL AND used_at IS NULL AND expires_at > now();
CREATE INDEX invites_email ON invites (email_hash) WHERE used_at IS NULL;
CREATE UNIQUE INDEX invites_ticket ON invites (ticket_hash);

-- One-time 6-digit codes sent to an invited address. Hashes only; a row lives 10 minutes at most.
CREATE TABLE email_codes (
  email_hash bytea PRIMARY KEY,
  code_hash  bytea NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
