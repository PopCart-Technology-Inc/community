# 0002 · Sign-up and phone verification

- **Status:** Accepted (2026-10-15). Legal review pending before launch.
- **Licence:** CC BY 4.0

## Context

Every account needs a verified phone ([0001](0001-hold-keys-not-data.md), layer 3). A paid text message for every sign-up costs money, and the bill grows with every new person. It also invites "SMS pumping", where bots trigger thousands of paid codes. People must also read what they agree to before they join.

## Decision

### Sign-up screens
1. Enter your phone number.
2. **Before you join:** five plain points, in English and Filipino:
   - your phone and login records are kept, sealed;
   - they are opened only for a court order, and you are told;
   - we never sell your data or show you ads;
   - the community rules apply to everyone;
   - you must be 18 or older.
   Each point links to the full Terms, Privacy notice and Community rules.
3. An **unticked** box: "I've read and agree to the Terms, Privacy notice and Community rules." The Join button stays disabled until it is ticked.
4. The improvement-data switches, all **off** ([0001](0001-hold-keys-not-data.md), layer 6).
5. Set up a passkey.

We store which version of the terms each person agreed to, and when. When the terms change in a way that matters, we ask again.

**Age 18 and up** at launch.

### Verification, cheapest first
Verification costs come from new sign-ups, never from posts. Posting never sends a text.

1. **Already verified elsewhere:** a person who holds a signed "verified phone" credential from PopCart is verified with no new text.
2. **Reverse SMS (default):** the screen shows a code, and the person texts `JOIN <code>` from their phone to our number. A receiving phone forwards the text to the server.
   - It costs us nothing per sign-up, and the person pays for one ordinary text.
   - Bots cannot make us send anything, so SMS pumping does not work.
   - It proves the person holds the number, which is a registered SIM under the SIM Registration Act (RA 11934).
3. **Fallback:** a one-time code sent to the phone through a low-cost provider, behind a hard daily budget cap.
4. **Logging in afterwards:** passkeys (face or fingerprint). Texts are used only for account recovery.

**Abuse guards:**
- Philippine mobile numbers only.
- A human check before any code is sent.
- Rate limits per number, device and network address.

## Consequences

- We need a receiving number and a gateway. Its availability must be monitored.
- People without credit can use the fallback.
- The full terms, privacy notice and community rules must exist, in both languages, before launch.
