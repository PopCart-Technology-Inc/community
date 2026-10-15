# PopCart Community

> **This repository is public. Security and leaks come first.** Before contributing, read [AGENTS.md](AGENTS.md) and run `git config core.hooksPath .githooks` once in your clone.

The open network for people who work. Riders, fisherfolk, cooks, tutors, coders, tailors, everyone.

Show your work, find your people, and get hired on proof, without an algorithm deciding who sees you and without anyone selling your data.

- **Vision:** [popcartph.com/community](https://popcartph.com/community) (every name and number there is an example)
- **Home:** [community.popcartph.com](https://community.popcartph.com)

> **Status: nothing is built yet.** This repo is where the work starts, in the open, from the first commit.

## What it will be

| Part | What it does | Replaces |
|---|---|---|
| **Profiles** | Proof of your work: signed badges you carry and choose to show | the CV, the "trust me" |
| **Feed** | Following is newest first; Near me, My trade and Picks are ranked by a public formula. Post once to Instagram, Facebook, TikTok and Threads | Instagram, X |
| **Spaces** | Your barangay, trade or crew: channels for chat, posts, events, media and gigs, with roles and moderators | Facebook groups, Discord |
| **Work** | Post a gig, pick on proof, pay person to person, rate on clear criteria | Upwork |

We build them one at a time, in that order. **Profiles come first.**

## How it treats your data

**We hold keys, not data, and what the law makes us keep is sealed.** See [docs/decisions](docs/decisions/): [0001](docs/decisions/0001-hold-keys-not-data.md) data, [0002](docs/decisions/0002-sign-up-and-verification.md) sign-up, [0003](docs/decisions/0003-feeds-and-spaces.md) feeds and spaces, [0004](docs/decisions/0004-connected-socials.md) connected socials.

1. **Collect less.** Only what a feature needs. No ad profiles, no tracking, no selling.
2. **Sign instead of share.** PopCart issues signed credentials (W3C Verifiable Credentials) that you keep and show if you choose. No records get copied over.
3. **Identity sealed.** Your phone and ID checks sit in a sealed vault, opened only for a court order, and you are told.
4. **Private means end-to-end encrypted.** The server stores what it cannot read.
5. **Count, don't track.** Running the service needs only aggregate counts, and groups that are too small are hidden.
6. **Improvement data, by choice.** Off until you switch it on, one switch per purpose, explained in plain words, shown on a public page, and deleted when you switch it off. Never sold, never for ads.

Export or delete your account in one tap.

## What is open and what is not

- **Open:** PopCart Community, this repo. Code is [AGPL-3.0](LICENSE); docs and written guides are [CC BY 4.0](LICENSE-DOCS).
- **Closed:** every other PopCart product (the PopCart app, PopCart Rider, PopCart Sellers, Partner Hub, Ops). The only link between them and Community is the signed credentials, and only when a person opts in.
- **Not licensed:** the PopCart name, the Pop Mark and the wordmark are trademarks. See [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every commit is signed off under the [Developer Certificate of Origin](https://developercertificate.org/). Security reports go to [SECURITY.md](SECURITY.md), never to public issues.

Every pull request is checked and reviewed by a maintainer before it is merged. Versions follow [Semantic Versioning](https://semver.org/): see [CHANGELOG.md](CHANGELOG.md) and the [Releases](https://github.com/PopCart-Technology-Inc/community/releases) page.

Copyright © 2026 PopCart Technologies, Inc. and the PopCart Community contributors.
