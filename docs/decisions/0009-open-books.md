# 0009 · Open Books: the community's money, in public

- **Status:** Accepted (2026-10-21), on the owner's request. Revised the same day: PopCart holds the fund for now, instead of a foundation (point 9). The tax and privacy pieces wait for a lawyer's and an accountant's review.
- **Licence:** CC BY 4.0

## Context

Community is meant to belong to the people who use it. Money changes that quickly: PopCart pays for it first, later donations, grants and a share of ad income (decision 0007) may come in, and builders, hosting and legal work will be paid. People should be able to see how much came in, where it went and who was paid, without asking anyone.

Two things are hard about this. A spreadsheet on a website can be changed quietly after the fact. And a list of payments is full of people: paying a person in public can expose them.

## Options

1. **A yearly report.** Normal for non-profits, but late, summarised and impossible to check line by line.
2. **Put the money on a blockchain** (a token or a stablecoin treasury). Every move is public, but it puts members' money in crypto, adds exchange risk and fees, and does not stop anyone from describing a payment wrongly.
3. **Keep the money in a bank and put the books in public, with proof.** Every entry is signed by the people responsible, chained by hashes so no entry can be changed or removed without it showing, and the chain's fingerprint is stamped on Bitcoin so even the server operator cannot rewrite history. Anyone can download the whole ledger and check it themselves.

## Decision: option 3

1. **The money stays in an ordinary bank account** of its own, used for nothing else (point 9). Open Books records the money; it never holds it.
2. **Every entry is public and read-only:** amount, date, category, what it was for, who was paid or who paid, and the hash of each receipt or invoice. Anyone can read Open Books, signed in or not.
3. **Entries are signed by trustees.** A trustee is a member appointed by staff, in public: the ledger shows who appointed whom and when. Each trustee makes a signing key (ECDSA P-256) in their own browser; the private key never leaves it, and the server keeps only the public key. Old keys stay published so old signatures can always be checked.
4. **The rules are code, and the code checks them on every entry:**
   - An entry needs one trustee signature, or **two** when it is over the published limit (₱20,000 to start; staff can change it, and every change is published) or when it pays a related party.
   - Nobody signs an entry they drafted. A trustee who declares a conflict on an entry cannot sign it, and the conflict is published with it.
   - A payment cannot take the balance below zero.
   - An entry is never edited or deleted. A mistake is fixed with a reversing entry that points at the one it undoes. The database refuses changes to sealed entries.
   - AI tools may help draft an entry, and the entry says so. Only a person's key can sign.
5. **The chain:** each sealed entry carries the hash of the one before it. From time to time a trustee adds an **anchor**: the Merkle root of every entry so far. The anchor is stamped on Bitcoin with OpenTimestamps and its proof file is published, so anyone can show that the books existed in that exact form at that time. Only 32-byte fingerprints go to Bitcoin: no amounts, names or personal data.
6. **Bank match:** every month a trustee records the bank statement's closing balance and the statement's hash. Open Books shows it next to its own balance for that date, matched or not.
7. **People who are paid are protected** (decision 0001). Companies are named. A person is named only if they agreed to it; otherwise the entry shows a stable ID (for example `C-0012`), the same for every payment to them, so their total is still public. Community stores only that ID: who it stands for is kept by the fund's holder, not here. Receipts are not uploaded: the browser hashes the file and only the hash is stored, so a receipt shown later can be checked against it.
8. **Anyone can check the books:** download the full ledger as one JSON file, or run the check in the browser on the Proof page. The format and the checks are in [docs/open-books.md](../open-books.md).
9. **Who holds the money, for now: PopCart.** Registering a foundation or a cooperative takes months and money, and it is not clear yet which one fits. So the fund starts as PopCart's money, set aside for Community:
   - A separate bank account, used only for Community, that PopCart pays into. Open Books says plainly that it is PopCart's money, not the members'.
   - **Money in comes only from PopCart.** The server refuses donations, grants and ad income (category `popcart` only). Nobody is asked to give to an account that one company controls.
   - Anything paid to PopCart, its owner or its staff, or to a company tied to them, is a related party: two signatures and the reason, in public.
   - **Next steps,** each one a new decision: when others want to give, an existing accredited foundation holds the money for Community as a restricted fund (fiscal sponsorship), and its people become trustees; when Community has members who share money, its own non-stock foundation or cooperative takes over. The ledger carries over unchanged: it does not depend on who holds the account.
   - **Before the first peso:** the account is open and a lawyer and an accountant have reviewed this design (tax treatment, related-party rules, data privacy). Until then Open Books is empty and says so. It never shows example or made-up figures.

## Consequences

- Trustees need a browser that keeps its key. A lost key means a new key, published; the trustee's old signatures still check.
- Staff appoint trustees for now. Electing them is a later decision.
- A wrong entry stays in the ledger forever, next to the entry that reverses it. That is the point.
- Financial records are kept even when a trustee deletes their account (the law requires it): the ledger keeps the handle that signed.
- Budgets per category are set by staff and every change is published, like the signing limit.
