# Changelog

Every change people will notice is listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each version is a git tag (`v0.1.0`) with a GitHub Release. How releases are made: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

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

[Unreleased]: https://github.com/PopCart-Technology-Inc/community/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PopCart-Technology-Inc/community/releases/tag/v0.1.0
