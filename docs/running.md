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

```
npm start                                  # migrates, then listens
npm run invite -- --staff --note "first"   # prints a one-time invite link
npm run places:import -- psgc.csv --edition "3Q 2026"   # loads the Philippine Standard Geographic Code
```

Joining is invite-only until the privacy lawyer's review (decision 0006). The first staff account comes from `npm run invite -- --staff` on the server; staff then invite others from the app.

## Places data

Places (decision 0005) needs the area list. For the Philippines that is the **Philippine Standard Geographic Code** published by the Philippine Statistics Authority (psa.gov.ph, "PSGC", the quarterly Publication Datafile). Save its main sheet as CSV and import it with the edition printed on the file (e.g. `--edition "3Q 2026"`). The data stays out of this repository. The importer records PSA as the source, and the app credits it, with the edition and the import time, on the Places screen and the place picker (`GET /places/sources`). Re-import each quarter so the list stays current.

## Docker

```
docker build -t community .
docker run -e DATABASE_URL=... -e COMMUNITY_ORIGIN=... -p 8080:8080 -v community-media:/data/media community
```

The image runs as an unprivileged user and checks `/api/health`.
