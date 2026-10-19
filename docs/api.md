# API contract

All endpoints live under `/api`. JSON in, JSON out. Errors are `{ "error": { "code": "...", "message": "..." } }` with a fitting status (400 invalid input, 401 sign in, 403 not allowed, 404 not found, 409 conflict, 413 too large, 429 slow down). Writes (POST, PUT, PATCH, DELETE) must carry the site's `Origin` header (CSRF), and are rate limited per person.

Times are ISO 8601 strings. Lists are newest first and take `?limit=` (1-50, default 20) and `?before=<ISO time of the last item>` for the next page. Every list and count response includes `as_of` (the time it was read): the golden rule is live data with its time, never a cached guess.

A **person** in any response is the public minimum: `{ id, handle, first_name, trade, avatar_media_id, id_checked }` (`PERSON_COLS` in `app/modules/shared.ts`). Nothing from the sealed vault ever appears.

Status: ✅ built · 🔨 being built.

## Accounts and people ✅ (`accounts/`, `people/`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/terms` | | `{ version }` |
| POST | `/accounts/invite/check` | `{ code }` | `{ ok, expires_at }` |
| POST | `/accounts/register/options` | `{ code, handle, first_name, trade, home_area?, agree: true, adult: true, terms_version, improve_usage, improve_surveys }` | `{ challengeId, options }` (WebAuthn creation options) |
| POST | `/accounts/register/verify` | `{ challengeId, response }` | 201 `{ user }` + session cookie |
| POST | `/accounts/login/options` | | `{ challengeId, options }` |
| POST | `/accounts/login/verify` | `{ challengeId, response }` | `{ user }` + session cookie |
| POST | `/accounts/logout` | | 204 |
| POST | `/accounts/invites` | `{ note? }` (staff) | 201 `{ code, url, expires_in_days }` |
| GET | `/me` | | `{ user }` or `{ user: null }` |
| PATCH | `/me` | any of `first_name, bio, trade, home_area, improve_usage, improve_surveys, avatar_media_id, cover_media_id, dm_public_key` | `{ user }` |
| GET | `/people?trade=` | | `{ people }` suggestions: same trade and home area, never contacts |
| GET | `/people/:handle` | | `{ person: { …person, bio, cover_media_id, home_area, home_area_name, followers, following, salamats, credentials[], is_following, as_of } }` |
| POST / DELETE | `/people/:handle/follow` | | 204 |
| GET | `/people/:handle/followers`, `/following` | | `{ people }` |

## Places 🔨 (`places/`)

| Method | Path | Returns |
|---|---|---|
| GET | `/places/search?q=` | `{ areas: [{ code, name, level, parent_name }] }` (max 20; names, never coordinates) |
| GET | `/places/:code` | `{ area: { code, name, level }, chain: [{ code, name, level }] }` (the area and its ancestors up to World) |
| GET | `/places/:code/children` | `{ areas }` |

Importer: `npm run places:import -- <psgc.csv>` loads the Philippine Standard Geographic Code (columns: 10-digit code, name, geographic level) and fills `city_code`, `region_code`, `country_code` for every area. Never ship coordinates.

## Posts, feeds and salamat 🔨 (`posts/`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/posts` | `{ body, reply_to?, space_id?, media_ids?, area_code?, reach? }` | 201 `{ post }`. `area_code` default: the author's home area. `reach` one of barangay, city, region, country, world (default city). A reply inherits the parent's place and reach. Posting in a Space needs membership. |
| GET | `/posts/:id` | | `{ post, replies[] }` (replies oldest first) |
| DELETE | `/posts/:id` | | 204 (author or staff; soft delete) |
| POST / DELETE | `/posts/:id/salamat` | `{ tags? }` (max 3 short tags) | `{ salamats, left_this_week }`. Ten a week per person (`SALAMATS_PER_WEEK`, Monday reset in Manila, `manilaWeek()`), one per post, never your own post. |
| POST / DELETE | `/posts/:id/save` | | 204 |
| GET | `/feeds/following` | `?before&limit` | `{ posts, end: boolean, as_of }`: people and Spaces you follow, newest first, never re-ordered. `end` is true when there is nothing older. |
| GET | `/feeds/places` | `?level=barangay|city|region|country|world&code=<area>&before&limit` | `{ posts, level, area, rule, weights, as_of, quiet?: { next_level, next_code, next_name } }` |
| GET | `/feeds/trade` | `?trade=` | `{ posts, rule, as_of }` ranked like City but filtered to the trade |
| GET | `/feeds/picks` | | `{ posts, week, as_of }`: last week's most-thanked posts by distinct givers |
| GET | `/posts/:id/why` | `?level=&code=` | `{ signals: { near, trade, salamats_distinct, fresh_hours }, weights, rule }` the real inputs of this post's score |
| GET | `/me/saved` | | `{ posts }` |
| GET | `/notifications` | | `{ items, unread, as_of }` |
| POST | `/notifications/read` | | 204 |

A **post** in responses: `{ id, author: person, body, created_at, reply_to, space_id, media_ids, reach, place: { code, name } | null, distance_hint: string | null, salamats, replies, saved, salamat_given, lang }`.

**Places ranking (decision 0005, decisions 0003):** the weights live in `app/modules/posts/weights.ts` and are returned by the API.
- A post appears at level L when its `reach` is L or wider, and its code at L matches the requested area (World: every post with reach world).
- Barangay: newest first only.
- City, Region, Country, World: `score = w.near*near + w.trade*trade + w.salamat*log2(1+distinct givers) + w.fresh*fresh`, where `fresh = 1 / (1 + hours/12)`, `near` = 1 same barangay, 0.5 same city, 0 otherwise, `trade` = 1 when the author's trade is the viewer's.
- Weights per level: City near high; Region salamat up; Country and World add the mix rule.
- Fair traffic: at most 2 posts per author in every 20. Country: at most 1 in 4 posts from any one city. World: at most 1 in 4 from any one country.
- No paid boosts, no engagement-bait or outrage signals, no private data.
- `quiet`: when a level returns fewer than 5 posts from the last 24 hours, suggest the next level up.

## Spaces and messages 🔨 (`spaces/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/spaces` | `?mine=1` or `?near=<area>` or `?q=` | `{ spaces: [{ id, slug, name, kind, visibility, area, members, role?, unread?, last_message? }] }` |
| POST | `/spaces` | `{ name, slug, kind, visibility, area_code?, about?, rules? }` | 201 `{ space }`: creator is owner; a `chat` channel is made |
| GET | `/spaces/:slug` | | `{ space, channels, my_role, members_count, faces[] }` (private: members only) |
| PATCH | `/spaces/:slug` | owner or moderator | `{ space }` |
| POST / DELETE | `/spaces/:slug/members` | join / leave (private: invite only, `{ handle }` by owner/mod) | 204 |
| GET | `/spaces/:slug/members` | | `{ members: [{ person, role }] }` |
| PATCH | `/spaces/:slug/members/:handle` | `{ role }` owner only | 204 |
| POST | `/spaces/:slug/channels` | `{ name }` owner/mod | 201 `{ channel }` |
| GET | `/channels/:id/messages` | `?before&limit` | `{ messages: [{ id, author, body | null, sealed | null, created_at }] }` |
| POST | `/channels/:id/messages` | public Space: `{ body }`; private Space: `{ sealed }` only | 201 `{ message }` |
| GET | `/spaces/:slug/posts` | | `{ posts }` (Space posts, newest first) |
| GET | `/conversations` | `?requests=1` | `{ conversations: [{ id, other: person + dm_public_key, accepted, last_at, unread }] }` |
| POST | `/conversations` | `{ handle }` | `{ conversation }` (existing or new; new from a stranger = request) |
| POST | `/conversations/:id/accept` | | 204 |
| GET | `/conversations/:id/messages` | | `{ messages: [{ id, sender_id, sealed, created_at }] }` |
| POST | `/conversations/:id/messages` | `{ sealed: { v: 1, iv, ct } }` | 201. The server never accepts plaintext for DMs. |

**End-to-end encryption (decision 0001, point 4):** each person's browser makes an ECDH P-256 key pair (WebCrypto), keeps the private key in IndexedDB, and publishes the public JWK via `PATCH /me { dm_public_key }`. A DM is AES-GCM encrypted under the ECDH-derived key of the two people. Private Space messages are encrypted per message for every member (`sealed: { v: 1, iv, ct, keys: { <user_id>: <wrapped key> } }`). The server validates the envelope shape and size only.

## Work ✅ (`work/`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/gigs` | `?tab=for_you|newest|saved|mine&level=&code=&trade=&min_pay=&before` | `{ gigs, tab, rule, as_of }` (For you also `weights`). Newest (default, no sign-in needed): open gigs, time only. For you: open gigs from the last 30 days, ranked by the published formula below; each gig carries its `signals` and `score`; `before` is ignored (top `limit`). Saved: gigs you saved, last saved first (any status). Mine: gigs you posted (any status). Filters: `level` + `code` (area; default your home area) like Places, `trade` (the gig lists it as a skill), `min_pay` (whole pesos, any unit). |
| POST | `/gigs` | `{ title, body, pay_amount, pay_unit, pay_note?, when_text, paid_how, skills[], area_code?, space_id? }` | 201 `{ gig }`. Needs the ID check (credential `IdentityCheck`), else 403 `id_check`. `pay_unit` one of fixed, hour, day, night, run; `skills` at most 8; `area_code` default: your home area; `space_id` needs membership. |
| GET | `/gigs/:id` | | `{ gig, poster: person + trust, my_application }` (`trust` is the `/people/:handle/work` record; `my_application` null when none) |
| PATCH | `/gigs/:id` | poster: `{ status }` (open, filled, closed) | `{ gig }` |
| POST / DELETE | `/gigs/:id/save` | | 204 |
| POST | `/gigs/:id/applications` | `{ note, credential_ids[] }` | 201 `{ application }`. One per person (409 `already_applied`); never your own gig (403 `own_gig`); open gigs only (409 `not_open`); at most 10 credentials, each your own, shown and verified (400 `credential`). Notifies the poster. |
| GET | `/gigs/:id/applications` | poster only (403 `not_poster`) | `{ applications: [{ id, person, note, credentials[], status, done_by_poster, done_by_applicant, created_at }], as_of }`. Credentials appear only while the applicant keeps them shown. |
| POST | `/applications/:id/pick` | poster | 204 (gig becomes `filled`; the picked person is notified). 409 when the gig is no longer open. |
| POST | `/applications/:id/done` | poster or picked applicant | 204 |
| POST | `/gigs/:id/ratings` | `{ on_time, quality, easy, again }` 1-5, after both marked done | 201 `{ rating }`. Poster rates the picked worker, worker rates the poster; once per gig per rater (409 `already_rated`); before both marked done 409 `not_done`; anyone else 403 `not_part`. |
| GET | `/people/:handle/work` | | `{ ratings: { count, on_time, quality, easy, again }, gigs_posted, gigs_done, paid_on_time_share, as_of }`. Averages of ratings received (null when none). `gigs_done`: picked and marked done by both sides, as the worker. `paid_on_time_share`: of workers' ratings of this person as poster, the share with `on_time` 4 or 5 (null when none). |

A **gig**: `{ id, poster: person, title, body, pay_amount, pay_currency, pay_unit, pay_note, when_text, paid_how, skills, place, distance_hint, status, applicants, created_at, saved, space_id }`. Community never holds money: `paid_how` is always shown, and there are no other payment fields. Gigs in a private Space are seen by its members only.

**For you ranking** (`app/modules/work/weights.ts`, returned as `rule` and `weights`): `score = 3*near + 2*trade + 1.5*trust + 1*fresh`. `near` = 1 same barangay, 0.5 same city, 0.25 same region (your home area, never your location); `trade` = 1 when the gig lists your trade as a skill; `trust` = the poster's average rating mapped 1-5 → 0-1, times n/(n+3) for n ratings received; `fresh = 1 / (1 + hours/24)`. Your own gigs are left out. Ties: newest first. No paid boosts.

**Credentials ✅ (decision 0001, point 2).** The exact format an issuer must produce, and every error code: [credentials.md](credentials.md).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me/credentials` | | `{ credentials: [{ id, issuer, type, summary, as_of, verified, verified_at, shown, created_at }], as_of }` |
| POST | `/me/credentials` | `{ vc }` (a W3C Verifiable Credential JSON) | 201 `{ credential }` after checking: issuer in the trusted list (`CREDENTIAL_ISSUERS` env: issuer id → public JWK), signature valid (Ed25519 or ES256 detached JWS over the canonical JSON of the credential without `proof`), subject is `community:@<handle>`, `issuanceDate` not in the future, `expirationDate` (required) not passed. Stores `summary` and `as_of` from the claims. Anything else: 400 with a code. A new credential with the same issuer and type replaces the old one (same id). |
| PATCH | `/me/credentials/:id` | `{ shown }` | `{ credential }` |
| DELETE | `/me/credentials/:id` | | 204 |

## Safety and your data 🔨 (`safety/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/reports` | `{ target_kind, target_id, reason, note?, revealed? }` | 201. `child_safety` goes to staff only, and hides the content at once. |
| GET | `/mod/reports` | `?space=<slug>` (Space moderators see their Space; staff see all) | `{ reports }` |
| POST | `/mod/reports/:id/decide` | `{ action: keep|warn|remove|escalate, note }` | 204; logs a `mod_actions` row and notifies the person |
| GET | `/me/mod-actions` | | `{ actions }` what was done to my content and why |
| POST | `/me/mod-actions/:id/appeal` | `{ note }` | 204 (once; decided by a different moderator) |
| GET | `/me/data` | | `{ holds: [...] }` what we hold, in plain words, with live counts |
| GET | `/me/export` | | a JSON download of everything about this person |
| DELETE | `/me` | `{ confirm: "DELETE" }` | 204; content removed, account marked deleted, sessions ended (minus records under legal hold) |
| GET | `/me/record-log` | | `{ openings: [], as_of }` (vault openings for this person; empty means never opened) |
| GET | `/transparency` | | `{ as_of, launched: false, counts: { legal_requests, produced, refused, posts_removed, reports } }` live counts; before launch the web shows "No numbers yet" |

## Media ✅/🔨 (`media/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/media` | raw image bytes, `Content-Type: image/jpeg|png|webp`, max 4 MB | 201 `{ media: { id, mime, bytes, width, height } }`. Checked by magic bytes, not the header. The browser removes location data (re-encodes through a canvas) before upload. |
| GET | `/media/:id` (outside `/api`) | | the file, `immutable` cache, sandboxed CSP |
