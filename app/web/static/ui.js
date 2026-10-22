// Shared pieces of the interface: app bar, avatar, post, sheets, toasts, the Places zoom, lists.
import { h, icon } from './lib/dom.js';
import { del, get, post as apiPost } from './lib/api.js';
import { asOf, count, fullTime, profilePath, timeAgo, tradeLabel } from './lib/format.js';
import { LEVELS, levelIndex } from './lib/places.js';
import { can, isMe, nav, state } from './core.js';

/* ---------- small pieces ---------- */

export function toast(message, bad = false) {
  const root = document.getElementById('toast');
  if (!root) return;
  const el = h('div', { class: bad ? 'bad' : '' }, message);
  root.append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3500);
}

/** Show an error from the API (or anything thrown) as a toast. */
export const fail = (e) => toast((e && e.message) || 'Something went wrong', true);

export function btn(label, opts = {}) {
  const cls = ['btn', opts.kind, opts.sm && 'sm', opts.block && 'block', opts.cls];
  const kids = [opts.icon && icon(opts.icon, opts.sm ? 'sm b' : ''), label];
  if (opts.href) return h('a', { class: cls, href: opts.href, aria: opts.aria }, kids);
  return h('button', { class: cls, type: opts.type || 'button', disabled: !!opts.disabled, on: opts.on ? { click: opts.on } : undefined, aria: opts.aria }, kids);
}

export function iconBtn(name, label, onClick, cls = '') {
  return h('button', { class: 'ib ' + cls, type: 'button', aria: { label }, on: { click: onClick } }, icon(name, 'b'));
}
export function iconLink(name, label, href, cls = '') {
  return h('a', { class: 'ib ' + cls, href, aria: { label } }, icon(name, 'b'));
}

/** A back control: history back when we came from inside the app, otherwise the fallback path. */
export function backBtn(fallback = '/') {
  return iconBtn('back', 'Back', () => { if (history.state && history.state.n > 0) history.back(); else nav(fallback, { replace: true }); });
}

/** The top bar of a screen. */
export function appBar({ title, back, right = [], heading = true } = {}) {
  return h('header', { class: 'abar' }, back ? backBtn(back) : null,
    title !== undefined ? h(heading ? 'h1' : 'span', { class: 't', tabindex: '-1' }, title) : h('span', { class: 'grow' }), right);
}

export const empty = (title, text, action) => h('div', { class: 'empty', role: 'status' }, h('b', null, title), text ? h('span', null, text) : null, action || null);
export const loading = (label = 'Loading') => h('div', { class: 'loading', role: 'status' }, label + '…');
export function errorBox(e, retry) {
  if (e && e.status === 401) {
    return empty('Sign in to see this', 'This part of Community is for members.', h('div', { class: 'row wrap center' }, btn('Log in', { href: '/login?next=' + encodeURIComponent(location.pathname + location.search) })));
  }
  return empty(e && e.status === 404 ? 'Not found' : 'Could not load this', (e && e.message) || '', retry ? btn('Try again', { kind: 'w', on: retry }) : null);
}
export const asOfLine = (iso, before = '') => (iso ? h('p', { class: 'asof' }, before, asOf(iso)) : null);

export function toggle(checked, label, onChange) {
  const b = h('button', { class: 'tg', type: 'button', role: 'switch', aria: { checked: checked ? 'true' : 'false', label } });
  b.addEventListener('click', async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    try { if (onChange) await onChange(next); } catch (e) { b.setAttribute('aria-checked', String(!next)); fail(e); }
  });
  return b;
}

/** A row of single-choice chips (radiogroup). */
export function choiceChips(options, value, onPick, label) {
  const g = h('div', { class: 'chips wrap reach', role: 'radiogroup', aria: { label } });
  const set = (v) => g.querySelectorAll('.chip').forEach((c) => {
    const on = c.dataset.v === v; c.setAttribute('aria-checked', String(on)); c.tabIndex = on ? 0 : -1;
  });
  for (const [v, lab] of options) {
    g.append(h('button', { class: 'chip', type: 'button', role: 'radio', data: { v }, on: { click: () => { set(v); onPick(v); } } }, lab));
  }
  g.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const all = [...g.querySelectorAll('.chip')];
    const i = all.indexOf(document.activeElement);
    const n = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    if (n) { e.preventDefault(); n.focus(); n.click(); }
  });
  set(value);
  return g;
}

export function field(label, input, hint) {
  const id = input.id || ('f' + Math.random().toString(36).slice(2, 9));
  input.id = id;
  const wrapped = input.tagName === 'TEXTAREA' ? input : h('div', { class: 'field' }, input);
  return h('div', null, h('label', { class: 'lbl', for: id }, label), wrapped, hint ? h('p', { class: 'hint' }, hint) : null);
}

/* ---------- people ---------- */

export function avatar(p, size = '') {
  const cls = ['av', size, 't-' + ((p && p.trade) || 'other')];
  if (p && p.avatar_media_id) return h('span', { class: cls }, h('img', { src: '/media/' + p.avatar_media_id, alt: '', loading: 'lazy' }));
  return h('span', { class: cls, aria: { hidden: 'true' } }, ((p && (p.first_name || p.handle)) || '?').trim().charAt(0).toUpperCase());
}

export const tick = () => h('span', { class: 'tick', role: 'img', aria: { label: 'ID checked' }, title: 'ID checked' }, icon('check'));

export function personName(p, link = true) {
  const kids = [p.first_name || p.handle, p.id_checked ? tick() : null];
  return link ? h('a', { class: 'nm', href: profilePath(p.handle) }, kids) : h('span', { class: 'nm' }, kids);
}

export function personRow(p, right, sub) {
  return h('div', { class: 'li' }, h('a', { href: profilePath(p.handle), tabindex: '-1', aria: { hidden: 'true' } }, avatar(p)),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, personName(p)), h('div', { class: 't2' }, sub || ('@' + p.handle + ' · ' + tradeLabel(p.trade)))), right || null);
}

export function followBtn(p, following) {
  let on = !!following;
  const b = btn(on ? 'Following' : 'Follow', { sm: true, kind: on ? 'w' : '' });
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (on) await del('/people/' + encodeURIComponent(p.handle) + '/follow'); else await apiPost('/people/' + encodeURIComponent(p.handle) + '/follow');
      on = !on;
      b.lastChild.textContent = on ? 'Following' : 'Follow';
      b.classList.toggle('w', on);
      b.setAttribute('aria-pressed', String(on));
    } catch (e) { fail(e); } finally { b.disabled = false; }
  });
  return b;
}

/* ---------- sheets ---------- */

/** Open a bottom sheet (a modal <dialog>: focus is trapped, Esc closes). build(close) returns its content. */
export function sheet(label, build) {
  const d = h('dialog', { class: 'sheet', aria: { label } });
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  document.body.append(d);
  const content = build(close);
  d.append(...[content].flat().filter(Boolean));
  d.showModal();
  return { el: d, close };
}

/* ---------- posts ---------- */

/**
 * A post in a list. opts: { level, code } when it came from a ranked feed (shows "Why"), showPlace,
 * onRemoved.
 */
export function postView(p, opts = {}) {
  const a = p.author || {};
  const own = isMe(a.id);
  const where = opts.showPlace ? (p.distance_hint || (p.place && p.place.name)) : null;
  const meta = [tradeLabel(a.trade), where, timeAgo(p.created_at)].filter(Boolean).join(' · ');
  const art = h('article', { class: 'pst', aria: { label: 'Post by ' + (a.first_name || a.handle) } });
  if (p.space && p.space.name) art.append(h('div', { class: 'ctx' }, icon('hash', 'sm'), 'Posted in ' + p.space.name));
  art.append(h('a', { href: profilePath(a.handle || ''), tabindex: '-1', aria: { hidden: 'true' } }, avatar(a)));
  const col = h('div', { class: 'grow' },
    h('div', { class: 'hd' }, personName(a), h('span', { class: 'meta' }, ' · ' + meta),
      iconBtn('more', 'More about this post', () => postMenu(p, opts, art), 'more')),
    h('a', { class: 'tx', href: '/p/' + p.id }, p.body || ''),
    mediaGrid(p.media_ids, a),
    actions(p, own));
  const time = col.querySelector('.meta');
  if (time) time.title = fullTime(p.created_at);
  art.append(col);
  return art;
}

export function mediaGrid(ids, author) {
  if (!ids || !ids.length) return null;
  const n = Math.min(ids.length, 4);
  return h('div', { class: 'media n' + n }, ids.slice(0, 4).map((id) => h('img', { src: '/media/' + id, alt: 'Photo shared by ' + ((author && author.first_name) || 'the author'), loading: 'lazy' })));
}

function actions(p, own) {
  const replies = h('a', { href: '/p/' + p.id, aria: { label: 'Replies: ' + (p.replies || 0) } }, icon('reply'), count(p.replies || 0));
  let given = !!p.salamat_given, n = Number(p.salamats) || 0, saved = !!p.saved;
  const label = () => (own ? 'Salamats: ' + n : (given ? 'Take back your salamat. ' : 'Say salamat. ') + n + ' so far');
  const sal = h('button', { class: own ? 'sal static' : 'sal', type: 'button', aria: { pressed: String(given), label: label() } }, icon('heart'), h('span', null, count(n)));
  if (own) sal.setAttribute('aria-disabled', 'true');
  sal.addEventListener('click', async () => {
    if (own) { toast('You can\'t say salamat to your own post'); return; }
    if (!state.me) { nav('/login'); return; }
    sal.disabled = true;
    try {
      const r = given ? await del('/posts/' + p.id + '/salamat') : await apiPost('/posts/' + p.id + '/salamat', {});
      given = !given; p.salamat_given = given;
      n = r && typeof r.salamats === 'number' ? r.salamats : n + (given ? 1 : -1);
      sal.lastChild.textContent = count(n);
      sal.setAttribute('aria-pressed', String(given));
      sal.setAttribute('aria-label', label());
      if (given && r && typeof r.left_this_week === 'number') toast('Salamat sent · ' + r.left_this_week + ' left this week');
    } catch (e) { fail(e); } finally { sal.disabled = false; }
  });
  const sv = h('button', { class: 'sv', type: 'button', aria: { pressed: String(saved), label: saved ? 'Saved' : 'Save' } }, icon('save'));
  sv.addEventListener('click', async () => {
    if (!state.me) { nav('/login'); return; }
    try {
      if (saved) await del('/posts/' + p.id + '/save'); else await apiPost('/posts/' + p.id + '/save');
      saved = !saved;
      sv.setAttribute('aria-pressed', String(saved)); sv.setAttribute('aria-label', saved ? 'Saved' : 'Save');
      toast(saved ? 'Saved' : 'Removed from saved');
    } catch (e) { fail(e); }
  });
  return h('div', { class: 'acts' }, replies, sal, sv);
}

function postMenu(p, opts, art) {
  const a = p.author || {};
  sheet('Post options', (close) => h('div', { class: 'menu' },
    opts.level && opts.level !== 'barangay' ? h('button', { type: 'button', on: { click: () => { close(); whySheet(p, opts); } } }, icon('info'), 'Why am I seeing this?') : null,
    h('button', { type: 'button', on: { click: async () => {
      close();
      const url = location.origin + '/p/' + p.id;
      try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
    } } }, icon('link'), 'Copy link'),
    !isMe(a.id) ? h('a', { href: '/report?kind=post&id=' + encodeURIComponent(p.id) + '&name=' + encodeURIComponent(a.first_name || ''), class: 'danger', on: { click: close } }, icon('flag'), 'Report post') : null,
    (isMe(a.id) || can('reports.review')) ? h('button', { type: 'button', class: 'danger', on: { click: async () => {
      close();
      if (!confirm('Delete this post? This cannot be undone.')) return;
      try { await del('/posts/' + p.id); art.remove(); toast('Post deleted'); if (opts.onRemoved) opts.onRemoved(); } catch (e) { fail(e); }
    } } }, icon('trash'), 'Delete post') : null,
  ));
}

const pct = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 100) / 100) : '?');

/** "Why you're seeing this": the real inputs of this post's score (GET /posts/:id/why). */
export function whySheet(p, opts) {
  sheet('Why you\'re seeing this', (close) => {
    const box = h('div', null, h('h2', null, 'Why you\'re seeing this'), loading());
    get('/posts/' + p.id + '/why', { level: opts.level, code: opts.code }).then((r) => {
      const s = r.signals || {};
      const near = Number(s.near) >= 1 ? 'Same barangay' : Number(s.near) > 0 ? 'Same city' : 'Further away';
      box.replaceChildren(h('h2', null, 'Why you\'re seeing this'),
        h('p', { class: 'mute' }, 'These are the real inputs of this post\'s score, read just now.'),
        sig('pin', 'Near you', near), sig('work', 'Your trade', Number(s.trade) >= 1 ? 'Your trade' : 'Not your trade'),
        sig('heart', 'Salamats', (s.salamats_distinct ?? 0) + ' different ' + (Number(s.salamats_distinct) === 1 ? 'person' : 'people')),
        sig('clock', 'Fresh', (s.fresh_hours !== undefined ? Math.round(Number(s.fresh_hours)) + ' hours ago' : '')),
        formulaBox(r.weights, r.rule),
        btn('Got it', { block: true, on: close }));
    }).catch((e) => box.replaceChildren(h('h2', null, 'Why you\'re seeing this'), errorBox(e)));
    return box;
  });
}

const sig = (ic, label, value) => h('div', { class: 'sig' }, h('span', { class: 'ico' }, icon(ic, 'sm')), h('span', null, label), h('span', { class: 'mute' }, value));

/** The published formula with the live weights the API returned. */
export function formulaBox(w, rule) {
  const lines = [];
  if (w && typeof w === 'object') {
    lines.push('score = near×' + pct(w.near) + ' + trade×' + pct(w.trade) + ' + log2(1+salamats from different people)×' + pct(w.salamat) + ' + fresh×' + pct(w.fresh));
  }
  lines.push('fresh = 1 / (1 + hours/12) · near = 1 same barangay, 0.5 same city');
  lines.push('at most 2 posts per person in every 20 · no paid boosts · no outrage signals');
  return [
    rule ? h('p', { class: 'mt' }, rule) : null,
    h('div', { class: 'formula' }, lines.map((l) => h('div', null, l))),
    h('p', { class: 'mute' }, 'The weights for every level are in the public code (app/modules/posts/weights.ts).'),
  ];
}

/* ---------- Places zoom ---------- */

/** The five-stop zoom: an ARIA radiogroup with roving focus. */
export function zoomControl(level, onPick) {
  const ci = Math.max(0, levelIndex(level));
  const g = h('div', { class: 'zoom', role: 'radiogroup', aria: { label: 'How far to look' } },
    h('div', { class: 'track', aria: { hidden: 'true' } }, h('i', { class: 'w' + ci })));
  LEVELS.forEach((l, i) => {
    g.append(h('button', {
      type: 'button', role: 'radio', class: i < ci ? 'past' : '', tabindex: i === ci ? '0' : '-1',
      aria: { checked: String(i === ci) }, data: { level: l.k }, on: { click: () => { if (i !== ci) onPick(l.k); } },
    }, h('b', { class: 'd' + i, aria: { hidden: 'true' } }), h('span', null, l.label)));
  });
  g.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const ni = Math.min(LEVELS.length - 1, Math.max(0, ci + d));
    if (ni !== ci) onPick(LEVELS[ni].k);
  });
  return g;
}

/* ---------- paged lists ---------- */

/**
 * A list that loads pages on demand. fetchPage(before) resolves { items, end, as_of }.
 * render(item) returns a Node. Shows the time the first page was read, a plain empty state, and
 * a "Load more" button (never an endless scroll).
 */
export function pagedList({ fetchPage, render, emptyNode, endNode, cursor = (it) => it.created_at, showAsOf = true }) {
  const box = h('div');
  const list = h('div', { role: 'feed', aria: { busy: 'true' } });
  const foot = h('div');
  let before, total = 0;
  box.append(list, foot);
  async function load() {
    foot.replaceChildren(loading());
    list.setAttribute('aria-busy', 'true');
    try {
      const r = await fetchPage(before);
      const items = r.items || [];
      if (total === 0 && showAsOf && r.as_of) box.prepend(asOfLine(r.as_of, 'Live · '));
      for (const it of items) { const n = render(it); if (n) list.append(n); }
      total += items.length;
      if (items.length) before = cursor(items[items.length - 1]);
      const end = r.end !== undefined ? r.end : items.length === 0;
      foot.replaceChildren();
      if (!total) foot.append(emptyNode || empty('Nothing here yet'));
      else if (!end && items.length) foot.append(h('div', { class: 'more-row' }, btn('Load more', { kind: 'w', sm: true, on: load })));
      else if (endNode) foot.append(endNode);
    } catch (e) { foot.replaceChildren(errorBox(e, load)); }
    list.setAttribute('aria-busy', 'false');
  }
  load();
  return box;
}

/** Run an async loader and swap its result into a placeholder; shows loading and errors. */
export function later(fn, label) {
  const box = h('div', null, loading(label));
  const run = () => { box.replaceChildren(loading(label)); Promise.resolve().then(fn).then((n) => box.replaceChildren(...[n].flat(Infinity).filter(Boolean)), (e) => box.replaceChildren(errorBox(e, run))); };
  run();
  return box;
}

/** A segmented tab row (links). items: [label, href, current?] */
export function linkTabs(items, cls = '') {
  return h('nav', { class: 'ftabs ' + cls, aria: { label: 'Views' } }, items.map(([label, href, on, ic]) => h('a', { href, aria: { current: on ? 'page' : undefined } }, ic ? icon(ic, 'sm') : null, label)));
}

/** A segmented tab row (buttons in place). */
export function buttonTabs(items, current, onPick, label) {
  const bar = h('div', { class: 'ftabs', role: 'tablist', aria: { label } });
  for (const [k, lab] of items) {
    const b = h('button', { type: 'button', role: 'tab', aria: { selected: String(k === current) } }, lab);
    b.addEventListener('click', () => {
      bar.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      onPick(k);
    });
    bar.append(b);
  }
  return bar;
}
