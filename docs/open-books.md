# Open Books: the format and the checks

Open Books ([decision 0009](decisions/0009-open-books.md)) keeps the community's money in public: every entry signed by trustees, chained by hashes and anchored on Bitcoin. This page is enough to check the books with your own code. The server's checker is `app/modules/books/ledger.ts`; the browser's, written separately, is `app/web/static/lib/ledger.js`. The tests check that they agree.

## Getting the ledger

`GET /api/books/ledger` (add `?download=1` for a file) returns:

```json
{
  "format": "popcart-community/open-books/v1",
  "currency": "PHP",
  "as_of": "2026-10-21T05:30:00.000Z",
  "entries": [ { "seq": 1, "prev": "000…000", "sealed_at": "…", "body": { … }, "sigs": [ … ], "conflicted": [], "hash": "…" } ],
  "keys":    [ { "key_id": "…", "handle": "…", "public_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" }, "created_at": "…", "retired_at": null } ],
  "anchors": [ { "id": 1, "upto_seq": 8, "root": "…" } ],
  "rules":   [ { "id": 1, "two_sig_over": 2000000, "set_by": null, "set_at": "…" } ]
}
```

Amounts are whole **centavos** (₱1 = 100). Dates are `YYYY-MM-DD`; times are ISO 8601 in UTC.

## Canonical JSON

Everything hashed or signed is **canonical JSON**: object keys sorted (by UTF-16 code unit, as JavaScript sorts strings) at every level, no spaces, strings escaped as `JSON.stringify` does, and only whole numbers. Keys whose value is missing are left out.

## An entry's body (what trustees sign)

| Field | Meaning |
|---|---|
| `v` | 1 |
| `id` | the draft's id (a UUID), so a signature cannot be moved to another entry |
| `kind` | `in` or `out` |
| `amount` | centavos, more than 0 |
| `currency` | `PHP` |
| `date` | the day the money moved |
| `category` | `popcart`, `donations`, `grants`, `ads`, `builders`, `hosting`, `legal`, `events`, `community_aid`, `bank_fees` or `other`. While PopCart holds the fund, money in is `popcart` only ([decision 0009](decisions/0009-open-books.md), point 9): the server refuses the other money-in categories. This is a rule of the holder, not of the chain, so the checks below do not test it. |
| `description` | what it was for |
| `party` | `{ kind, name }` for `company`, `person_consented` and `related_party`; `{ kind: "person_private", ref: "C-0012" }`; or `{ kind: "donors" }` (money in only) |
| `related_note` | for a related party: why it was the fair choice |
| `evidence` | `[{ name, sha256 }]`: the SHA-256 of each receipt, hashed on the drafter's device. The file itself is not stored. |
| `reverses` | for a correction: the `seq` of the entry it undoes |
| `assisted` | `true` when an AI tool helped prepare the draft |
| `two_sig_over` | the signing limit when it was drafted |
| `drafted_by`, `drafted_at` | the drafter's handle and the time |

## Signatures and keys

Each signature is ECDSA on P-256 with SHA-256 over the UTF-8 bytes of `canon(body)`, as 64 raw bytes (r ‖ s) in base64url. A key's id is the first 16 hex characters of `sha256(canon({ kty, crv, x, y }))`. A signature counts only if its key was live when the entry was sealed: `created_at <= sealed_at` and `retired_at` empty or later.

## The chain

`hash = sha256(canon({ seq, prev, sealed_at, body, sigs, conflicted }))`, in hex. `seq` starts at 1 with no gaps; `prev` is the hash of the entry before, or 64 zeros for the first.

## Anchors

An anchor's `root` is the Merkle root of the hashes of entries 1 to `upto_seq`: take the 32-byte hashes in order; while more than one is left, hash each pair joined (`sha256(a ‖ b)`), pairing an odd last one with itself. `npm run books:stamp` sends only that root to an OpenTimestamps calendar. The proof is at `GET /api/books/anchors/:id/proof`: a standard `.ots` file for the root as a SHA-256 digest (header, version 1, op `0x08`, the 32 bytes, then the timestamp). Complete and check it with the OpenTimestamps tools, for example `ots upgrade` then `ots verify -d <root>`.

## The checks

1. Entries are numbered 1, 2, 3… with no gaps (**order**).
2. Each `prev` is the hash of the entry before it (**link**).
3. Each hash matches its contents, recomputed (**hash**).
4. Each signature checks against a published key that was live at sealing, and that key's id matches (**signature**).
5. The rules (**rule**): signatures from at least `need` different trustees, where need is 2 when `amount > two_sig_over` or the party is a related party, else 1; no signer is the drafter; no signer declared a conflict; a reversal undoes an earlier entry exactly (opposite kind, same amount), and only once.
6. Adding `+amount` for `in` and `-amount` for `out` in order, the balance never goes below zero (**balance**).
7. Each anchor's root matches the Merkle root recomputed from the entries (**anchor**), so a change to an anchored entry shows even if every hash after it were rebuilt.

The bank match (`GET /api/books/reconciliations`) is a separate, human check: a trustee records the statement's closing balance and the statement's SHA-256; the ledger balance shown next to it is the sum of entries dated on or before the statement date.
