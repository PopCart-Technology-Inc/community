# Changelog

Every change people will notice is listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each version is a git tag (`v0.1.0`) with a GitHub Release. How releases are made: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

## [0.8.0] - 2026-10-21

Staff have roles, and a role is a list of what it may do.

### Added
- **Staff roles and scopes** (decision [0009](docs/decisions/0009-staff-panels-and-usernames.md)). The server now checks scopes such as `reports.review`, `invites.send` or `ops.health`, never the word "staff". The first roles are **Moderator**, **Support** and **Developer**; the **Overseer** role has every scope. Roles other than Overseer end on a date unless renewed.
- `GET /me` says which role you hold and its scopes (`user.staff`).
- `npm run staff` gives, renews and takes roles from the server's command line, and never removes the last Overseer who can still act (a deleted or suspended account doesn't count).

### Changed
- Every staff account becomes an Overseer, so nobody loses anything (deleted accounts get no role). Deleting your account ends any staff role you hold. `npm run invite -- --staff` now makes an Overseer.
- Settings shows "Moderator queue" and "Invite by email" only to people whose role has those scopes.
- Child-safety reports need their own scope, `reports.child_safety`. Moderator has it. Once anyone reports a post or message for child safety, every report and appeal about it needs that scope too, and overturning an appeal can't bring it back while the child-safety report is open (`409 child_safety_open`).
- **Nobody suspends an Overseer through a report** (`403 overseer`). Removing an Overseer is done with `npm run staff` on the server; the two-person panel comes in 0.10.0.
- The last Overseer who can act can't delete their account (`409 last_overseer`) or lose the role; a suspended Overseer can be removed while another one can act, and can always delete their own account.
- A member invite never renews or changes an open staff invite for the same address (`409 staff_invite_open`); an expired staff invite is cleared instead.
- Your data export shows your staff role as `staff_role` (role, end date and when it was given) instead of `profile.role`.

### Upgrading
- This version removes the old staff flag from the database. Back up first, and don't run 0.7.0 against the database afterwards: it still reads that column.

## [0.7.0] - 2026-10-21

Your profile is at the shortest address: community.popcartph.com/your.username.

### Changed
- **Profiles live at `/<username>`** (decision [0009](docs/decisions/0009-staff-panels-and-usernames.md)). Every link in the app uses the new address.
- `/u/<username>` links already shared keep working: the server answers them with a permanent redirect to `/<username>`, and the app does the same for links opened inside it.
- A username typed with capitals (`/Jun.Rides`) finds the profile.

## [0.6.1] - 2026-10-21

Nobody can take a staff word or one of the app's own paths as a username.

### Fixed
- **Reserved usernames** (decision [0009](docs/decisions/0009-staff-panels-and-usernames.md)). Staff words (`admin`, `overseer`, `support`…), the first part of every screen path and the server's own files (`sw.js`, `api`…) can no longer be taken, and neither can a name with one of the main staff words (`admin`, `staff`, `mod`, `support`, `official`, `verified`…) as one of its parts or spread over parts joined by dots or underscores (parts are split at dots, underscores and digits, each digit read both as a break and as a letter: `admin.popcart`, `popcart_official`, `overseer1`, `admin2jun`, `st4ff1`), a name with `popcart`, `overseer`, `moderator` or `administrator` anywhere in it (`overseernews` too), or the shape of a deleted account's name (`deleted.…`). Joining with one shows "That username is reserved". A reserved name nobody holds looks exactly like a name nobody has. Accounts that already hold one keep it: `npm run handles:check` lists them.
- **Look-alike names are the same name.** Dots and underscores are ignored; digits count as the letters they look like (0 o, 1 i, 2 z, 3 e, 4 a, 5 s, 6 g, 7 t, 8 b, 9 g), `l` counts as `i`, `rn` as `m` and `vv` as `w`. So `adm1n` and `adrnin` are reserved like `admin`, and `mariasantos` is taken once `maria.santos` exists, even when two people join at the same moment.
- **The username rule** now also needs a letter or digit at the start and end, and no two dots in a row. Existing accounts keep their names; `npm run handles:check` lists any that break the rule.

### Added
- The staff panels design and decision 0009: panels on a separate staff host behind a gate, scopes instead of roles, two people for the big actions, and a log nobody can edit ([preview](docs/design/staff-panels/preview.html)). Built over the next releases.

## [0.6.0] - 2026-10-20

Invites now go to an email address, so they cannot be passed on as a link.

### Added
- **Invites by email** (decision [0008](docs/decisions/0008-email-invites.md)). Staff invite an address from Settings, Invite by email (or `npm run invite -- --email`). Joining needs that address and a 6-digit code sent to it (10 minutes, one use, 5 tries). The address is not stored: only a keyed hash of it, cleared when the invite is used.
- **Email design** ([docs/design/email.md](docs/design/email.md)): one Stage mode shell and a few blocks for the invite, the join code and announcements. No tracking pixels, no web fonts, no per-person links, and a plain-text part with every email. `npm run mail:preview` writes them all for checking.
- New settings: `EMAIL_HASH_KEY` (required), `RESEND_API_KEY`, `MAIL_FROM` ([docs/running.md](docs/running.md)).

### Changed
- **Breaking:** `POST /accounts/invites` takes `{ email }` and emails the invite instead of returning a code and link. `POST /accounts/invite/check` is gone; joining uses `POST /accounts/join/start` and `/accounts/join/verify`, and `/accounts/register/options` takes the `ticket` they return in place of `code`.
- Invite links made before 0.6.0 no longer work. Staff send those people an email invite.

## [0.5.1] - 2026-10-19

### Fixed
- A new version now shows on the next page load. The app's files were cached for hours, so after an update a browser could keep the old version, or mix old and new files. They are now checked on every load (an unchanged file costs an empty "not modified" reply), and the service worker goes to the network first, using its copy only when offline.

## [0.5.0] - 2026-10-19

Designed for each screen size: phone, tablet and desktop.

### Added
- **Tablet layout (700-999 px):** an icon rail on the left in place of the bottom tabs, and one column, as on X and Threads. From 1000 px the right rail joins; from 1280 px the navigation shows its labels.
- **Welcome on wide screens:** the whole page is yellow, the words sit beside the picture, and three cards open Places, Spaces and Work.
- **Log in and join on wide screens:** a white card on cream with the name above it, in place of a narrow strip.
- Search at the top of the right rail (it searches Spaces).

### Fixed
- The Me tab and `/me` showed a blank page: the redirect to your profile was overwritten by the page it left.
- Transparency printed "[object HTMLDivElement]" in place of its counts (nested lists in lazily loaded screens were not flattened). The moderator queue had the same fault.
- On desktop, the phone header (avatar, name, search) also showed above the feed, next to the navigation.
- Places on a phone: the "See all of …" button ran off the screen and the page scrolled sideways; the place's own name is no longer cut to make room for its region.
- Empty states put their button in the middle of the sentence.
- The ✎ button no longer floats over settings, forms and chats, and the end of a feed clears it.
- Headings focused for screen readers no longer show a focus ring (controls still do).

## [0.4.1] - 2026-10-19

### Fixed
- With a brand pack installed, every page logged about 10 Content Security Policy errors, because the pack's sprite carries style attributes and the CSP blocks them, even while the sprite is parsed. Those styles are now renamed before parsing and applied as classes from a constructed stylesheet, which the CSP allows. The CSP itself is unchanged (still no `unsafe-inline`).

## [0.4.0] - 2026-10-19

Place names now credit who published them.

### Added
- Places credits its source. The Places screen and the place picker show who published the place names, with the edition and when the list was last updated, for example the Philippine Statistics Authority's Philippine Standard Geographic Code. The credit comes from the data, not fixed text, so it stays true after each re-import.
- `GET /places/sources` returns the source of each country's area list.
- The importer records the source on every run and takes the edition: `npm run places:import -- psgc.csv --edition "3Q 2026"`. Without `--edition` none is shown (never guessed).

## [0.3.0] - 2026-10-19

A promise we could not keep is withdrawn.

### Changed
- "Before you join" no longer says "we never show you ads" or "no tracking", because advertising is on PopCart's roadmap. It now says: "We never sell your data. Any ad is clearly labelled." (English and Filipino). The welcome screen and the footer say the same.
- Decisions 0001 and 0002 record the change; "never sold" stays.

### Added
- Decision 0007, **proposed** (not in force): how ads would work. Labelled, in separate slots that never change the ranking, chosen by context only, never from messages, private Spaces, the vault or improvement data, no third-party tracking, totals only for advertisers. The app shows no ads until a decision is accepted.
- A test that fails if a withdrawn promise comes back to any screen.

## [0.2.0] - 2026-10-19

The platform's first working version, invite-only until the privacy lawyer's review.

### Added
- The platform design, written to build from: principles, the familiar pattern behind each part, every screen, and what is not designed yet ([docs/design](docs/design/README.md)).
- Decision 0005, accepted: **Places**, one feed that zooms from barangay to city, region, country and world, with a published rule per level, a mix rule so no city takes over the country feed, author-chosen reach, and location that never leaves the phone.
- Decision 0006, accepted: the stack. TypeScript on Node 24 with no build step, PostgreSQL, a progressive web app, passkeys, brand art outside the repository, and invite-only joining until the privacy lawyer's review.
- **The platform's first working version** ([docs/api.md](docs/api.md), [docs/running.md](docs/running.md)):
  - Accounts: join by invite with a passkey, passkey login, no passwords, no phone numbers yet; improvement-data switches start off.
  - People: profiles with live counts, follows, suggestions from your trade and city (never your contacts).
  - Places: the Philippine Standard Geographic Code importer and place search.
  - Posts and feeds: Following (newest first, with an end), Places at five levels with the published weights, fair-traffic and mix rules, "Why you're seeing this", My trade, Monday Picks, replies, saves, salamat (ten a week, Monday reset in Manila), notifications.
  - Spaces: public and private, roles, channels, unread counts; direct messages with Requests for strangers. Direct messages and private-Space chat accept only end-to-end encrypted envelopes ([docs/e2e.md](docs/e2e.md)).
  - Work: gigs, "For you" and Newest, applying with signed proof, pick, done, criteria ratings, live work records; credential verification ([docs/credentials.md](docs/credentials.md)).
  - Safety: reports (child safety hidden at once and sent to staff), the moderator queue, decisions shown to the person, one appeal to someone else, your data in plain words, export, delete, the record log, the live transparency report.
  - Media: image uploads checked by their bytes, at most 4 MB.
- CI runs the type check, a runtime dependency audit and the tests on every push and pull request. A Dockerfile runs it as an unprivileged user.

### Security
- Nonce-only Content Security Policy, CSRF checks by Origin, rate limits on sign-in, writes and uploads, session cookies stored only as hashes.
- Posts are refused in private Spaces until they can be end-to-end encrypted, so nothing private is stored as plaintext.

### Changed
- Decision 0003: the "Near me" feed is now Places (decision 0005).

## [0.1.0] - 2026-10-15

The foundations: the decisions, the leak checks and the review flow. No app code yet.

### Added
- Decisions 0001-0004, accepted: hold keys, not data; sign-up and verification; feeds and spaces; connected socials. A privacy lawyer's review is still to come before sign-up launches.
- Leak checks for this public repo: pre-commit and pre-push hooks, CI over the whole history with a second scanner (gitleaks), and a guard for AI agent sessions.
- Review flow: every pull request needs green checks (leakcheck, DCO sign-off) and an approving review from a maintainer, then is squash-merged.
- Versioning: this changelog, protected `v*` release tags and automatic GitHub Releases.
- Issue and pull request templates, and Dependabot updates for the pinned GitHub Actions.

### Security
- Leakcheck never prints a private name it finds, because CI logs are public.

[Unreleased]: https://github.com/PopCart-Technology-Inc/community/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.8.0
[0.7.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.7.0
[0.6.1]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.6.1
[0.6.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.6.0
[0.5.1]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.5.1
[0.5.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.5.0
[0.4.1]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.4.1
[0.4.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.4.0
[0.3.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.3.0
[0.2.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.2.0
[0.1.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.1.0
