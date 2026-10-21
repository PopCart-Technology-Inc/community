// Staff scopes (decision 0009, point 10). A role is a named list of scopes; the server checks scopes,
// never role names, so a new role needs no new code. The list of scopes is fixed here: adding one is a
// code change with its own review. The Overseer role holds every scope and cannot be edited.
export const OVERSEER = 'Overseer';

/** Scopes a role can be given, by group, with how much harm a wrong use could do. */
export const SCOPE_GROUPS = [
  ['Safety', [
    ['reports.review', 'Review reports', 'See reports from every Space and decide Keep, Warn, Remove or Escalate; decide appeals; delete any post', 'Med'],
    ['reports.child_safety', 'Child-safety reports', 'See and decide child-safety reports, which are hidden at once', 'High'],
    ['accounts.suspend', 'Suspend accounts', 'Suspend a person or remove a direct message from a report', 'High'],
  ]],
  ['People', [
    ['people.lookup', 'Look people up', 'Public profile and account status only', 'Low'],
    ['invites.send', 'Send invites', 'Invite a member by email while joining is invite-only', 'Low'],
    ['passkeys.reset', 'Reset lost passkeys', 'Start a reset that the person confirms by email', 'High'],
  ]],
  ['Engineering', [
    ['ops.health', 'Health', 'Status, error messages (never personal data), jobs, migrations', 'Low'],
    ['switches.staging', 'Staging switches', 'Turn feature switches on or off in staging', 'Med'],
    ['apps.manage', 'API apps', 'API apps and webhooks', 'Med'],
  ]],
  ['Live', [
    ['review.host', 'Run the live review', 'Open and close entries, check entries, spin the wheel, remove entries', 'Med'],
  ]],
] as const;

/** Scopes only the Overseer role holds. They are never offered when editing a role. */
export const OVERSEER_SCOPES = ['staff.manage', 'roles.manage', 'switches.platform', 'approvals.decide', 'vault.request', 'audit.read'] as const;

export type RoleScope = (typeof SCOPE_GROUPS)[number][1][number][0];
export type Scope = RoleScope | (typeof OVERSEER_SCOPES)[number];

export const ROLE_SCOPES: readonly RoleScope[] = SCOPE_GROUPS.flatMap(([, list]) => list.map(([id]) => id));
export const ALL_SCOPES: readonly Scope[] = [...ROLE_SCOPES, ...OVERSEER_SCOPES];

export const isRoleScope = (s: unknown): s is RoleScope => typeof s === 'string' && (ROLE_SCOPES as readonly string[]).includes(s);

/** The scopes a role grants: every scope for Overseer, otherwise the known scopes on its row. */
export const scopesOf = (role: string | null, stored: readonly string[] | null): Scope[] =>
  !role ? [] : role === OVERSEER ? [...ALL_SCOPES] : (stored || []).filter(isRoleScope);
