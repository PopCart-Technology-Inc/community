# 0008 · Invites go to an email address

- **Status:** Accepted (2026-10-20), on the owner's request.
- **Licence:** CC BY 4.0

## Context

Joining is invite-only until the privacy lawyer's review (decision 0006, point 8). Until 0.5.1 an invite was a link with a code in it. Anyone holding the link could join with it, so an invite could be posted in a group chat and used by a stranger.

Decision 0001 says to collect less. An email address is personal data, so the question is how to tie an invite to one person without building a list of addresses.

## Options

1. **Keep link codes.** Simple, but a link is a key anyone can copy.
2. **Store the invited address**, send the invite, and match it on joining. Works, but it leaves a list of everyone invited, linked to their account.
3. **Email-bound invites without storing the address.** Send the invite to the address, keep only a keyed hash of it, and on joining ask for the address and a code sent to it.

## Decision: option 3

1. **Staff invite an address**, in the app (Settings, Invite by email) or with `npm run invite -- --email`. The invite email links to the join page with **no code or token in the link**.
2. **Joining needs the address and its code.** The person types the address the invite went to; a 6-digit code is emailed to it (10 minutes, one use, 5 tries); the right code gives a 30-minute join ticket for the passkey step. Forwarding the invite email does not let anyone else in unless they also get into that inbox.
3. **The address is not stored.** The server keeps an HMAC-SHA256 of the lower-cased address under a server secret (`EMAIL_HASH_KEY`), and hashes of the code and ticket. When the invite is used, the address hash is cleared, so nothing ties the account to an email. Addresses are never written to logs.
4. **Nobody can test who is invited.** Asking for a code gets the same reply whether or not the address has an invite; a code is only sent when it has one. Requests are limited per network address and per email address.
5. **Sending goes through an email service** (Resend, configured with `RESEND_API_KEY`). It receives the address and the email to deliver them and keeps its own delivery log. Without a key, a local development server prints the email instead, and a public server refuses to send rather than dropping an invite.
6. **Emails carry no tracking:** no pixels, no web fonts, no per-person parameters in links. Each has a plain-text part that says the same as the HTML. The design is in [docs/design/email.md](../design/email.md).

## Consequences

- Link-only invites made before 0.6.0 stop working. Staff send those people an email invite.
- Changing `EMAIL_HASH_KEY` makes open invites unusable; they are sent again.
- Announcements to members (the campaign layout in the design) need stored addresses and an opt-in. That is not built: it needs its own decision and the lawyer's review.
