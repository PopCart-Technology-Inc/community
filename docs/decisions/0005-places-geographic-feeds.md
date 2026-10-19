# 0005 · Places: one feed that zooms from your barangay to the world

- **Status:** Accepted (2026-10-19). Legal review pending before launch.
- **Licence:** CC BY 4.0
- **Changes:** decision 0003. The "Near me" feed becomes **Places**.

## Context

People want to see what is happening at very different distances: their street, their city, their region, the whole country, and Filipinos everywhere. Five separate feed tabs would crowd the screen and make choosing slower. A single "near me" radius hides everything further away.

What other platforms teach:
- Neighbourhood feeds are useful but often quiet (Nextdoor).
- People already understand zooming from maps; a location sheet with search, current place, home and recents is familiar (Facebook Marketplace, Apple Weather).
- Country feeds get dominated by the capital unless something stops it (r/Philippines next to r/Cebu).
- A ranking nobody can see is what people resent most (Upwork's "Best Matches").

## Decision

1. **One Places tab with a five-stop zoom:** Barangay, City, Region, Country, World. The dots grow with the area they cover. It opens on **City**. A one-time tip explains the zoom; pinching the feed zooms too.
2. **Each level has its own published rule**, shown in one line above the feed, with "How?" opening the formula:

   | Level | Order |
   |---|---|
   | Barangay | Newest first: small enough to see everything. |
   | City | Ranked by nearness, trade, thanks (salamat) from different people, recency. |
   | Region | Same signals; thanks from different people weigh more. |
   | Country | Same signals, plus a mix rule: no single city gets more than 1 in 4 posts. |
   | World | Ranked across countries and mixed by country, so no single country dominates. |

   The rules of decision 0003 still hold at every level: no paid boosts, no outrage signals, at most 2 posts per account in every 20, "Why you're seeing this" on every ranked post, and the weights per level live in this repository.
3. **Quiet places widen.** When a level has little in it, the feed says so and offers the next level out ("See all of Pasig"), instead of showing an empty screen.
4. **Every post shows where it is from, at the level's precision:** a rounded distance in a barangay ("300 m"), the city in a region or the country, and the city and country in the world view.
5. **The author decides reach.** When posting, people pick how far the post can travel in Places (Barangay to World, default City). Their followers always see it.
6. **Translation on request.** Posts in Filipino, Cebuano, Ilocano and other languages carry "See translation"; the original is always one tap away.
7. **Location stays on the phone.** "Use where I am now" is worked out on the device. The server stores only an area code, never coordinates or a location trail. Philippine levels follow the Philippine Standard Geographic Code (barangay, city or municipality, province, region). Outside the Philippines, people choose a country and city.

## Rejected

- **Five separate tabs** (Barangay, City, Region, Country, World): too many choices on screen, and the relationship between them is lost.
- **A distance slider stored on the server:** precise location is personal data we do not need (decision 0001).
- **One national feed:** the capital would drown out everyone else.

## Consequences

- The feed service needs the area-code hierarchy (a published dataset) and per-level weights in code.
- The composer gets a "Who can find it in Places" choice.
- Translation needs a provider decision that fits the data rule (decision 0001) and the spending limits; until then, the link is not shown.
