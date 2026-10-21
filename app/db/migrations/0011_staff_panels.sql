-- The Overseer and Admin panels (decision 0009, points 10-15): staff invites with a role, platform and
-- feature switches, two-person approvals, and suspensions that end on their own.

-- A staff invite names the role it gives and for how many days. NULL role: Overseer (made on the
-- server's command line only, point 14).
ALTER TABLE invites ADD COLUMN staff_role text REFERENCES staff_roles(name) ON UPDATE CASCADE;
ALTER TABLE invites ADD COLUMN staff_days int CHECK (staff_days BETWEEN 1 AND 366);

-- Switches that change Community for everyone. Joining stays invite-only in code until open joining
-- is built (decision 0006), so it is not a row here.
CREATE TABLE platform_switches (
  key        text PRIMARY KEY CHECK (key IN ('launched', 'read_only')),
  is_on      boolean NOT NULL,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_switches (key, is_on) VALUES ('launched', false), ('read_only', false);

-- Feature switches: one for staging, one for production. Production needs two Overseers.
CREATE TABLE feature_switches (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_.]{1,40}$'),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 60),
  staging    boolean NOT NULL DEFAULT false,
  production boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Two people for the big ones (point 11): asked by one Overseer, decided by another within 72 hours.
-- Only one waiting request per thing (`key`), so two asks can't race.
CREATE TABLE staff_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('overseer_add', 'overseer_remove', 'switch', 'feature')),
  key         text NOT NULL,
  title       text NOT NULL CHECK (char_length(title) <= 200),
  payload     jsonb NOT NULL DEFAULT '{}',
  asked_by    uuid NOT NULL REFERENCES users(id),
  asked_at    timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved', 'declined', 'withdrawn', 'expired')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500)
);
CREATE UNIQUE INDEX staff_approvals_one_waiting ON staff_approvals (key) WHERE status = 'waiting';
CREATE INDEX staff_approvals_status ON staff_approvals (status, asked_at DESC);

-- A suspension from the Admin panel ends on its own (7 days at most). NULL: until decided otherwise.
ALTER TABLE users ADD COLUMN suspended_until timestamptz;
