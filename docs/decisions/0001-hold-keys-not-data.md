# 0001 · Hold keys, not data

- **Status:** Proposed (2026-10-14). Pending acceptance by PopCart Technologies, Inc. and review by a Philippine privacy lawyer before launch.
- **Licence:** CC BY 4.0

## Context

PopCart Community is an open-source social and work network, open to everyone. It will hold some people's posts, profiles and messages. The safest data is data we never hold, and people should own what describes them.

Philippine law applies whatever we decide: the Data Privacy Act (RA 10173), which covers Filipinos' data even when it is processed abroad, the National Privacy Commission's rules (including the 72-hour breach notice), the Anti-OSAEC law (RA 11930) and the Cybercrime Prevention Act (RA 10175).

## Decision

**Hold keys, not data.** Five layers:

1. **Collect less.** Community stores only what a feature needs. No ad profiles, no tracking, no selling, ever.
2. **Sign instead of share.** PopCart's closed apps never send their records into Community. When a person asks, PopCart issues a signed credential (W3C Verifiable Credential), for example "1,240 deliveries, 97% on time, as of 14 Oct 2026". The person keeps it and decides whether to show it, and anyone can check the signature. Credentials carry an "as of" date and are re-issued from live data.
3. **Split identity from profile.** Real names, phone numbers, ID checks, addresses and trip histories stay in PopCart's closed systems. Community knows a handle, linked only by a random identifier, and profiles are opt-in.
4. **Private means end-to-end encrypted.** Messages, drafts and private groups are encrypted with keys only their members hold. The server stores ciphertext it cannot read.
5. **Count, don't track.** Analytics are aggregate counts only, with small groups (under about 20 people) suppressed. There is no per-person analytics export.

Federation (ActivityPub) lets anyone run a server. Each server operator is responsible for its own users' data.

### Rejected

- **Mirroring data to a second store:** a second copy doubles what can leak.
- **Hosting abroad to avoid local law:** RA 10173 still applies.

## Duties we keep

- A report button, a review queue, take-downs and the reporting the law requires (RA 11930).
- A named Data Protection Officer, a privacy impact assessment, and registration with the National Privacy Commission where the thresholds apply.
- Breach notice within 72 hours.
- One-tap export and one-tap delete for every account.

## Consequences

- The only interface between PopCart's closed apps and Community is a credential issuer on one side and a verifier on the other.
- Some features are harder by design: no "people you may know" from uploaded contacts, no per-person ad targeting, no cross-app tracking.
