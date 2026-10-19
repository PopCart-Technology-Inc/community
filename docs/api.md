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

## Spaces and messages ✅ (`spaces/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/spaces` | `?mine=1` or `?near=<area>` or `?q=`, plus `?before&limit` | `{ spaces: [{ id, slug, name, kind, visibility, area, about, rules, cover_media_id, created_at, members, role, unread, last_message }], as_of }`. `role`, `unread`, `last_message` are `null` unless you are a member. `near` matches the area and everything inside it (`WORLD`: all). Private Spaces are listed only to their members. `mine=1` is ordered by latest activity. |
| POST | `/spaces` | `{ name, slug, kind, visibility, area_code?, about?, rules? }` | 201 `{ space }`: creator is owner; a `chat` channel is made. 409 `slug_taken`. |
| GET | `/spaces/:slug` | | `{ space, channels: [{ id, name, position, unread }], my_role, members_count, faces[], as_of }` (private: members only) |
| PATCH | `/spaces/:slug` | any of `name, kind, about, rules, area_code, cover_media_id`; owner or moderator | `{ space }`. `slug` and `visibility` never change (400 `fixed`). |
| POST | `/spaces/:slug/members` | no body: join (public only). `{ handle }`: owner/mod adds that person (the only way into a private Space) | 204 |
| DELETE | `/spaces/:slug/members` | no body: leave (409 `last_owner` for the only owner). `{ handle }`: owner/mod removes someone with a lower role | 204 |
| GET | `/spaces/:slug/members` | `?before&limit` (by `joined_at`) | `{ members: [{ person + dm_public_key, role, joined_at }], as_of }` |
| PATCH | `/spaces/:slug/members/:handle` | `{ role }` (owner, moderator or member) owner only | 204 (409 `last_owner` if the only owner steps down) |
| POST | `/spaces/:slug/read` | member | 204: marks everything in the Space read (`space_members.last_read_at`) |
| POST | `/spaces/:slug/channels` | `{ name }` (`^[a-z0-9-]{2,30}$`) owner/mod | 201 `{ channel }`; 409 `channel_taken`; max 50 per Space |
| GET | `/channels/:id/messages` | `?before&limit` (signed in) | `{ messages: [{ id, channel_id, author: person + dm_public_key, body, sealed, created_at }], as_of }`: exactly one of `body` and `sealed` is set, the other is `null`. In a private Space `sealed.keys` holds only your own entry. |
| POST | `/channels/:id/messages` | public Space: `{ body }` (sealed: 400 `plaintext_only`); private Space: `{ sealed }` only (anything else: 400 `sealed_only`). Members only (403 `not_member`). | 201 `{ message }` |
| GET | `/spaces/:slug/posts` | `?before&limit` | `{ posts, end, as_of }` (top-level Space posts, newest first, post shape as in Posts) |
| GET | `/conversations` | `?requests=1`, `?before&limit` | `{ conversations: [{ id, other: person + dm_public_key, accepted, started_by_me, created_at, last_at, unread }], as_of }`. Default: accepted ones and the requests you sent. `requests=1`: requests you received. |
| POST | `/conversations` | `{ handle }` | 201 new or 200 existing `{ conversation }`. Accepted at once when they follow you; otherwise a request. Opening a request you received accepts it. |
| POST | `/conversations/:id/accept` | | 204 (only the person who received the request: 403 for the starter) |
| GET | `/conversations/:id/messages` | `?before&limit` | `{ messages: [{ id, sender_id, sealed, created_at }], as_of }`. Reading the newest page (no `before`) marks the conversation read. |
| POST | `/conversations/:id/messages` | `{ sealed: { v: 1, iv, ct } }` only | 201 `{ message }`. The server never accepts plaintext for DMs (400 `sealed_only`). Until accepted the starter may send 3 messages (409 `request_pending`); the recipient writing back accepts. |

**Privacy:** a private Space, its channels, members and posts answer 404 to anyone who is not a member, exactly like a Space that does not exist (never 403), so its existence does not leak. Unread counts count other people's messages after your `last_read_at`; sending a message also marks the Space read for you.

**End-to-end encryption (decision 0001, point 4):** the exact envelopes and the browser algorithm (ECDH P-256 → HKDF-SHA-256 → AES-GCM 256; private Spaces wrap a random per-message key for every member with AES-KW) are in [e2e.md](e2e.md). The server validates the envelope shape and size only: DM `{ v: 1, iv: 12 bytes, ct: 17-8192 bytes }`; private Space adds `keys: { <member id>: wrapped key ≤ 512 bytes }`, every id a current member and the sender included.

Deviations from the first draft: `POST /spaces/:slug/read` added; `DELETE /spaces/:slug/members { handle }` removes a member; conversations gained `started_by`, `a_read_at`, `b_read_at` (migration `0003_spaces.sql`) for Requests and unread; `dm_public_key` also comes with message authors and member lists so browsers can derive keys.

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
