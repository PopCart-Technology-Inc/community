# API contract

All endpoints live under `/api`. JSON in, JSON out. Errors are `{ "error": { "code": "...", "message": "..." } }` with a fitting status (400 invalid input, 401 sign in, 403 not allowed, 404 not found, 409 conflict, 413 too large, 429 slow down). Writes (POST, PUT, PATCH, DELETE) must carry the site's `Origin` header (CSRF), and are rate limited per person.

Times are ISO 8601 strings. Lists are newest first and take `?limit=` (1-50, default 20) and `?before=<ISO time of the last item>` for the next page. Every list and count response includes `as_of` (the time it was read): the golden rule is live data with its time, never a cached guess.

A **person** in any response is the public minimum: `{ id, handle, first_name, trade, avatar_media_id, id_checked }` (`PERSON_COLS` in `app/modules/shared.ts`). Nothing from the sealed vault ever appears.

Status: ✅ built · 🔨 being built.

## Accounts and people ✅ (`accounts/`, `people/`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/terms` | | `{ version }` |
| POST | `/accounts/join/start` | `{ email }` | 202 `{ sent: true, resend_after_seconds, code_minutes }`, the same reply whether or not the address has an invite; a 6-digit code is emailed only if it has one (one per 30 s, 5 per hour per address) |
| POST | `/accounts/join/verify` | `{ email, code }` | `{ ticket, ticket_minutes }`; 400 `code_invalid` (tries left in the message) or `code_expired` (10 minutes, one use, 5 tries) |
| POST | `/accounts/register/options` | `{ ticket, handle, first_name, trade, home_area?, agree: true, adult: true, terms_version, improve_usage, improve_surveys }` | `{ challengeId, options }` (WebAuthn creation options) |
| POST | `/accounts/register/verify` | `{ challengeId, response }` | 201 `{ user }` + session cookie |
| POST | `/accounts/login/options` | | `{ challengeId, options }` |
| POST | `/accounts/login/verify` | `{ challengeId, response }` | `{ user }` + session cookie |
| POST | `/accounts/logout` | | 204 |
| POST | `/accounts/invites` | `{ email, note? }` (staff) | 201 `{ sent: true, expires_at, expires_in_days }`: emails the invite (decision 0008). An open invite for the same address is renewed. 503 `mail_down` if the email cannot be sent (then no invite is made) |
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
| GET | `/places/sources` | `{ sources: [{ country_code, publisher, dataset, edition, url, areas, imported_at }], as_of }`: who published each country's area list. The app shows it as the credit wherever place names are listed. `edition` is `null` when the importer was not told it. |

Importer: `npm run places:import -- <psgc.csv> [--edition "3Q 2026"]` loads the Philippine Standard Geographic Code (columns: 10-digit code, name, geographic level) and fills `city_code`, `region_code`, `country_code` for every area. Never ship coordinates.
- A header row is optional; with one, the columns are found by name (a code/PSGC column, `Name`, a level column), so the published file works as is. A 9-digit code (leading zero lost in a spreadsheet) is padded.
- Each run also records the source in `area_sources` (publisher, dataset, the `--edition` you give, the number of areas, the time). Give the edition printed on the file you downloaded; leave it out rather than guess.
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
| GET | `/people/:handle/posts` | `?before&limit` | `{ posts, end, as_of }`: a person's top-level posts for their profile, newest first; private-Space posts only for members |
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

## Open Books ✅ (`books/`)

The community's money, in public ([decision 0009](decisions/0009-open-books.md)). Amounts are whole centavos. Everything to read is public, signed in or not. "Keepers" are trustees and staff. The ledger format and the checks: [open-books.md](open-books.md).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/books` | | `{ currency, entries, balance, total_in, total_out, last_entry_at, months: [{ month, in, out }] (12), categories: [{ category, in, out }], budgets: { year, items }, drafts_waiting, anchor, unanchored, bank_match, rule: { two_sig_over, set_by, set_at }, as_of }`. Corrections are netted against the month, category and side they correct. |
| GET | `/books/entries` | `?limit&before=<seq>&kind=in|out&category=` | `{ items: [{ seq, hash, prev, sealed_at, kind, amount, date, category, description, party, related_note, evidence, reverses, reversed_by, assisted, drafted_by, needs, signers, conflicted }], end, as_of }`, newest first |
| GET | `/books/entries/:seq` | | `{ entry, recomputed_hash, signed_body, anchored_in, as_of }` |
| GET | `/books/payees` | | `{ paid: [{ kind, name, amount, entries, last_date }], funders: [...], as_of }`; a private person by ID only |
| GET | `/books/ledger` | `?download=1` | the whole ledger: `{ format, currency, as_of, entries, keys, anchors, rules }` |
| GET | `/books/verify` | | `{ ok, entries, anchors, balance, problems: [{ seq?, anchor?, check, detail }], as_of }` the server's own run of the checks |
| GET | `/books/trustees` | | `{ trustees: [{ handle, first_name, appointed_at, appointed_by, ended_at, key_id, key_since }], as_of }`, former trustees included |
| GET | `/books/drafts` | | `{ drafts: [{ id, created_at, body, needs, signatures: [{ handle, key_id, signed_at }], conflicts: [{ handle, note }] }], rule, as_of }`, public while they wait |
| GET | `/books/anchors` · `/books/anchors/:id/proof` | | `{ anchors: [{ id, upto_seq, root, made_by, created_at, stamped, stamped_at }], as_of }` · the `.ots` file (404 until stamped) |
| GET | `/books/reconciliations` | | `{ reconciliations: [{ id, statement_date, bank_balance, ledger_balance, statement_sha256, note, made_by, created_at }], as_of }` |
| GET | `/books/me` | signed in | `{ trustee, staff, can_draft, key }` |
| PUT | `/books/key` | trustee: `{ public_key }` (P-256 public JWK; a private part is refused) | 201 `{ key: { key_id, public_key } }`. Retires the old key; its signatures on waiting drafts are dropped. 409 `key_used` for a key already published. |
| POST | `/books/drafts` | keeper: `{ kind, amount, date, category, party, description, evidence?, related_note?, assisted? }` or a correction `{ reverses, description, date, evidence? }` | 201 `{ draft }`. 400 for bad input (donors give money in only; a private person needs an ID like `C-0012`; a related party needs `related_note`; the date is from 2026-01-01 to today in Manila). 409 `balance` when the balance cannot cover it; 409 `already_reversed`. |
| DELETE | `/books/drafts/:id` | the drafter or staff | 204 |
| POST | `/books/drafts/:id/conflict` | trustee: `{ note? }` | `{ draft }`; that trustee's signature, if any, is dropped and they cannot sign it |
| POST | `/books/drafts/:id/sign` | trustee: `{ key_id, sig }` | 201 `{ sealed: { seq, hash } }` when it has its signatures, otherwise `{ draft }` (and `waiting: "balance"` if the balance cannot cover it yet). 403 `own_draft`, `conflicted`; 409 `no_key`, `key_changed`, `already_signed`; 400 a signature that does not check. |
| POST | `/books/drafts/:id/seal` | keeper | 201 `{ sealed }`; 409 `needs_signatures` or `balance` |
| POST | `/books/anchors` | keeper | 201 `{ anchor: { id, upto_seq, root, stamped } }`; 409 `nothing_new` |
| PUT | `/books/anchors/:id/proof` | keeper: `{ ots }` (base64) | `{ anchor }` once; 400 unless it is an OpenTimestamps proof of this root; 409 when it already has one |
| POST | `/books/reconciliations` | keeper: `{ statement_date, bank_balance, statement_sha256?, note? }` | 201 `{ reconciliation: { id, statement_date, bank_balance, ledger_balance, matched } }` |
| POST · DELETE | `/books/trustees` · `/books/trustees/:handle` | staff: `{ handle }` | 201 · 204 (ending a trustee retires their key) |
| PUT | `/books/rule` | staff: `{ two_sig_over }` | `{ rule }`; every change stays published |
| POST | `/books/budgets` | staff: `{ year, category, amount }` | 201 `{ budgets }`; every change stays published |

Sealed entries, anchors (apart from attaching a proof once), rules, budgets and bank matches are append-only: migration `0008_open_books.sql` adds triggers that refuse UPDATE and DELETE. `npm run books:stamp` stamps anchors without a proof on Bitcoin (OpenTimestamps; only the root is sent).
