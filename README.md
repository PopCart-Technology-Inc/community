# PopCart Community

The open network for people who work. Riders, fisherfolk, cooks, tutors, coders, tailors, everyone.

Show your work, find your people, and get hired on proof, without an algorithm deciding who sees you and without anyone selling your data.

- **Vision:** [popcartph.com/community](https://popcartph.com/community) (every name and number there is an example)
- **Home:** [community.popcartph.com](https://community.popcartph.com)

> **Status: nothing is built yet.** This repo is where the work starts, in the open, from the first commit.

## What it will be

| Part | What it does | Replaces |
|---|---|---|
| **Profiles** | Proof of your work: signed badges you carry and choose to show | the CV, the "trust me" |
| **Feed** | Post once, reach anyone on Mastodon, Threads or any ActivityPub app. Newest first, no algorithm | Instagram, X |
| **Groups** | Your barangay, your trade, your crew: events with a place, a time and who is going | Facebook groups |
| **Work** | Post a gig, pick on proof, pay person to person, rate on clear criteria | Upwork |

We build them one at a time, in that order. **Profiles come first.**

## How it treats your data

**We hold keys, not data.** See [docs/decisions/0001-hold-keys-not-data.md](docs/decisions/0001-hold-keys-not-data.md).

1. **Collect less.** Only what a feature needs. No ad profiles, no tracking, no selling.
2. **Sign instead of share.** PopCart issues signed credentials (W3C Verifiable Credentials) that you keep and show if you choose. No records get copied over.
3. **Identity stays apart.** Your real name, phone and ID never come into Community.
4. **Private means end-to-end encrypted.** The server stores what it cannot read.
5. **Count, don't track.** Analytics are aggregate counts only, and groups that are too small are hidden.

Export or delete your account in one tap.

## What is open and what is not

- **Open:** PopCart Community, this repo. Code is [AGPL-3.0](LICENSE); docs and written guides are [CC BY 4.0](LICENSE-DOCS).
- **Closed:** every other PopCart product (the PopCart app, PopCart Rider, PopCart Sellers, Partner Hub, Ops). The only link between them and Community is the signed credentials, and only when a person opts in.
- **Not licensed:** the PopCart name, the Pop Mark and the wordmark are trademarks. See [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every commit is signed off under the [Developer Certificate of Origin](https://developercertificate.org/). Security reports go to [SECURITY.md](SECURITY.md), never to public issues.

Copyright © 2026 PopCart Technologies, Inc. and the PopCart Community contributors.
