# 0009 · Staff panels, and usernames at the top of the site

- **Status:** Accepted (2026-10-21), on the owner's request.
- **Licence:** CC BY 4.0
- **Design preview:** [docs/design/staff-panels/preview.html](../design/staff-panels/preview.html) (open it in a browser; every value in it is an example).

## Context

Community needs two panels: one for the people who run the whole platform, and one for the people they invite to help (moderators, support, developers). Until now staff were one flag on an account (`users.role = 'staff'`), and staff tools sat inside the public app.

Profiles should live at the shortest URL, `community.popcartph.com/<username>`. That puts every username in the same namespace as the app's own paths. Two risks follow:

1. Someone takes a name like `admin`, `overseer`, `support` or `sw.js` and either poses as staff or breaks a path the app needs.
2. A panel at a guessable path (`/admin`) is a target for every scanner on the internet. Hiding a path is not protection.

How large networks handle this, as far as public sources show: third-party guides say Facebook usernames need at least 5 characters, and periods and capital letters do not make a name different. Facebook's tools for running Pages and ads live on their own subdomain (`business.facebook.com`), not under profile paths. Its internal staff tools are not publicly documented.

## Decision

### Usernames

1. **The rule:** 3-30 of `a-z`, `0-9`, `.` and `_`; it starts and ends with a letter or digit; no two dots in a row. There are no hyphens, so a username can never look like a system path.
2. **Reserved names** can never be taken: staff words (`admin`, `overseer`, `staff`, `mod`, `support`, `security`, `official`, `community`, `popcart`…), the first part of every screen path (`places`, `me`, `s`, `u`…), and the server's own files (`api`, `static`, `sw.js`, `robots.txt`…). The list is in `app/modules/accounts/handles.ts`, and a test keeps it in step with the app's router.
3. **Look-alikes are the same name.** Dots and underscores are ignored, digits read as the letters they look like (`0 1 2 3 4 5 6 7 8 9` as `o i z e a s g t b g`), `l` as `i`, `rn` as `m` and `vv` as `w`. `adm1n` and `adrnin` are reserved like `admin`, the main staff words (`admin`, `staff`, `mod`, `support`, `official`, `verified`…) may not be any part of a name, also when split across dots or underscores (`ad.min.jun`): a part runs between dots, underscores, digits used as breaks and the ends, with each digit tried both as a break and as a letter (`admin.popcart`, `admin2jun`, `st4ff1`; a few look-alike spellings such as `mod3l` are refused too, an accepted cost), `popcart`, `overseer`, `moderator` and `administrator` may not appear anywhere (with each `m` also matched as `rn` and each `w` as `vv`, so `overseernews` and `rnoderatornews` count), and `mariasantos` is taken once `maria.santos` exists. The database keeps the same key (`users.handle_key`).
4. **A reserved name looks like a name nobody has:** the same "No one has that username" page and the same 404, so a scanner learns nothing.
5. **Profiles move to `/<username>`.** The old `/u/<username>` keeps working as a permanent redirect. The profile route comes last, after every screen.
6. Existing accounts keep their names. `npm run handles:check` lists any that break the new rule, for staff to settle with the person.

### Panels

7. **Not on the public site.** The public host has no admin path and no staff API. Both panels run on a **separate staff host**, a random first-level name under the existing wildcard certificate (so it never appears in public certificate logs). The name is kept in private server config and never written in this repository.
8. **A gate in front: Cloudflare Access.** Only listed staff email addresses get through, after a one-time code. The server also checks the gate's signed token (`Cf-Access-Jwt-Assertion`) and the host on every staff request. Anything else gets a 404.
9. **A staff passkey bound to the staff host,** and its own `__Host-` cookie that ends after 15 idle minutes. A member session or a phishing page can't be used to get in.
10. **Scopes, not roles.** A role is a named list of scopes such as `reports.review` or `ops.health`. The server checks scopes, never role names, so a new role needs no new code. The first roles are **Moderator, Support and Developer**. The **Overseer** role has every scope and can't be edited.
11. **Two people for the big ones.** A second Overseer must approve, within 72 hours, before:
    - a sealed record is opened (court order only, shown for 30 minutes, and the person is told: decision 0001);
    - someone is made an Overseer or removed as one;
    - joining is opened to everyone;
    - Community is marked launched;
    - a feature is switched on in production.
12. **Everything is logged, append-only.** Every staff action is written to a log that nobody can edit or delete, Overseers included. Entries about a person also show in their "Who opened my records".
13. **No public staff badge.** Staff keep plain profiles, and official notices come from the reserved `@community` account. Nobody can be targeted as staff, and there is no badge to fake.
14. **Two Overseers:** the owner and one person they trust. Until a second Overseer exists, the two-person actions are done from the server's command line.
15. **Controls are custom and on-brand:** dropdowns, checkboxes, switches, file drops and confirmations are built for the panel, never the browser's defaults, and each one works from the keyboard.

### Order of work

| Version | What |
|---|---|
| 0.6.1 | Reserved names, the username rule and look-alikes (points 1-4, 6) |
| 0.7.0 | Profiles at `/<username>` (point 5) |
| 0.8.0 | Scopes and staff roles; today's staff accounts become Overseers (point 10) |
| 0.9.0 | The staff host, the gate check, the staff passkey and session, the audit log (points 7-9, 12) |
| 0.10.0 | The Overseer and Admin panels, two-person approvals (points 11, 13-15) |

The owner sets up the gate (the host name, the tunnel route and the Access app) at 0.9.0. It takes about 15 minutes and costs nothing on the free plan; check its user limit at setup.

## Consequences

- A few names people might want (`help`, `news`, `team`) are reserved for good.
- Anyone running their own Community server sets their own staff host and gate, or leaves `STAFF_ORIGIN` unset to have no staff panels at all.
- The sealed vault is not built yet. Until it is, the vault request list stays empty and "Who opened my records" says nothing was ever opened.
