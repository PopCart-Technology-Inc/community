# 0004 · Connected socials: one home, everything connected

- **Status:** Proposed (2026-10-14)
- **Licence:** CC BY 4.0

## Context

People already have Instagram, Facebook, TikTok and other accounts. Community should be their central home: one place for their work and their people, with their other accounts connected rather than abandoned.

## Decision

1. **Post once, everywhere**, through a social planner integration (GoHighLevel Social Planner). It connects Instagram, Facebook, TikTok, Threads and LinkedIn.
   - **Instagram** connects through Instagram Login, so no Facebook Page is needed. Instagram only allows this for **Professional accounts (Business or Creator)**. Switching a personal account to Creator is free and takes two taps in the Instagram app, and the connect screen walks people through it.
   - **TikTok** personal accounts connect directly.
2. **Bring your history.** People can upload the data download from Instagram, Facebook, X or TikTok, and their posts become their portfolio.
3. **Link and verify** other accounts on the profile.
4. **Federation** (ActivityPub) with Mastodon, Threads and the open web is kept as an outward bridge. Community stays the home.
5. **Never** ask for another platform's password, and never scrape another platform.

## Consequences

- Connections depend on each platform's rules, which change. The connect screens must be re-checked against the platforms' current documentation before each release.
- A connected account's tokens are secrets. They are stored encrypted and never logged.
