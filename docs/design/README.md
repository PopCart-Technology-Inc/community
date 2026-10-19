# Platform design

The approved design of PopCart Community (2026-10-19): what each screen does and why. It is written to be built from. The visual preview, with PopCart's brand art, is published by PopCart; brand art is not part of this repository (see [TRADEMARKS.md](../../TRADEMARKS.md)).

Every name, number and post in the design is an example. The real product shows live values with the time they were read.

## Principles

1. **Content is the star.** Inside the app the brand takes a small part of the screen: the wordmark, the main button, the active tab, the verified badge. Posts are separated by hairlines, not boxed. The loud brand style is kept for the welcome screen.
2. **Familiar first.** People should know how to use it in the first minute, so each part follows a pattern they already know (table below).
3. **Our differences stay visible but quiet:** "Why you're seeing this", Salamat instead of likes, signed proof of work, and a lock line on private Spaces and messages.
4. **Phone, tablet and web.** The phone app has five tabs and a compose button. A tablet gets an icon rail and one column. The web app has three columns, with labels from 1280 px ([layout](../web.md#layout)).
5. **Accessible.** 15 px body text, 44 px tap targets, text contrast at AA or better, focus rings, and every control reachable without gestures.

| Part | Pattern people know | Our difference |
|---|---|---|
| Post | X / Threads: avatar column; name, trade and time on one line; actions spread across the width | Salamat; "Why you're seeing this" in the post menu |
| Feed tabs | Bluesky / Threads pinned feeds | Following, Places, My trade, Picks; the formula is public |
| Home row | Instagram Stories | your Spaces with unread rings |
| Profile | Instagram: cover, avatar, bio, counts, 3:4 grid | signed proof under the bio |
| Space | Facebook Group page; Discord channels; Messenger list | rules pinned; private Spaces end-to-end encrypted |
| Work | Upwork job card: pay, client trust, proposals | a Newest tab and a ranking that explains itself |
| Settings | iOS grouped settings | "Who opened my records" |

## Screens

**Join:** welcome · phone number (or a PopCart credential) · text "JOIN code" to our number · "Before you join" in five points, English and Filipino, with an unticked box · improvement data, both switches off · passkey · profile (first name, username, trade, city) · find Spaces and people in your trade. See decision [0002](../decisions/0002-sign-up-and-verification.md).

**Home:** Following (newest first, ends with "You're all caught up") · Places (decision [0005](../decisions/0005-places-geographic-feeds.md)) · "Why you're seeing this" · post and replies · new post (audience, reach in Places, post to connected socials) · search and explore (Monday Picks by thanks) · activity.

**Spaces:** your Spaces (pinned, unread counts) · a Space page (cover, Join, tabs: Posts, Chat, Events, Gigs, Members, About) · channels · inbox with Requests for strangers · messages (end-to-end encrypted). See decision [0003](../decisions/0003-feeds-and-spaces.md).

**Work:** gigs (For you, Newest, Saved, My gigs; filters) · gig details (pay, when, where, paid how, the poster's record) · apply with signed proof · pick someone (pay goes person to person) · rate on criteria and say salamat.

**Me:** profile · add proof (a credential signed from live data, with an "as of" date) · ID check, sealed · connect socials. See decisions [0001](../decisions/0001-hold-keys-not-data.md) and [0004](../decisions/0004-connected-socials.md).

**Safety:** report · your data (what we hold, choices, export, delete) · who opened my records · transparency report ("No numbers yet" until there are real ones) · moderator queue (Keep, Warn, Remove) · a court order with two approvals.

## Places in one picture

```
Barangay ──── City ──── Region ──── Country ──── World
  •            ●          ⬤           ⬤            ⬤      the dot grows with the area
newest       ranked     thanks      mix rule:     mixed
first                   weigh more  ≤ 1 in 4      by country
                                    per city
```

## What is not designed yet

- Notifications settings, Space creation and roles editing, event pages, the gig poster's flow end to end.
- Dark mode (the brand has none yet).
- Translation provider (decision 0005, consequences).
