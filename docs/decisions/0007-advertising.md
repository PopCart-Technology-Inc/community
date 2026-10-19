# 0007 · Advertising: labelled, separate, and never built on private data

- **Status:** **Proposed** (2026-10-19). Not in force until PopCart Technologies, Inc. accepts it. Until then the app shows no ads and promises only that data is never sold and that any ad will be clearly labelled.
- **Licence:** CC BY 4.0

## Context

Advertising is on PopCart's roadmap. The sign-up screen used to say "we never sell your data or show you ads. No tracking." Once ads arrive, that would be a broken promise, so it was withdrawn (decisions 0001 and 0002, changed 2026-10-19). People should know now how ads would work, so the promise they read on joining is one we keep.

Other parts of the design already limit what ads can be:
- decision 0001: data is never sold; private messages are end-to-end encrypted; the sealed vault is opened only for a court; improvement data is never used for ads;
- decision 0003: ranked feeds take no paid boosts;
- the Philippine Data Privacy Act (RA 10173): personal data needs a lawful basis, and consent must be specific and freely given.

## Options

1. **No ads at all.** Simplest promise. Leaves the roadmap without this income.
2. **Contextual ads only.** An ad is chosen by where it is shown (the Places level and area, the trade feed, a Space's topic), never by profiling the person. No tracking at all.
3. **Contextual by default, personalised only by opt-in.** Like option 2, plus an off-by-default switch that lets a person choose interests (not inferred) for ads.
4. **Behavioural ads** (profiles built from what people read and do, as on Facebook and Instagram). Conflicts with decision 0001 and with the trust the platform is built on.

## Proposed decision: option 2, with option 3 as a later step

1. **Always labelled.** Every ad says "Sponsored" (or "Paid partnership · @brand") on a solid plate, first line, never smaller than the post text, in every language.
2. **Separate from the feeds.** Ads sit in their own slots, at a fixed, published frequency (for example at most 1 in every 10 items). They never change the ranking of posts or gigs: decision 0003's "no paid boosts" holds.
3. **Contextual only.** An ad is chosen by the place and level being viewed, the trade feed, or the Space it appears in. Never by a person's history, followers, messages or profile.
4. **Never from private data.** Ads never use direct messages, private Spaces, the sealed vault, credentials, improvement data, or location finer than the area being viewed.
5. **No tracking.** No third-party ad scripts, pixels or cookies in the app; nothing that follows people across other apps or websites.
6. **Advertisers get totals, not people.** Reports show counts per area and day, with groups under 20 hidden, the same rule as decision 0001's counts. No personal data ever goes to an advertiser.
7. **"Why this ad?"** Every ad answers it, like every ranked post.
8. **Nothing sensitive.** No political, religious, health, lending or gambling ads; no ads in child-safety or moderation screens.
9. **Personalised ads later, only by choice** (option 3): an off-by-default switch where people pick interests themselves. It needs its own decision before it is built.

## If accepted

- The sign-up point can say: "We never sell your data. Ads are labelled, and never based on your messages or private records."
- The ad module, its frequency and its "Why this ad?" rules are built in this repository, in the open.
