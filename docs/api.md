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

## Places ✅ (`places/`)

| Method | Path | Returns |
|---|---|---|
| GET | `/places/search?q=` | `{ areas: [{ code, name, level, parent_name }], as_of }` (max 20; names, never coordinates). `q` needs 2-60 characters; names starting with `q` come first. |
| GET | `/places/:code` | `{ area: { code, name, level }, chain: [{ code, name, level }], as_of }`: `chain` starts with the area itself and walks up to World. |
| GET | `/places/:code/children` | `{ areas, as_of }` (by name) |

Importer: `npm run places:import -- <psgc.csv>` loads the Philippine Standard Geographic Code (columns: 10-digit code, name, geographic level) and fills `city_code`, `region_code`, `country_code` for every area. Never ship coordinates.
- A header row is optional; with one, the columns are found by name (a code/PSGC column, `Name`, a level column), so the published file works as is. A 9-digit code (leading zero lost in a spreadsheet) is padded.
- Levels: `Reg` → region, `Prov` → province, `City`/`Mun`/`SubMun` → city, `Bgy` → barangay. Other levels (e.g. districts) are skipped and counted.
- Parents from the code's prefixes: region = first 2 digits + `00000000`, province = first 5 + `00000`, city/municipality = first 7 + `000`; a parent missing from the file is skipped, so NCR cities hang from the region. A `SubMun` sits under its city, and its barangays roll up to that city for the City feed.
- It upserts a `PH` row (Philippines, parent `WORLD`) and every area, in one transaction: re-running is safe. No PSGC data is committed to this repository.

## Posts, feeds and salamat ✅ (`posts/`)

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

**As built (details and small deviations):**
- Every list and count response carries `as_of`, including `GET /posts/:id`, salamat counts, `/me/saved` and `/feeds/trade`.
- `near` is measured from the viewer's home area; when they have none (or are signed out), from the area being viewed. `distance_hint` precision: Barangay and City say "same barangay" or the barangay's name; Region and Country the city; World "City, Country"; lists outside Places (post page, Following, saved) the city.
- Places, Trade and Picks show top-level posts only (no replies). Places and Trade leave out Space posts; Picks includes public Space posts. Posts in a private Space are only ever shown to its members (including `GET /posts/:id`, which is 404 for others).
- Following also shows your own posts and posts in Spaces you are a member of.
- Ranked feeds rank the newest 300 posts that match (older than `before` when given). For the next page pass `before=<the oldest created_at on the page>`.
- Fair traffic is applied after ranking at every level, Barangay included (decision 0005). The author cap is hard: posts over it are held back. The mix rule is kept whenever the remaining posts can still be spread 1 in 4 (it looks ahead so a low-scoring city does not bunch up at the end); when they cannot (one or two cities have everything left), the post whose city or country appeared longest ago comes next, so posts are never hidden by the mix rule.
- Weights as published: City `{ near: 3, trade: 1, salamat: 1, fresh: 2 }`, Region `{ near: 1, trade: 1, salamat: 2, fresh: 2 }`, Country `{ near: 0.5, trade: 1, salamat: 2, fresh: 2 }`, World `{ near: 0, trade: 1, salamat: 2, fresh: 2 }`; Barangay `weights: null`.
- `/feeds/places`: `level` defaults to `city`, `code` to the viewer's home area (400 when neither gives an area at that level). `area` is the area at that level (`{ code: 'WORLD', … }` for World). `quiet` skips levels the area has no code for.
- `/feeds/trade`: `trade` defaults to the viewer's trade. Area: the viewer's home city (reach city or wider); with no home area, only posts with reach world. Returns `{ posts, trade, rule, weights, as_of }`.
- `/feeds/picks`: "last week" is the previous Manila ISO week (`manilaWeek`), ordered by distinct givers, author cap applied, `?limit`.
- `/posts/:id/why`: also returns `score` (null at Barangay) and `as_of`.
- Salamat errors: 400 `own_post`, 409 `already_thanked`, 429 `no_salamats_left`. Tags are lower-cased, 1-24 characters each. Taking a salamat back also removes its unread notification. Salamat and reply create notifications (`ref_kind: 'post'`, `ref_id`: the thanked post, or for a reply the post replied to); your own reply does not notify you.
- A reply also inherits the parent's Space; posting a reply needs membership there too.
- `media_ids`: up to 4 of your own uploads.
- `/me/saved`: newest saved first; each post also has `saved_at`, and `before` pages by save time.
- `/notifications`: `?before&limit`; items are `{ id, kind, ref_kind, ref_id, created_at, read, actor: person | null }`.
- `lang` is always `null` for now (no language detection yet).

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
