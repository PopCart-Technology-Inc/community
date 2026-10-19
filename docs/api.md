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

## Work 🔨 (`work/`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/gigs` | `?tab=for_you|newest|saved|mine&level=&code=&trade=&min_pay=&before` | `{ gigs, rule, as_of }`. Newest: time only. For you: published formula (distance, trade, poster trust), explained by `rule`. |
| POST | `/gigs` | `{ title, body, pay_amount, pay_unit, pay_note?, when_text, paid_how, skills[], area_code?, space_id? }` | 201 `{ gig }`. Needs the ID check (credential `IdentityCheck`). |
| GET | `/gigs/:id` | | `{ gig, poster: person + trust, my_application? }` |
| PATCH | `/gigs/:id` | poster: `{ status }` | `{ gig }` |
| POST | `/gigs/:id/applications` | `{ note, credential_ids[] }` | 201 `{ application }` (one per person; never your own gig) |
| GET | `/gigs/:id/applications` | poster only | `{ applications: [{ id, person, note, credentials[], status, created_at }] }` |
| POST | `/applications/:id/pick` | poster | 204 (gig becomes `filled`) |
| POST | `/applications/:id/done` | poster or picked applicant | 204 |
| POST | `/gigs/:id/ratings` | `{ on_time, quality, easy, again }` 1-5, after both marked done | 201 |
| GET | `/people/:handle/work` | | `{ ratings: { count, on_time, quality, easy, again }, gigs_posted, gigs_done, paid_on_time_share, as_of }` |

A **gig**: `{ id, poster: person, title, body, pay_amount, pay_currency, pay_unit, pay_note, when_text, paid_how, skills, place, distance_hint, status, applicants, created_at, saved }`. Community never holds money: `paid_how` is always shown.

**Credentials (decision 0001, point 2):**

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me/credentials` | | `{ credentials }` |
| POST | `/me/credentials` | `{ vc }` (a W3C Verifiable Credential JSON) | 201 `{ credential }` after checking: issuer in the trusted list (`CREDENTIAL_ISSUERS` env: issuer id → public JWK), signature valid (Ed25519 or ES256 JWS over the credential without `proof`), subject is this person's handle, not expired. Stores `summary` and `as_of` from the claims. |
| PATCH | `/me/credentials/:id` | `{ shown }` | `{ credential }` |
| DELETE | `/me/credentials/:id` | | 204 |

## Safety and your data ✅ (`safety/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/reports` | `{ target_kind: post|message|dm|user|gig|space, target_id, reason, note?, revealed? }` | 201 `{ report: { id, target_kind, target_id, reason, status, created_at, goes_to: staff|space_moderators } }`. The target must exist and be visible to the reporter (404), never yourself or your own content (400), once per person per target (409). `revealed` (DMs only): up to 20 `{ text }` the reporter decrypted on their phone. `child_safety` goes to staff only, and hides a post or Space message at once. |
| GET | `/mod/reports` | `?space=<slug>&status=open|decided&before&limit` | `{ reports: [{ id, target_kind, target_id, space, reason, note, status, created_at, decided_at, decision_note, hidden_on_report, target: { …preview, author }, reporter, revealed }], as_of }`. Staff see all (open = open + escalated). A Space's owner and moderators see open reports from their Spaces, never `child_safety`, never about their own content; `reporter` and `revealed` are staff only (null otherwise). Reports about a Space itself, a person or a DM go to staff. |
| POST | `/mod/reports/:id/decide` | `{ action: keep|warn|remove|escalate, note }` (note required for warn and remove) | 204; logs a `mod_actions` row and notifies the author (`mod_action`). `remove` soft-deletes a post or message, closes a gig, deletes a DM envelope (staff), or suspends a person and ends their sessions (staff, logged as `suspend`). Removing a whole Space is not built: escalate it. `keep` on a `child_safety` report shows the hidden content again. A final decision also closes the other open reports of the same target. Escalating a `child_safety` report does not notify the author (no tip-off). |
| GET | `/me/mod-actions` | | `{ actions: [{ id, action, target_kind, target_id, reason, created_at, appealed_at, appeal_note, appeal_decision, appeal_decision_note, appeal_decided_at, can_appeal }], as_of }` what was done to my content and why |
| POST | `/me/mod-actions/:id/appeal` | `{ note }` | 204 (once, 409 after; only warn, remove or suspend) |
| GET | `/mod/appeals` | staff | `{ appeals: [{ id, action, target_kind, target_id, report_id, reason, created_at, appealed_at, appeal_note, subject, can_decide }], as_of }` |
| POST | `/mod/appeals/:id/decide` | staff, never the actor: `{ decision: upheld|overturned, note }` | 204. Overturned: the content or account is restored and a `restore` action is logged. The person is notified. |
| GET | `/me/data` | | `{ holds: [{ key, what, count }], sealed: { what: "Kept in the sealed vault: none yet", count: 0, note }, as_of }` what we hold, in plain words, with live counts |
| GET | `/me/export` | | a JSON download (`Content-Disposition: attachment`) of this person's own rows; DMs as the sealed envelopes; other people appear only by public handle |
| DELETE | `/me` | `{ confirm: "DELETE" }` | 204 + cleared cookie. In one transaction: posts and Space messages soft-deleted, open gigs closed, applications withdrawn, follows, saves, Space memberships, credentials, notifications, sessions, passkeys and media (rows and files) deleted, status `deleted`, profile scrubbed to the tombstone handle `deleted.<8 hex>` and first name `Deleted`. No legal-hold mechanism exists yet. |
| GET | `/me/record-log` | | `{ openings: [], as_of, note }` (the vault is not built, so it has never been opened) |
| GET | `/transparency` | | `{ as_of, launched: false, counts: { legal_requests, produced, refused, posts_removed, reports } }` live counts; before launch the web shows "No numbers yet" |

Deviations: the tombstone handle uses a dot (`deleted.1a2b3c4d`, an example) because the handle rule does not allow `-`. Data rights (`/me/data`, `/me/export`, `DELETE /me`, `/me/mod-actions` and appeals) also work for a suspended account. Migration `0005_safety.sql` adds one-report-per-target, `reports.hid_content` and the appeal columns.

## Media ✅ (`media/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/media` | raw image bytes, max 4 MB (413), 30 uploads an hour per person | 201 `{ media: { id, mime, bytes, width, height } }`. Typed by magic bytes (JPEG, PNG, WebP only), never by the name or `Content-Type`; width and height read from the image header; anything else is 400. The browser removes location data (re-encodes through a canvas) before upload. |
| DELETE | `/media/:id` | owner only | 204; the file is removed, and cleared from the owner's avatar, cover and posts |
| GET | `/media/:id` (outside `/api`) | | the file, `immutable` cache, sandboxed CSP |
