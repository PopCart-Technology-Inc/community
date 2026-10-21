-- Staff roles and scopes (decision 0009, point 10). A role is a named list of scopes; the server checks
-- scopes (app/http/scopes.ts), never role names. "staff" stops being a flag on the account: a person is
-- staff while they hold a role that has not ended. Today's staff accounts become Overseers.
CREATE TABLE staff_roles (
  name       text PRIMARY KEY CHECK (name ~ '^[A-Za-z][A-Za-z &]{2,29}$'),
  -- Ignored for Overseer, which holds every scope in code.
  scopes     text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO staff_roles (name, scopes) VALUES
  ('Overseer', '{}'),
  ('Moderator', '{reports.review,reports.child_safety,accounts.suspend,people.lookup}'),
  ('Support', '{people.lookup,invites.send,passkeys.reset}'),
  ('Developer', '{ops.health,switches.staging,apps.manage}');

CREATE TABLE staff_members (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES staff_roles(name) ON UPDATE CASCADE,
  -- When the role ends on its own unless renewed. Overseers have no end date.
  ends_at    timestamptz,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'Overseer' OR ends_at IS NULL)
);
CREATE INDEX staff_members_role ON staff_members (role);

-- Every staff account that still exists becomes an Overseer; a deleted one gets no role.
INSERT INTO staff_members (user_id, role) SELECT id, 'Overseer' FROM users WHERE role = 'staff' AND status <> 'deleted';
CREATE INDEX reports_target ON reports (target_kind, target_id, reason);

ALTER TABLE users DROP COLUMN role;
