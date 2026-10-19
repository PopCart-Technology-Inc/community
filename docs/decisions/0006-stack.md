# 0006 · The stack: small, standard, and runnable by anyone

- **Status:** Accepted (2026-10-19).
- **Licence:** CC BY 4.0

## Context

PopCart Community is open source and run on a small budget. Anyone should be able to read the code, run it on one machine, and trust what it does with their data (decision 0001). Every dependency is code we did not write, running with access to people's data, in a public repository: fewer is safer.

## Decision

1. **TypeScript on Node.js 24, run directly.** Node runs `.ts` files natively (type stripping), so there is no build step. Only erasable TypeScript syntax is used (no `enum`, no namespaces). `tsc --noEmit` checks types in CI.
2. **No web framework.** A small router on `node:http` (`app/http/`). Fewer dependencies, every request path readable in one place.
3. **PostgreSQL** for the platform, with plain SQL migrations (`app/db/migrations/`). Tests run the same SQL on PGlite (Postgres compiled to WebAssembly), so no database server is needed to test.
   - The sealed identity vault (decision 0001) is a **second, separate database**, never queried by the platform code paths.
4. **The web app is a progressive web app** served by the same server: plain HTML, CSS and JavaScript modules, no bundler. Installable from the browser; an Android wrapper can come later.
5. **Passkeys (WebAuthn)** for login, with the maintained `@simplewebauthn/server` library. No passwords are ever stored.
6. **Brand art is not in this repository** (TRADEMARKS.md). The server reads an optional brand pack (wordmark and illustrations) from a directory given at deploy time. Without it, the app shows a plain text name and neutral shapes.
7. **Dependencies:** exact versions, a committed lockfile, Dependabot updates, and a short list. Runtime: `pg`, `@simplewebauthn/server`. Development: `typescript`, `@types/node`, `@electric-sql/pglite`.
8. **Joining is invite-only until the privacy lawyer's review is done** (decisions 0001-0002). Invited staff and testers join with an invite and a passkey; no phone number is collected yet. (Changed 2026-10-20 by decision [0008](0008-email-invites.md): invites go to an email address, and joining needs that address and a code sent to it, in place of a link anyone could use.) Public sign-up with phone verification opens after the review.

## Rejected

- **A framework (Next.js, Nest, Rails):** large dependency trees and build steps for a small app.
- **A managed backend (Firebase, Supabase cloud):** puts people's data with a third party and costs money per use.
- **SQLite only:** fine for one machine, but the vault separation, concurrent writes and full-text search are simpler on Postgres.

## Consequences

- Contributors need Node 24 and nothing else to run the tests.
- CI runs the type check and the tests on every pull request, next to the leak check and DCO.
- The deploy needs a Postgres server and, optionally, the brand pack.
