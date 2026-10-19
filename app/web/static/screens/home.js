// Home: Following (newest first, never re-ordered), Places (decision 0005), My trade, Picks,
// a post with its replies, the composer, search and explore, and activity.
import { h, icon } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { asOf, fullTime, timeAgo, tradeLabel } from '../lib/format.js';
import { DEFAULT_LEVEL, LEVELS, codeAtLevel, isLevel, levelIndex, zoomOf } from '../lib/places.js';
import { uploadPhoto } from '../lib/media.js';
import { brandName } from '../lib/brand.js';
import { local, nav, state } from '../core.js';
import {
  appBar, asOfLine, avatar, backBtn, btn, choiceChips, empty, errorBox, fail, formulaBox, iconLink, later, linkTabs,
  loading, pagedList, postView, sheet, toast, zoomControl,
} from '../ui.js';
import { placeSearch, welcome } from './join.js';

/* ---------- shared top of Home ---------- */

function homeBar() {
  const me = state.me;
  return h('header', { class: 'abar homebar' },
    me ? h('a', { class: 'ib', href: '/u/' + encodeURIComponent(me.handle), aria: { label: 'Your profile' } }, avatar(me, 's')) : h('a', { class: 'btn sm w', href: '/login' }, 'Log in'),
    h('div', { class: 'mid' }, h('a', { href: '/', aria: { label: 'Community home' } }, brandName('m'))),
    iconLink('search', 'Search and explore', '/explore'),
    me ? iconLink('bell', 'Activity', '/activity') : null);
}

function feedTabs(on) {
  return linkTabs([
    ['Following', '/', on === 'following'],
    ['Places', '/places', on === 'places', 'globe'],
    ['My trade', '/trade', on === 'trade'],
    ['Picks', '/picks', on === 'picks'],
  ], 'even');
}

const h1 = (text) => h('h1', { class: 'sr', tabindex: '-1' }, text);

/* ---------- Following ---------- */

export function following() {
  if (!state.me) return welcome();
  const row = later(async () => {
    const r = await get('/spaces', { mine: 1 });
    const sp = r.spaces || [];
    if (!sp.length) return null;
    return h('nav', { class: 'srow', aria: { label: 'Your Spaces' } }, sp.map((s) => h('a', { href: '/s/' + encodeURIComponent(s.slug), aria: { label: s.name + (s.unread ? ', ' + s.unread + ' unread' : '') } },
      h('span', { class: 'ring' + (s.unread ? ' unread' : '') }, h('span', { class: 'av sq' }, (s.name || '?').charAt(0))), h('span', { aria: { hidden: 'true' } }, s.name))));
  });
  row.querySelector('.loading')?.remove();
  const list = pagedList({
    fetchPage: async (before) => { const r = await get('/feeds/following', { before }); return { items: r.posts, end: r.end, as_of: r.as_of }; },
    render: (p) => postView(p),
    emptyNode: empty('No posts here yet', 'Follow people and join Spaces, and their posts show up here, newest first.', btn('See Places', { href: '/places', kind: 'w' })),
    endNode: h('div', { class: 'end' }, h('b', null, 'You\'re all caught up'), 'Following ends here. See what\'s happening in ', h('a', { class: 'linkish', href: '/places' }, 'Places'), '.'),
  });
  return { node: h('div', null, homeBar(), h('div', { class: 'stickyhd' }, feedTabs('following')), h1('Following'), row, list), title: 'Following', tab: 'home' };
}

/* ---------- Places ---------- */

const chains = new Map();
async function chainOf(code) {
  if (!code || code === 'WORLD') return [];
  if (!chains.has(code)) {
    const r = await get('/places/' + encodeURIComponent(code));
    chains.set(code, [r.area, ...(r.chain || [])].filter(Boolean));
  }
  return chains.get(code);
}

const RECENT = 'places.recent';
function remember(a) {
  const list = (local.get(RECENT, []) || []).filter((x) => x && x.code !== a.code);
  list.unshift({ code: a.code, name: a.name, level: a.level, parent_name: a.parent_name || '' });
  local.set(RECENT, list.slice(0, 5));
}
const placePath = (a) => '/places/' + zoomOf(a.level) + '/' + encodeURIComponent(a.code);

/** Choose a place: search, home, recent (kept on this device only). `inside` lists an area's children. */
function placeSheet({ inside, level } = {}) {
  sheet('Choose a place', (close) => {
    const pick = (a) => { remember(a); close(); nav(level && inside ? '/places/' + level + '/' + encodeURIComponent(a.code) : placePath(a)); };
    const out = [h('h2', null, inside ? 'Pick a ' + (LEVELS[levelIndex(level)] || {}).label?.toLowerCase() + ' in ' + inside.name : 'Choose a place')];
    if (inside) {
      out.push(later(async () => {
        const r = await get('/places/' + encodeURIComponent(inside.code) + '/children');
        if (!(r.areas || []).length) return h('p', { class: 'mute' }, 'No smaller areas listed for ' + inside.name + ' yet.');
        return h('div', null, r.areas.map((a) => h('button', { type: 'button', class: 'li', on: { click: () => pick(a) } }, h('span', { class: 'ico-c' }, icon('pin', 'sm b')), h('div', { class: 'grow' }, h('div', { class: 't1' }, a.name)))));
      }));
    }
    out.push(placeSearch('', (a) => { if (a) pick(a); }, 'Search: barangay, city, province or country'));
    const home = state.me && state.me.home_area;
    if (home) {
      out.push(h('h3', { class: 'sect' }, 'Home'), later(async () => {
        const c = await chainOf(home);
        const a = c[0];
        return a ? h('button', { type: 'button', class: 'li', on: { click: () => pick(a) } }, h('span', { class: 'ico-c' }, icon('home', 'sm')),
          h('div', { class: 'grow' }, h('div', { class: 't1' }, a.name), h('div', { class: 't2' }, (c[1] && c[1].name) || '')), h('span', { class: 'tag y' }, 'Home')) : null;
      }));
    }
    const recent = local.get(RECENT, []) || [];
    if (recent.length) {
      out.push(h('h3', { class: 'sect' }, 'Recent'), ...recent.map((a) => h('button', { type: 'button', class: 'li', on: { click: () => pick(a) } },
        h('span', { class: 'ico-c' }, icon('clock', 'sm')), h('div', { class: 'grow' }, h('div', { class: 't1' }, a.name), h('div', { class: 't2' }, a.parent_name || '')))));
    }
    out.push(h('p', { class: 'hint' }, icon('lock', 'sm'), 'Recent places are kept on this device only. Your exact location never leaves your phone.'));
    return out;
  });
}

function levelSheet(level, meta) {
  sheet('How this level is ordered', (close) => [
    h('h2', null, (LEVELS[levelIndex(level)] || {}).label + ': how it\'s ordered'),
    level === 'barangay' ? h('p', null, 'Newest first. A barangay is small enough to see everything.') : formulaBox(meta.weights, meta.rule),
    level === 'country' ? h('p', { class: 'mute' }, 'Mix rule: no single city gets more than 1 in 4 posts.') : null,
    level === 'world' ? h('p', { class: 'mute' }, 'Mix rule: no single country gets more than 1 in 4 posts.') : null,
    btn('Got it', { block: true, on: close }),
  ]);
}

export function places({ params, query }) {
  const code = params.code || null;
  let level = isLevel(params.level) ? params.level : (isLevel(query.get('level')) ? query.get('level') : DEFAULT_LEVEL);
  // Signed out, or no home area yet: nothing to zoom from, so start at World (never an error page).
  if (!code && !(state.me && state.me.home_area) && level !== 'world') level = 'world';
  const meta = { area: null, rule: '', weights: null };
  const placeName = h('b', null, code ? '…' : (state.me && state.me.home_area ? 'Your area' : 'Everywhere'));
  const upName = h('span', { class: 'mute' });
  const asof = h('span', { class: 'mute cnt' });
  const rule = h('span', null, level === 'barangay' ? 'Newest first: small enough to see everything.' : '');
  const how = h('button', { type: 'button', on: { click: () => levelSheet(level, meta) } }, 'How?');
  const quiet = h('div');

  const pickLevel = async (l) => {
    local.set('places.level', l);
    if (l === 'world') { nav('/places/world/WORLD'); return; }
    const focus = code || (state.me && state.me.home_area);
    if (!focus) { nav('/places?level=' + l); return; }
    try {
      const chain = await chainOf(focus);
      const c = codeAtLevel(chain, l);
      if (c) nav('/places/' + l + '/' + encodeURIComponent(c));
      else if (chain[0]) placeSheet({ inside: chain[0], level: l });
      else nav('/places?level=' + l);
    } catch (e) { fail(e); }
  };

  const coachSeen = local.get('coach.zoom', false);
  const coach = !coachSeen ? h('div', { class: 'coach', role: 'note' }, h('b', null, 'Zoom the feed'), 'Slide from your barangay out to the whole world.',
    h('button', { type: 'button', on: { click: (e) => { local.set('coach.zoom', true); e.currentTarget.parentElement.remove(); } } }, 'Got it')) : null;

  const head = h('div', { class: 'scope' },
    h('div', { class: 'placehd' },
      h('button', { type: 'button', class: 'placebtn', aria: { label: 'Choose a place' }, on: { click: () => placeSheet() } }, icon('pin', 'sm b'), placeName, upName, icon('chev', 'sm')),
      asof),
    zoomControl(level, pickLevel),
    h('div', { class: 'rank' }, icon('sliders', 'sm'), rule, level === 'barangay' ? null : how),
    coach, quiet);

  const list = pagedList({
    showAsOf: false,
    fetchPage: async (before) => {
      const r = await get('/feeds/places', { level, code: code || undefined, before });
      if (!before) {
        Object.assign(meta, { area: r.area, rule: r.rule, weights: r.weights });
        if (r.area) { placeName.textContent = r.area.name; document.title = r.area.name + ' · Places · Community'; }
        if (r.area && r.area.code && r.area.code !== 'WORLD') chainOf(r.area.code).then((c) => { const up = c.find((a) => levelIndex(zoomOf(a.level)) > levelIndex(level)); upName.textContent = up ? '· ' + up.name : ''; }).catch(() => {});
        if (r.rule && level !== 'barangay') rule.textContent = r.rule;
        if (r.as_of) asof.textContent = asOf(r.as_of);
        if (r.quiet && r.quiet.next_code) {
          quiet.replaceChildren(h('div', { class: 'note' }, icon('info'), h('div', null,
            h('b', null, 'Quiet in ' + ((r.area && r.area.name) || 'this place') + ' today'),
            h('p', null, 'Fewer than 5 posts in the last 24 hours.'),
            btn('See all of ' + (r.quiet.next_name || 'the next level') + ' →', { sm: true, kind: 'w', href: '/places/' + r.quiet.next_level + '/' + encodeURIComponent(r.quiet.next_code) }))));
        }
      }
      return { items: r.posts, end: (r.posts || []).length === 0 || r.end === true, as_of: r.as_of };
    },
    render: (p) => postView(p, { level, code: code || (meta.area && meta.area.code), showPlace: true }),
    emptyNode: empty('No posts here yet', 'Nobody has posted in this place at this level. Try zooming out.'),
  });

  return { node: h('div', null, homeBar(), h('div', { class: 'stickyhd' }, feedTabs('places'), head), h1('Places'), list), title: 'Places', tab: 'home' };
}

/* ---------- My trade, Picks ---------- */

export function trade() {
  if (!state.me) return { node: h('div', null, homeBar(), feedTabs('trade'), errorBox({ status: 401 })), title: 'My trade', tab: 'home' };
  const t = state.me.trade;
  const ruleLine = h('div', { class: 'rank' }, icon('sliders', 'sm'), h('span', null, 'Ranked for ' + tradeLabel(t) + ': nearness, thanks from different people, recency.'));
  let meta = {};
  const list = pagedList({
    fetchPage: async (before) => {
      const r = await get('/feeds/trade', { trade: t, before });
      if (!before) {
        meta = r;
        if (r.rule) ruleLine.children[1].textContent = r.rule;
        ruleLine.append(h('button', { type: 'button', on: { click: () => sheet('How My trade is ordered', (close) => [h('h2', null, 'My trade: how it\'s ordered'), formulaBox(meta.weights, meta.rule), btn('Got it', { block: true, on: close })]) } }, 'How?'));
      }
      return { items: r.posts, end: r.end !== undefined ? r.end : true, as_of: r.as_of };
    },
    render: (p) => postView(p, { showPlace: true }),
    emptyNode: empty('No posts here yet', 'Nobody in your trade has posted yet.'),
  });
  return { node: h('div', null, homeBar(), h('div', { class: 'stickyhd' }, feedTabs('trade')), h1('My trade'), ruleLine, list), title: 'My trade', tab: 'home' };
}

export function picks() {
  const sub = h('div', { class: 'rank' }, icon('star', 'sm'), h('span', null, 'Monday Picks: last week\'s posts thanked by the most different people.'));
  const list = pagedList({
    fetchPage: async () => {
      const r = await get('/feeds/picks');
      if (r.week) sub.children[1].textContent = 'Monday Picks · week of ' + r.week + ': thanked by the most different people.';
      return { items: r.posts, end: true, as_of: r.as_of };
    },
    render: (p) => postView(p),
    emptyNode: empty('No Picks yet', 'Picks are chosen every Monday from last week\'s salamats. There were none to count.'),
  });
  return { node: h('div', null, homeBar(), h('div', { class: 'stickyhd' }, feedTabs('picks')), h1('Picks'), sub, list), title: 'Picks', tab: 'home' };
}

/* ---------- a post and its replies ---------- */

export function postDetail({ params }) {
  const box = later(async () => {
    const r = await get('/posts/' + encodeURIComponent(params.id));
    const p = r.post;
    const replies = h('div', { role: 'feed', aria: { label: 'Replies' } }, (r.replies || []).map((x) => postView(x)));
    const main = postView(p, { onRemoved: () => nav('/', { replace: true }) });
    main.classList.add('big');
    const info = h('p', { class: 'asof' }, fullTime(p.created_at), p.place ? ' · ' + p.place.name : '');
    return [main, info, h('h2', { class: 'sect' }, (r.replies || []).length ? 'Replies' : 'No replies yet'), replies, state.me ? replyBox(p, replies) : h('div', { class: 'note' }, h('div', null, h('b', null, 'Log in to reply'), h('div', null, btn('Log in', { sm: true, href: '/login?next=/p/' + p.id }))))];
  });
  return { node: h('div', null, appBar({ title: 'Post', back: '/' }), box), title: 'Post', cls: 'thread-page nofab' };
}

function replyBox(p, replies) {
  const ta = h('textarea', { rows: '1', maxlength: '2000', placeholder: 'Reply to ' + ((p.author && p.author.first_name) || '') + '…', aria: { label: 'Write a reply' } });
  const send = h('button', { class: 'ib', type: 'submit', aria: { label: 'Send reply' } }, icon('send', 'b'));
  const f = h('form', { class: 'composer' }, avatar(state.me, 'xs'), ta, send);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      const r = await post('/posts', { body, reply_to: p.id });
      replies.append(postView(r.post));
      ta.value = '';
      toast('Reply posted');
    } catch (err) { fail(err); } finally { send.disabled = false; }
  });
  return f;
}

/* ---------- compose ---------- */

export function compose({ query }) {
  if (!state.me) return { node: h('div', null, appBar({ title: 'New post', back: '/' }), errorBox({ status: 401 })), title: 'New post' };
  const spaceId = query.get('space');
  const spaceName = query.get('name');
  const d = { reach: 'city', area_code: state.me.home_area || null, media: [] };
  const ta = h('textarea', { class: 'bare-area', maxlength: '2000', placeholder: 'What did you work on today?', aria: { label: 'Post text' } });
  const postBtn = btn('Post', { sm: true, disabled: true });
  const thumbs = h('div', { class: 'thumbs' });
  const status = h('p', { class: 'hint', aria: { live: 'polite' } });
  const ready = () => { postBtn.disabled = !(ta.value.trim() || d.media.length) || d.busy; };
  ta.addEventListener('input', ready);

  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'sr', id: 'photo-in' });
  file.addEventListener('change', async () => {
    const files = [...file.files].slice(0, 4 - d.media.length);
    file.value = '';
    for (const f of files) {
      d.busy = true; ready(); status.textContent = 'Removing location data and shrinking your photo…';
      try {
        const m = await uploadPhoto(f);
        d.media.push(m.id);
        const fig = h('figure', null, h('img', { src: '/media/' + m.id, alt: 'Photo to post' }),
          h('button', { type: 'button', aria: { label: 'Remove photo' }, on: { click: () => { d.media = d.media.filter((x) => x !== m.id); fig.remove(); ready(); } } }, icon('x', 'sm b')));
        thumbs.append(fig);
        status.textContent = 'Photo ready. Location data removed.';
      } catch (e) { fail(e); status.textContent = ''; }
      d.busy = false; ready();
    }
  });

  const placeLabel = h('b', null, d.area_code ? '…' : 'No place set');
  if (d.area_code) chainOf(d.area_code).then((c) => { placeLabel.textContent = c[0] ? c[0].name : d.area_code; }).catch(() => { placeLabel.textContent = d.area_code; });
  const changePlace = btn('Change', { sm: true, kind: 'w', on: () => sheet('Where this post is from', (close) => [
    h('h2', null, 'Where this post is from'),
    placeSearch('', (a) => { if (a) { d.area_code = a.code; placeLabel.textContent = a.name; close(); } }, 'Search a place'),
    h('p', { class: 'hint' }, 'Shows the area name, never your exact spot.'),
  ]) });

  postBtn.addEventListener('click', async () => {
    postBtn.disabled = true;
    try {
      const body = { body: ta.value.trim(), media_ids: d.media.length ? d.media : undefined };
      if (spaceId) body.space_id = spaceId;
      else { body.reach = d.reach; if (d.area_code) body.area_code = d.area_code; }
      const r = await post('/posts', body);
      toast('Posted');
      nav('/p/' + r.post.id, { replace: true });
    } catch (e) { fail(e); ready(); }
  });

  const node = h('div', null,
    h('header', { class: 'abar' }, h('a', { class: 'btn sm w', href: spaceId ? '/spaces' : '/' }, 'Cancel'), h('h1', { class: 't', tabindex: '-1' }, 'New post'), postBtn),
    h('div', { class: 'composebox' }, avatar(state.me),
      h('div', null, spaceName ? h('p', { class: 'tag' }, icon('hash', 'sm'), 'In ' + spaceName) : null, ta, thumbs)),
    spaceId ? null : h('div', { class: 'section' }, h('p', null, 'Who can find it in Places'),
      choiceChips(LEVELS.map((l) => [l.k, l.label]), d.reach, (v) => { d.reach = v; }, 'Who can find it in Places'),
      h('p', { class: 'hint' }, 'Your followers always see it. Places shows the area name, never your exact spot.')),
    spaceId ? null : h('div', { class: 'section row' }, icon('pin', 'sm'), h('span', { class: 'grow' }, 'From ', placeLabel), changePlace),
    h('div', { class: 'section row' },
      h('label', { class: 'btn sm w', for: 'photo-in' }, icon('image', 'sm'), 'Add photos'), file,
      h('span', { class: 'mute grow' }, 'Location data is removed from photos before upload.')),
    h('div', { class: 'pad' }, status));
  return { node, title: 'New post', cls: 'nofab' };
}

/* ---------- search and explore ---------- */

export function explore({ query }) {
  const q = query.get('q') || '';
  const t = query.get('trade') || '';
  const input = h('input', { type: 'search', value: q, placeholder: 'Search Spaces', aria: { label: 'Search Spaces' } });
  const form = h('form', { class: 'search', role: 'search' }, icon('search', 'sm'), input);
  form.addEventListener('submit', (e) => { e.preventDefault(); nav('/explore?q=' + encodeURIComponent(input.value.trim())); });
  const chips = h('nav', { class: 'chips', aria: { label: 'Trades' } }, [['', 'Picks']].concat(TRADE_CHIPS).map(([k, lab]) =>
    h('a', { class: 'chip', href: k ? '/explore?trade=' + k : '/explore', aria: { current: (k === t && !q) ? 'page' : undefined } }, lab)));
  chips.querySelectorAll('[aria-current]').forEach((c) => c.classList.add('on'));
  let body;
  if (q) {
    body = later(async () => {
      const r = await get('/spaces', { q });
      return [h('h2', { class: 'sect' }, 'Spaces matching “' + q + '”'), (r.spaces || []).length ? r.spaces.map(spaceLine) : empty('No Spaces found', 'Try another word.')];
    });
  } else if (t) {
    body = pagedList({
      fetchPage: async () => { const r = await get('/feeds/trade', { trade: t }); return { items: r.posts, end: true, as_of: r.as_of }; },
      render: (p) => postView(p, { showPlace: true }), emptyNode: empty('No posts here yet', 'Nobody in this trade has posted yet.'),
    });
  } else {
    body = later(async () => {
      const r = await get('/feeds/picks');
      const ps = r.posts || [];
      return [h('h2', { class: 'sect' }, 'Monday Picks · chosen by salamats from different people'), asOfLine(r.as_of),
        ps.length ? h('div', { class: 'grid3' }, ps.map(pickTile)) : empty('No Picks yet', 'Picks are chosen every Monday from last week\'s salamats.')];
    });
  }
  return { node: h('div', null, h('header', { class: 'abar' }, backBtn('/'), h('h1', { class: 'sr', tabindex: '-1' }, 'Search and explore'), h('div', { class: 'grow' }, form)), chips, body), title: 'Explore', tab: 'home' };
}

const TRADE_CHIPS = [['rider', 'Riders'], ['fresh', 'Fresh'], ['grill', 'Grill'], ['grocery', 'Grocery'], ['creator', 'Creators'], ['tutor', 'Tutors'], ['coder', 'Coders']];

function pickTile(p) {
  const a = p.author || {};
  const img = p.media_ids && p.media_ids[0];
  return h('a', { href: '/p/' + p.id, aria: { label: 'Post by ' + (a.first_name || a.handle) } },
    img ? h('img', { src: '/media/' + img, alt: '', loading: 'lazy' }) : h('span', { class: 'txt' }, (p.body || '').slice(0, 140)),
    h('span', { class: 'lab' }, '@' + (a.handle || '')));
}

export function spaceLine(s) {
  return h('a', { class: 'li', href: '/s/' + encodeURIComponent(s.slug) }, h('span', { class: 'av sq' }, (s.name || '?').charAt(0)),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, s.name, s.visibility === 'private' ? h('span', { class: 'mute', aria: { label: 'private' } }, icon('lock', 'sm')) : null),
      h('div', { class: 't2' + (s.unread ? ' unread' : '') }, s.last_message ? lastLine(s.last_message) : ((s.members ?? 0) + ' members · ' + (s.visibility || 'public')))),
    h('div', { class: 'side' }, s.last_message && s.last_message.created_at ? timeAgo(s.last_message.created_at) : '', s.unread ? h('span', { class: 'badge' }, String(s.unread)) : null));
}

const lastLine = (m) => (m.body ? ((m.author && m.author.first_name) ? m.author.first_name + ': ' : '') + m.body : 'Encrypted message');

/* ---------- activity ---------- */

const KIND = {
  salamat: ['heart', 'said salamat for your post'], reply: ['reply', 'replied to your post'], follow: ['user', 'followed you'],
  mention: ['reply', 'mentioned you'], space_post: ['hash', 'posted in a Space'], gig_application: ['work', 'applied to your gig'],
  application_picked: ['work', 'picked you for a gig'], gig_done: ['work', 'marked a gig done'], rating: ['star', 'rated your work'],
  mod_action: ['shield', 'A moderator acted on your content'], message_request: ['msg', 'sent you a message request'],
};

function notifLink(n) {
  if (n.post_id) return '/p/' + n.post_id;
  if (n.gig_id) return '/gigs/' + n.gig_id;
  if (n.conversation_id) return '/inbox/' + n.conversation_id;
  if (n.space_slug) return '/s/' + encodeURIComponent(n.space_slug);
  if (n.kind === 'mod_action') return '/me/actions';
  const who = n.actor || n.person;
  return who && who.handle ? '/u/' + encodeURIComponent(who.handle) : null;
}

export function activity() {
  if (!state.me) return { node: h('div', null, appBar({ title: 'Activity', back: '/' }), errorBox({ status: 401 })), title: 'Activity' };
  let tab = 'all';
  const box = h('div');
  let data = null;
  const render = () => {
    const items = (data.items || []).filter((n) => tab === 'all' || /gig|application|rating/.test(n.kind || ''));
    box.replaceChildren(asOfLine(data.as_of, 'Live · '), items.length ? h('div', null, items.map((n) => {
      const [ic, verb] = KIND[n.kind] || ['bell', ''];
      const who = n.actor || n.person;
      const text = n.text || n.message || verb || n.kind;
      const href = notifLink(n);
      const kids = [who ? avatar(who, 's') : h('span', { class: 'ico-c' }, icon(ic, 'sm')),
        h('div', { class: 'grow' }, h('div', { class: n.read_at || n.read ? '' : 't1' }, who ? h('b', null, who.first_name || who.handle) : null, who ? ' ' : '', text),
          h('div', { class: 't2' }, timeAgo(n.created_at))), h('span', { class: 'mute' }, icon(ic, 'sm'))];
      return href ? h('a', { class: 'li top line', href }, kids) : h('div', { class: 'li top line' }, kids);
    })) : empty('Nothing new', tab === 'all' ? 'Salamats, replies, follows and gig news show up here.' : 'No gig news yet.'));
  };
  const tabs = h('div', { class: 'ftabs', role: 'tablist', aria: { label: 'Activity' } });
  for (const [k, lab] of [['all', 'All'], ['work', 'Work']]) {
    const b = h('button', { type: 'button', role: 'tab', aria: { selected: String(k === tab) } }, lab);
    b.addEventListener('click', () => { tab = k; tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); if (data) render(); });
    tabs.append(b);
  }
  box.append(loading());
  get('/notifications').then((r) => {
    data = r; render();
    if (r.unread) post('/notifications/read').then(() => window.dispatchEvent(new Event('cm:badges'))).catch(() => {});
  }, (e) => box.replaceChildren(errorBox(e)));
  return { node: h('div', null, appBar({ title: 'Activity', back: '/' }), tabs, box), title: 'Activity', tab: 'home' };
}
