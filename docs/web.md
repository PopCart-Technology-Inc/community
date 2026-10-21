# The web app

A progressive web app: plain HTML, CSS and JavaScript modules, no framework, no bundler, no build step (decision [0006](decisions/0006-stack.md)). The server serves `app/web/index.html` for every path that is not an API, brand, static or media path, and the client-side router picks the screen. The design it follows is [docs/design](design/README.md).

## Files

```
app/web/
  index.html              the only HTML. __NONCE__ is filled per request on its <link>, <style> and <script>
  sw.js                   service worker at /sw.js: caches /static/* and the manifest only
  manifest.webmanifest    name, colours, a plain circle icon (no brand art)
  static/                 served at /static/
    app.js                boot, app shell, router wiring, nav, right rail, unread badges
    core.js               shared state (the signed-in person), nav(), safe localStorage
    ui.js                 shared UI: app bar, avatar, post, sheets, toasts, Places zoom, paged lists
    app.css               all styles (Stage mode tokens from the approved design)
    lib/                  helpers; the pure ones are tested in Node (test/web.test.ts)
      router.js           path patterns and matching (pure), the ROUTES table
      b64.js              base64 and base64url (pure)
      webauthn.js         passkey JSON <-> ArrayBuffers (pure)
      e2e.js              message encryption (pure WebCrypto), see docs/e2e-client.md
      places.js           zoom levels, code at a level (pure)
      format.js           times, "as of", pay, counts (pure)
      media.js            photo re-encoding through a canvas, upload
      keystore.js         the message key in IndexedDB
      api.js              fetch wrapper; errors carry the server's message
      dom.js              h() element builder and icons
      brand.js            the optional brand pack
    screens/              one module per area; each screen returns { node, title, tab, bare, cls, cleanup }
      join.js             welcome, join (invite), login
      home.js             Following, Places, My trade, Picks, post, compose, explore, activity
      spaces.js           Spaces list, a Space, channel chat
      messages.js         inbox, direct messages
      work.js             gigs, gig, apply, applicants, rate, post a gig
      me.js               profile, settings, proof, other accounts
      safety.js           report, your data, record log, moderator actions, transparency, mod queue
```

## Screens and paths

| Path | Screen |
|---|---|
| `/` | Following (signed out: welcome) |
| `/places`, `/places/:level/:code` | Places with the five-stop zoom |
| `/trade`, `/picks` | My trade, Monday Picks |
| `/join` · `/login` | Join: the invited email address, the code sent to it, then the five steps and a passkey · passkey login |
| `/p/:id` · `/compose` | A post and replies · new post (`?space=<id>&name=` to post in a Space) |
| `/explore` · `/activity` | Search and explore · notifications |
| `/spaces` · `/s/:slug` · `/s/:slug/c/:channel` | Your Spaces · a Space · a channel |
| `/inbox` · `/inbox/:id` | Inbox · a conversation |
| `/work` · `/gigs/new` · `/gigs/:id` · `/gigs/:id/apply` · `/gigs/:id/applicants` · `/gigs/:id/rate` | Work |
| `/:handle` · `/me` | A profile, at `/<username>` (decision 0009; `/u/<username>` redirects there) · your own profile. Matched last |
| `/me/settings`, `/me/data`, `/me/proof`, `/me/records`, `/me/actions`, `/me/socials` | Settings and your data |
| `/me/invite` | Invite by email (staff) |
| `/report?kind=&id=` · `/transparency` · `/mod` | Report · transparency report · moderator queue |

## Rules the code keeps

- **Strict CSP.** No inline scripts, styles or handlers. The DOM is built with `h()` (createElement and textContent); `h()` refuses `style` and `on*` props. Styles go through classes; the few dynamic sizes are classes too. Tests check the served shell and every file under `app/web`.
- **No brand art in the repo** (TRADEMARKS.md). With `<body data-brand="1">` the app loads `/brand/sprite.svg` (wordmark `#wm`, illustrations) and the fonts through the FontFace API; otherwise it shows the plain text name "Community" and system fonts.
- **Live data only.** Lists show the time they were read ("as of 9:41"). Empty states say so ("No posts here yet"). The transparency page shows "No numbers yet" while `launched` is false. Nothing is invented.
- **Location stays on the phone.** Recent places are kept in localStorage only. Photos are re-encoded through a canvas (drops EXIF location), at most 1600 px, JPEG 0.85, before `POST /media`.
- **Messages are end-to-end encrypted** in the browser: [e2e-client.md](e2e-client.md).
- **The service worker never caches API responses**, media or the HTML page (each page has its own nonce). It goes to the network first and uses its cache only when offline.
- **Updates show on the next load.** The app's files (`/static/*`, `/sw.js`, the manifest) are sent with `Cache-Control: no-cache` and an ETag, so the browser checks on every load and an unchanged file costs an empty 304. Brand-pack files keep a one-day cache.
- **Accessibility.** 44 px tap targets, visible focus rings, labelled controls, the zoom and choice chips are ARIA radio groups with arrow keys, sheets are modal `<dialog>`s, toasts use `aria-live`, focus moves to the screen heading on navigation, and reduced motion is respected.

## Layout

The same screens at four widths, following X and Threads:

| Width | Layout |
|---|---|
| under 700 px (phone) | Five tabs at the bottom (Home, Spaces, Work, Inbox, Me). The ✎ compose button shows on feeds and profiles only. |
| 700-999 px (tablet) | An icon rail on the left (labels stay for screen readers and show as tooltips) and one column. Sheets open as centred dialogs. |
| 1000-1279 px | The icon rail, the column and the right rail. |
| 1280 px and up | The labelled navigation, the column and the right rail. |

The right rail starts with Search (Spaces), then what is happening in your city, Spaces near you and gigs for you, each with its read time.

Pages without the app chrome:
- **Welcome** (signed out, `/`): on a phone the name, the picture, then the words and buttons at the bottom, in thumb reach. From 700 px the page is yellow edge to edge and three cards open Places, Spaces and Work. From 960 px the words sit left and the picture right.
- **Log in and join**: the phone screens as they are; from 700 px a white card on cream with the name above it.

## Running and testing

`npm start` serves the app with the API. `npm test` runs `test/web.test.ts` with the rest: the pure helpers run in Node (WebCrypto is built in), and the shell is fetched from a real server.
