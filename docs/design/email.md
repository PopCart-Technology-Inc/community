# Email design

Community's emails follow Stage mode, like the app ([README](README.md)), rebuilt for email clients. The code is `app/mail/`: `design.ts` holds the shell and the blocks, `messages.ts` the emails. `npm run mail:preview -- <dir>` writes every email (HTML and text) so it can be checked in a browser and in real inboxes.

## The shell

```
Cream page
┌──────────────────────────────┐  Yellow header, 3px Ink edge, 24px corners
│ [wordmark]         COMMUNITY │  the drawn wordmark from the brand pack, or the plain name
├──────────────────────────────┤
│ KICKER                       │  White card, 3px Ink edge
│ Headline                     │
│ Lead                         │
│ blocks…                      │
└──────────────────────────────┘
why you got this · name · host · open source
```

Width 560 px at most; it fits a 320 px phone with no sideways scroll.

## Blocks

| Block | Looks like | For |
|---|---|---|
| `kicker` | Ink pill, Yellow mono capitals | what kind of email this is ("Invite", "Join code") |
| `headline` | 30 px, weight 900 | one short line |
| `lead` | 17 px | the one sentence that matters |
| `para` | 15 px | more text, rarely |
| `button` | Cart Blue pill, Yellow words, 3px Ink edge, hard Ink shadow | the one action, as in the app |
| `codeChip` | Cream chip, 40 px mono digits | one-time codes |
| `steps` | Yellow number stickers | what to do, in order |
| `note` | Sky, Kiwi, Gum or Cream sticker | one point that matters (a deadline, a safety line) |
| `sections` | titles and lines split by hairlines | announcements |
| `picture` | hosted https image with an Ink edge | announcements |
| `fine` | 13 px grey | "Not expecting this?" |

## Rules

- **Tables and inline styles only.** Most email clients drop `<style>` and do not do flexbox.
- **No web fonts.** Fetching them would tell a font server who opened the email. The stack starts with Archivo for those who have it.
- **No tracking.** No pixels, no per-person parameters in links, only `https` links.
- **The wordmark is an image, never typed.** It comes from the brand pack (`BRAND_DIR/email/wordmark.png`, not in this repository: [TRADEMARKS.md](../../TRADEMARKS.md)), served from `/brand/email/`. Its alt text is the fallback. Without the brand pack, the plain product name in bold.
- **Flat colour, hard edges.** No gradients, blur or soft shadows. Light only (`color-scheme: light only`).
- **Every email has a plain-text part** that says the same, and a footer line saying why the person got it.
- **Voice:** short words, one idea per line, at most one wink ("Come on in.").

## The emails

| Email | When | Subject |
|---|---|---|
| Invite | staff invite an address | You're invited to PopCart Community |
| Join code | an invited address asks for a code | Your Community code: 123456 |
| Announcement | the campaign layout: release notes, events. Not sent to members yet (decision [0008](../decisions/0008-email-invites.md)) | set by the sender |
