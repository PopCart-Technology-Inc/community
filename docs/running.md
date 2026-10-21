# Running PopCart Community

You need Node.js 24. Nothing else for the tests.

```
npm ci
npm test            # every test, on an in-memory Postgres (PGlite)
npx tsc --noEmit    # type check
```

## Run it

Set the environment (never commit real values):

| Variable | What |
|---|---|
| `DATABASE_URL` | a `postgres://` connection URL with the user, password, host and database (required; keep it in your secret store) |
| `COMMUNITY_ORIGIN` | the public origin, e.g. `https://community.example.org` (passkeys and CSRF use it) |
| `PORT` | default 8080 |
| `MEDIA_DIR` | where uploads are stored, default `data/media` |
| `BRAND_DIR` | optional brand pack (`sprite.svg`, `fonts/`). Not part of this repository: see TRADEMARKS.md |
| `TRUST_PROXY` | `1` behind a reverse proxy or tunnel |
| `CREDENTIAL_ISSUERS` | JSON: trusted credential issuers, issuer id → public JWK (docs/credentials.md) |
| `EMAIL_HASH_KEY` | required: at least 32 random characters (`openssl rand -hex 32`). The key for the hash that matches an invited address; the address itself is never stored. Changing it retires open invites |
| `RESEND_API_KEY` | the [Resend](https://resend.com) key that sends invites and join codes. Unset: on `http://localhost` emails are printed instead; on a public origin sending fails with 503 |
| `MAIL_FROM` | the From line, e.g. `Community <hello@example.org>`, on a domain verified in Resend (required with `RESEND_API_KEY`) |
| `STAFF_ORIGIN` | optional: the staff host, e.g. `https://staff-x7k2.example.org` (decision 0009). Pick a name no one would guess, keep it out of the repository and out of public DNS listings where you can. Unset: no staff host, and Settings has no "Staff passkey" |
| `STAFF_RP_ID` | the passkey domain for staff passkeys; default the staff host's name. Staff passkeys never work on the public site, and member passkeys never work on the staff host |
| `ACCESS_TEAM_DOMAIN` | the Cloudflare Access team domain that guards the staff host, e.g. `https://your-team.cloudflareaccess.com` (required with a public `STAFF_ORIGIN`) |
| `ACCESS_AUD` | the Access application's audience tag (required with a public `STAFF_ORIGIN`) |

```
npm start                                  # migrates, then listens
npm run invite -- --email you@example.org --staff   # emails a one-time invite to that address (--staff: joins as an Overseer)
npm run staff -- list                     # staff and their roles; also roles, grant <user> <role> [--days 90], renew, revoke
npm run places:import -- psgc.csv --edition "3Q 2026"   # loads the Philippine Standard Geographic Code
npm run mail:preview -- out/mail          # writes every email the app sends, to check the design
npm run handles:check                     # lists usernames that break the rule (decision 0009); only reads the database
```

### The staff host

Staff tools are on their own host, never on the public site (decision 0009). The server answers that host only when the request carries a token from the gate, and gives a plain 404 to anything else:

1. Point the staff host name at the same server as Community (a tunnel or proxy is fine; set `TRUST_PROXY=1`).
2. In Cloudflare Zero Trust, add a self-hosted Access application for that host. Its policy lets in only the staff email addresses. Copy the application's audience tag to `ACCESS_AUD` and the team domain to `ACCESS_TEAM_DOMAIN`.
3. Give each staff member's gate address to the server: `npm run staff -- grant <username> <role> --email <address>` (only a keyed hash is kept). A staff invite records it on joining.
4. The person makes a setup code in Community (Settings, Staff passkey), opens the staff host, passes the gate and types the code to make their staff passkey.

The server refuses to start with a public `STAFF_ORIGIN` that is not https, is the public host, or has no Access settings. On `localhost` (for example `http://staff.localhost:8080`) it runs without the gate, for trying it on your own machine only.

Joining is invite-only until the privacy lawyer's review (decision 0006), and invites go to an email address (decision 0008). The first staff account comes from `npm run invite -- --email <address> --staff` on the server and joins as an Overseer; people with the `invites.send` scope then invite others from the app (Settings, Invite by email). Staff roles (decision 0009) are given and taken with `npm run staff`, which keeps at least one Overseer. The invited person opens the join page, types that address and the 6-digit code sent to it, then makes a passkey. `npm run dev:memory` invites `DEV_EMAIL` (default `you@example.com`) and prints the code in its window.

## Places data

Places (decision 0005) needs the area list. For the Philippines that is the **Philippine Standard Geographic Code** published by the Philippine Statistics Authority (psa.gov.ph, "PSGC", the quarterly Publication Datafile). Save its main sheet as CSV and import it with the edition printed on the file (e.g. `--edition "3Q 2026"`). The data stays out of this repository. The importer records PSA as the source, and the app credits it, with the edition and the import time, on the Places screen and the place picker (`GET /places/sources`). Re-import each quarter so the list stays current.

## Docker

```
docker build -t community .
docker run -e DATABASE_URL=... -e COMMUNITY_ORIGIN=... -p 8080:8080 -v community-media:/data/media community
```

The image runs as an unprivileged user and checks `/api/health`.
