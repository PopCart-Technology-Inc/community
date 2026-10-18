# Changelog

Every change people will notice is listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each version is a git tag (`v0.1.0`) with a GitHub Release. How releases are made: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Added
- The platform design, written to build from: principles, the familiar pattern behind each part, every screen, and what is not designed yet ([docs/design](docs/design/README.md)).
- Decision 0005, accepted: **Places**, one feed that zooms from barangay to city, region, country and world, with a published rule per level, a mix rule so no city takes over the country feed, author-chosen reach, and location that never leaves the phone.
- Every change is versioned: pull requests must add a line here, and a release must use the next version its lines call for. Checked by the pre-push hook, the pull request checks and the release workflow.

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
