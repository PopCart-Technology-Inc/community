# 0003 · Feeds and spaces: no hidden algorithm, plenty of structure

- **Status:** Proposed (2026-10-14)
- **Licence:** CC BY 4.0

## Context

Engagement-ranked feeds (Facebook, Instagram, X's "For You") decide who is seen, in secret. A purely chronological feed (Mastodon) is calm, but people cannot find each other, and photos and videos get no traffic.

What other platforms teach:
- Groups and events hold communities together (Facebook).
- Real-time spaces with roles create belonging (Discord).
- Communities moderate best when they moderate themselves (Reddit).
- Letting people choose their feed builds trust (Bluesky).
- Proof is what gets people hired (Upwork, LinkedIn).

## Decision

1. **Following** is newest first and never re-ordered.
2. **Discover feeds** (Near me, My trade, Picks) are ranked by a **published formula**.
   - **Signals:** how near you are, your trade, thanks (salamat) from *different* people, and how recent a post is.
   - **Never:** paid boosts, outrage or engagement-bait signals, or anything about a person's private data.
   - **Every ranked post** answers "Why am I seeing this?"
   - **The ranking code lives in this repository.** Changing it is a pull request anyone can read.
3. **Pick your feed.** People choose which feeds they see. Feeds built by the community can come later.
4. **Fair traffic.** There is a cap on how often one account appears in a feed, so new people get seen.
5. **Picks and a Hall of Fame:** chosen every Monday, half by the community and half by editors.
6. **Spaces:** one per barangay, trade or crew.
   - Channels for chat, posts, events, media and gigs.
   - Roles and moderators, with rules written in public.
7. **Media:**
   - Every profile has a portfolio grid.
   - Short videos show in Discover.
   - Uploads are compressed, and video length and size are capped at first.

## Consequences

- The ranking service must explain every result. That limits which signals can be used, by design.
- Moderation tools for Spaces (reports, queues, roles) ship with Spaces, not after.
