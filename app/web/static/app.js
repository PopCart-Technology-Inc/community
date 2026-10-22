// PopCart Community web app: boot, the app shell (phone tabs under 1000px, three columns above),
// and the History API router. Screens live in ./screens and return { node, title, tab, bare, cls, cleanup }.
import { h, icon } from './lib/dom.js';
import { get } from './lib/api.js';
import { compile, match, ROUTES } from './lib/router.js';
import { asOf, profilePath, timeAgo } from './lib/format.js';
import { brandName, loadBrand } from './lib/brand.js';
import { setNavigator, state } from './core.js';
import { ensureIdentity } from './lib/keystore.js';
import { avatar, btn, empty, errorBox, toast } from './ui.js';
import { join, login } from './screens/join.js';
import { activity, compose, explore, following, picks, places, postDetail, trade } from './screens/home.js';
import { channel, spacePage, spacesList } from './screens/spaces.js';
import { dm, inbox } from './screens/messages.js';
import { applicants, apply, gigCard, gigPage, newGig, rate, work } from './screens/work.js';
import { invite, meRedirect, oldProfile, profile, proof, settings, socials, staffKey } from './screens/me.js';
import { actions, data, mod, records, report, transparency } from './screens/safety.js';

const SCREENS = {
  home: following, places, placesAt: places, trade, picks, join, login, post: postDetail, compose, explore, activity,
  spaces: spacesList, space: spacePage, channel, inbox, dm, work, gigNew: newGig, gig: gigPage, apply, applicants, rate,
  profile, oldProfile, me: meRedirect, settings, invite, staffKey, data, proof, records, actions, socials, report, transparency, mod,
};
const GROUP = {
  home: 'home', places: 'places', placesAt: 'places', trade: 'home', picks: 'home', post: 'home', compose: 'home', explore: 'explore', activity: 'activity',
  spaces: 'spaces', space: 'spaces', channel: 'spaces', inbox: 'inbox', dm: 'inbox', work: 'work', gigNew: 'work', gig: 'work', apply: 'work', applicants: 'work', rate: 'work',
  me: 'me', settings: 'me', invite: 'me', staffKey: 'me', data: 'me', proof: 'me', records: 'me', actions: 'me', socials: 'me',
};
const TAB_OF = { places: 'home', explore: 'home', activity: 'home' };
const routes = compile(ROUTES);

let main, wnav, wside, tabbar, cleanup = null, depth = 0, current = null, renders = 0;
// The ✎ button belongs to the feeds and profiles, not to forms, settings or chats.
const FAB_ON = new Set(['home', 'places', 'placesAt', 'trade', 'picks', 'explore', 'profile']);
const badges = { inbox: 0, activity: 0 };

/* ---------- navigation ---------- */

function go(path, opts = {}) {
  if (opts.replace) history.replaceState({ n: depth }, '', path);
  else { depth++; history.pushState({ n: depth }, '', path); }
  render(true);
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(api|media|brand|static)\//.test(url.pathname)) return;
  if (a.getAttribute('href') === '#') return;
  e.preventDefault();
  if (url.pathname + url.search === location.pathname + location.search) { render(true); return; }
  go(url.pathname + url.search + url.hash);
}

/* ---------- rendering ---------- */

function render(moved) {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const m = match(routes, location.pathname);
  const ctx = { params: m ? m.params : {}, query: new URLSearchParams(location.search), path: location.pathname };
  const id = ++renders;
  let out;
  try {
    out = m ? SCREENS[m.name](ctx) : { node: h('div', null, h('header', { class: 'abar' }, h('h1', { class: 't', tabindex: '-1' }, 'Not found')), empty('This page doesn\'t exist', '', btn('Go home', { href: '/' }))), title: 'Not found' };
  } catch (e) {
    console.error(e);
    out = { node: errorBox(e), title: 'Error' };
  }
  // A screen that redirects (e.g. /me -> /<username>) has already rendered the new page: keep it.
  if (id !== renders) return;
  if (out instanceof Node) out = { node: out };
  current = { name: m ? m.name : null, group: (m && GROUP[m.name]) || null, tab: out.tab };
  cleanup = out.cleanup || null;
  document.body.className = [out.bare && 'bare', out.cls, !(m && FAB_ON.has(m.name)) && 'nofab'].filter(Boolean).join(' ');
  main.replaceChildren(out.node);
  document.title = (out.title ? out.title + ' · ' : '') + 'PopCart Community';
  markCurrent();
  if (moved) {
    window.scrollTo(0, 0);
    const target = main.querySelector('h1') || main;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
}

function markCurrent() {
  const g = current && current.group;
  const mineProfile = current && current.name === 'profile' && state.me && location.pathname === profilePath(state.me.handle);
  const group = mineProfile ? 'me' : g;
  wnav.querySelectorAll('a.nv').forEach((a) => { if (a.dataset.g === group) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const tab = (current && current.tab) || TAB_OF[group] || group;
  tabbar.querySelectorAll('a').forEach((a) => { if (a.dataset.g === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}

/* ---------- chrome ---------- */

function buildNav() {
  const me = state.me;
  const items = [['home', 'Home', '/', 'home'], ['places', 'Places', '/places', 'globe'], ['explore', 'Explore', '/explore', 'search'], ['spaces', 'Spaces', '/spaces', 'hash'],
    ['work', 'Work', '/work', 'work'], ['inbox', 'Inbox', '/inbox', 'inbox'], ['activity', 'Activity', '/activity', 'bell'], ['me', 'Profile', '/me', 'user']];
  // replaceChildren takes nodes, not arrays: spread the menu and drop the empty slots.
  wnav.replaceChildren(...[
    h('a', { class: 'brandlink', href: '/', aria: { label: 'Community home' } }, brandName('m')),
    // Labels sit in .nl so the tablet rail can show icons only (the label stays for screen readers).
    ...items.filter(([k]) => me || ['home', 'places', 'explore', 'spaces'].includes(k)).map(([k, label, href, ic]) => h('a', { class: 'nv', href, data: { g: k }, title: label }, icon(ic, 'lg'), h('span', { class: 'nl' }, label),
      (k === 'inbox' && badges.inbox) || (k === 'activity' && badges.activity) ? h('span', { class: 'badge' }, String(k === 'inbox' ? badges.inbox : badges.activity)) : null)),
    me ? btn(h('span', { class: 'nl' }, 'Post'), { href: '/compose', cls: 'postbtn', icon: 'pen', aria: { label: 'New post' } }) : btn(h('span', { class: 'nl' }, 'Log in'), { href: '/login', cls: 'postbtn', icon: 'finger', aria: { label: 'Log in' } }),
    me ? h('a', { class: 'who', href: profilePath(me.handle), title: '@' + me.handle }, avatar(me), h('div', { class: 'nl' }, h('div', { class: 'nm' }, me.first_name), h('div', { class: 'mute' }, '@' + me.handle))) : null,
  ].filter(Boolean));
  const tabs = [['home', 'Home', '/', 'home'], ['spaces', 'Spaces', '/spaces', 'hash'], ['work', 'Work', '/work', 'work'], ['inbox', 'Inbox', '/inbox', 'inbox'], ['me', 'Me', me ? '/me' : '/login', 'user']];
  tabbar.replaceChildren(...tabs.map(([k, label, href, ic]) => h('a', { href, data: { g: k }, aria: { label: label + (k === 'inbox' && badges.inbox ? ', ' + badges.inbox + ' unread' : '') } },
    h('b', null, icon(ic)), label, k === 'inbox' && badges.inbox ? h('span', { class: 'dot', aria: { hidden: 'true' } }, String(badges.inbox)) : null)));
  const fab = document.querySelector('.fab');
  if (fab) fab.hidden = !me;
  if (current) markCurrent();
}

/** The right rail on wide screens: Happening in your city, Spaces and Gigs near you. Live, with times. */
let railAt = 0;
function buildRail(force) {
  if (!window.matchMedia('(min-width: 1000px)').matches) return;
  if (!force && Date.now() - railAt < 120000) return;
  railAt = Date.now();
  const me = state.me;
  const foot = h('div', { class: 'wfoot' }, h('a', { href: '/transparency' }, 'Transparency'), h('a', { href: '/places' }, 'Places'), h('br'), 'Your data is never sold. Any ad is labelled. Open source.');
  // Search first, as on X: it searches Spaces (Explore).
  const q = h('input', { type: 'search', placeholder: 'Search Spaces', aria: { label: 'Search Spaces' } });
  const search = h('form', { class: 'search wsearch', role: 'search', on: { submit: (e) => { e.preventDefault(); const v = q.value.trim(); go(v ? '/explore?q=' + encodeURIComponent(v) : '/explore'); } } }, icon('search', 'sm'), q);
  if (!me) { wside.replaceChildren(search, h('div', { class: 'wcard' }, h('h2', null, 'Join by invite'), h('p', null, 'Community is invite-only while the privacy review is done. Invites go to an email address: join with the one yours went to.'), h('div', { class: 'row wrap' }, btn('Join', { sm: true, kind: 'y', icon: 'mail', href: '/join' }), btn('Log in', { sm: true, kind: 'w', href: '/login' }))), foot); return; }
  const happening = h('section', { class: 'wcard', aria: { label: 'Happening in your city' } }, h('h2', null, 'Happening near you'), h('p', { class: 'foot' }, 'Loading…'));
  const spaces = h('section', { class: 'wcard', aria: { label: 'Spaces near you' } }, h('h2', null, 'Spaces near you'));
  const gigs = h('section', { class: 'wcard', aria: { label: 'Gigs for you' } }, h('h2', null, 'Gigs for you'));
  wside.replaceChildren(search, happening, spaces, gigs, foot);
  (me.home_area ? get('/feeds/places', { level: 'city', limit: 5 }) : Promise.reject(new Error('no home area'))).then((r) => {
    const ps = (r.posts || []).slice(0, 3);
    happening.replaceChildren(h('h2', null, 'Happening in ' + ((r.area && r.area.name) || 'your city')),
      ps.length ? h('div', null, ps.map((p) => h('a', { class: 'li', href: '/p/' + p.id }, h('div', { class: 'grow' }, h('div', { class: 't1' }, (p.body || 'Photo').split('\n')[0].slice(0, 48)),
        h('div', { class: 't2' }, (p.salamats || 0) + ' salamats · ' + timeAgo(p.created_at)))))) : h('p', { class: 'mute' }, 'No posts here yet.'),
      h('p', { class: 'foot' }, 'Ranked by the published City rule · ' + asOf(r.as_of)));
  }, () => happening.replaceChildren(h('h2', null, 'Happening near you'), h('p', { class: 'mute' }, 'Set your home area in Settings to see your city.')));
  if (me.home_area) {
    get('/spaces', { near: me.home_area }).then((r) => {
      const ss = (r.spaces || []).slice(0, 3);
      spaces.append(...(ss.length ? ss.map((s) => h('a', { class: 'li', href: '/s/' + encodeURIComponent(s.slug) }, h('span', { class: 'av s sq' }, (s.name || '?').charAt(0)), h('div', { class: 'grow' }, h('div', { class: 't1' }, s.name), h('div', { class: 't2' }, (s.members ?? 0) + ' members'))))
        : [h('p', { class: 'mute' }, 'No Spaces near you yet.')]));
    }, () => spaces.append(h('p', { class: 'mute' }, 'Could not load Spaces.')));
  } else spaces.append(h('p', { class: 'mute' }, 'Set your home area in Settings.'));
  get('/gigs', { tab: 'for_you', limit: 3 }).then((r) => {
    const gs = (r.gigs || []).slice(0, 3);
    gigs.append(...(gs.length ? gs.map((g) => { const c = gigCard(g); c.classList.add('li'); return c; }) : [h('p', { class: 'mute' }, 'No gigs here yet.')]), r.as_of ? h('p', { class: 'foot' }, asOf(r.as_of)) : '');
  }, () => gigs.append(h('p', { class: 'mute' }, 'Could not load gigs.')));
}

/** Unread counts for the Inbox tab and Activity, refreshed every minute while signed in. */
async function refreshBadges() {
  if (!state.me) return;
  try {
    const [c, n] = await Promise.all([get('/conversations').catch(() => null), get('/notifications', { limit: 1 }).catch(() => null)]);
    const inboxN = c ? (c.conversations || []).reduce((s, x) => s + (Number(x.unread) || 0), 0) : 0;
    const actN = n ? Number(n.unread) || 0 : 0;
    if (inboxN !== badges.inbox || actN !== badges.activity) { badges.inbox = inboxN; badges.activity = actN; buildNav(); }
  } catch { /* badges are optional */ }
}

/* ---------- boot ---------- */

async function boot() {
  main = h('main', { id: 'main', tabindex: '-1' });
  wnav = h('nav', { class: 'wnav', aria: { label: 'Main' } });
  wside = h('aside', { class: 'wside', aria: { label: 'Near you' } });
  tabbar = h('nav', { class: 'tabbar', aria: { label: 'Main' } });
  const app = document.getElementById('app');
  app.replaceChildren(
    h('a', { class: 'skip', href: '#main', on: { click: (e) => { e.preventDefault(); main.focus(); } } }, 'Skip to content'),
    h('div', { class: 'shell' }, wnav, main, wside),
    tabbar,
    h('a', { class: 'fab', href: '/compose', aria: { label: 'New post' }, hidden: true }, icon('pen', 'lg b')),
    h('div', { id: 'toast', role: 'status', aria: { live: 'polite' } }));
  main.replaceChildren(h('div', { class: 'loading', role: 'status' }, 'Loading…'));
  setNavigator(go);
  document.addEventListener('click', onClick);
  window.addEventListener('popstate', (e) => { depth = (e.state && e.state.n) || 0; render(true); });
  window.addEventListener('cm:auth', () => { buildNav(); buildRail(true); refreshBadges(); });
  window.addEventListener('cm:badges', refreshBadges);
  window.addEventListener('online', () => toast('Back online'));
  window.addEventListener('offline', () => toast('You\'re offline. Showing what\'s on screen.', true));
  if (!history.state) history.replaceState({ n: 0 }, '', location.href);

  const brand = loadBrand();
  try { state.me = (await get('/me')).user || null; } catch { state.me = null; }
  // Make and publish this browser's messaging key as soon as someone is signed in, so others can
  // message them before they ever open a conversation (decision 0001, point 4).
  const keys = () => { if (state.me) ensureIdentity(state.me).catch(() => { /* retried on the next visit */ }); };
  keys();
  window.addEventListener('cm:auth', keys);
  await brand;
  buildNav();
  render(false);
  buildRail(true);
  window.matchMedia('(min-width: 1000px)').addEventListener('change', () => buildRail(true));
  refreshBadges();
  setInterval(() => { if (document.visibilityState === 'visible') { refreshBadges(); buildRail(false); } }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* works without it */ });
}

boot();
