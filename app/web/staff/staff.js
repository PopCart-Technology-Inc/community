// The staff panel (decision 0009). Served only on the staff host, after the gate (Cloudflare Access).
// Opening it takes a staff passkey made for this host; a member passkey from the public site does not
// work here. Set up once with a code from Settings on Community. The session locks after the idle time
// the server sends (15 minutes) and the server ends it at 12 hours whatever happens here.
// Two panels share this page: Overseer (/overseer/...) and Admin (/admin/...). The navigation shows only
// what the person's scopes allow; the server checks every call again.
import { h, icon } from '/static/lib/dom.js';
import { get, post } from '/static/lib/api.js';
import { creationOptionsFromJSON, credentialToJSON, requestOptionsFromJSON } from '/static/lib/webauthn.js';
import { btn, empty, field, loading, toast } from '/static/ui.js';
import { loadBrand } from '/static/lib/brand.js';
import { has, S, setHandlers, sget } from './core.js';
import { drawer } from './kit.js';
import { ADMIN_NAV, person } from './admin.js';
import { OVERSEER_NAV } from './overseer.js';

const root = () => document.getElementById('app');
const NO_PASSKEY = 'This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.';
const T = { tick: null, sync: null };
// the brand pack (fonts, Pop Mark), when the server has one: started now, waited for before the first screen
const brand = Promise.race([loadBrand(), new Promise((ok) => setTimeout(ok, 2000))]);

function mount(node) {
  root().replaceChildren(node, h('div', { id: 'toast', role: 'status', aria: { live: 'polite' } }));
}

async function boot() {
  root().replaceChildren(loading('Checking the gate'));
  try {
    S.session = await get('/staff/session');
    await brand;
  } catch (e) {
    mount(h('main', { class: 'st' }, empty('Could not reach the staff panel', (e && e.message) || '', btn('Try again', { kind: 'w', on: boot }))));
    return;
  }
  if (S.session.user) { startClock(new Date(S.session.user.idle_ends_at).getTime()); shell(); } else { stopClock(); signIn(); }
}

/* ---------- the idle clock ---------- */

function startClock(ends) {
  stopClock();
  S.idleEnds = ends;
  T.tick = setInterval(paintClock, 1000);
  // Re-read the session each minute without counting as activity: the server's clock wins.
  T.sync = setInterval(async () => {
    try {
      const s = await get('/staff/session');
      if (!s.user) { stopClock(); toast('The staff session ended', true); S.session = s; signIn(); return; }
      S.idleEnds = new Date(s.user.idle_ends_at).getTime();
    } catch { /* offline: the local clock still locks */ }
  }, 60_000);
}

function stopClock() { clearInterval(T.tick); clearInterval(T.sync); T.tick = T.sync = null; }

function paintClock() {
  const left = Math.max(0, S.idleEnds - Date.now());
  const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
  for (const el of document.querySelectorAll('.st-clock')) {
    el.lastChild.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('soon', left < 120_000);
    el.setAttribute('aria-label', `Locks in ${m} minutes ${s} seconds unless you use the panel. Press to lock now.`);
  }
  if (left === 0) lock('idle');
}

async function lock(why) {
  stopClock();
  try { await post('/staff/lock', { why }); } catch { /* the server ends it on its own clock anyway */ }
  toast(why === 'idle' ? 'Locked after ' + ((S.session && S.session.idle_minutes) || 15) + ' minutes idle' : 'Locked');
  await boot();
}

/* ---------- signed out: passkey, or first-time setup with a code ---------- */

const plainBar = () => h('header', { class: 'st-bar' }, h('span', { class: 'name' }, 'Community'), h('span', { class: 'tag y' }, 'Staff'), h('span', { class: 'grow' }));

function signIn() {
  const s = S.session;
  if (s.gate === 'access' && s.listed === false) {
    mount(h('main', { class: 'st' }, plainBar(),
      h('div', { class: 'st-card st-hero mt' }, h('div', { class: 'passkey-art' }, icon('shield', 'lg')),
        h('h1', null, 'Not on the staff list'),
        h('p', { class: 'mute' }, 'The gate let this address in, but no one holding a staff role uses it. An Overseer adds it when they give you a role.'))));
    return;
  }
  const msg = h('p', { class: 'err', role: 'alert' });
  const open = btn('Open with staff passkey', { block: true, icon: 'finger' });
  open.addEventListener('click', async () => {
    msg.textContent = '';
    if (!window.PublicKeyCredential) { msg.textContent = NO_PASSKEY; return; }
    open.disabled = true;
    try {
      const o = await post('/staff/login/options');
      const cred = await navigator.credentials.get({ publicKey: requestOptionsFromJSON(o.options) });
      if (!cred) throw new Error('No passkey was chosen');
      await post('/staff/login/verify', { challengeId: o.challengeId, response: credentialToJSON(cred) });
      await boot();
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError' ? 'Cancelled or timed out. Try again.' : ((e && e.message) || 'Could not open the panel');
    } finally { open.disabled = false; }
  });
  const setup = setupForm();
  const first = s.enrolled !== true;
  const more = h('button', { class: 'linkbtn', type: 'button', aria: { expanded: 'false', controls: 'st-setup' } }, 'Set up this device with a code');
  more.addEventListener('click', () => { const on = setup.hidden; setup.hidden = !on; more.setAttribute('aria-expanded', String(on)); if (on) setup.querySelector('input').focus(); });
  setup.hidden = !first;
  mount(h('main', { class: 'st' }, plainBar(),
    h('div', { class: 'st-main narrow' },
      h('div', { class: 'st-card st-hero mt' }, h('div', { class: 'passkey-art' }, icon('lock', 'lg')),
        h('h1', null, 'Staff panel'),
        h('p', { class: 'mute' }, 'Open it with your staff passkey. It is a different passkey from the one you use on Community, and works only here.'),
        h('div', { class: 'mt' }, open), msg,
        first ? null : h('p', { class: 'linkrow' }, more)),
      setup)));
  const t = root().querySelector('h1'); if (t) { t.tabIndex = -1; t.focus({ preventScroll: true }); }
}

function setupForm() {
  const code = h('input', { class: 'codein', maxlength: '9', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', aria: { describedby: 'st-code-hint' } });
  const msg = h('p', { class: 'err', role: 'alert' });
  const make = btn('Make my staff passkey', { block: true, type: 'submit', icon: 'finger' });
  const form = h('form', { class: 'st-card', id: 'st-setup', novalidate: true },
    h('h2', null, 'First time here'),
    h('p', { class: 'mute' }, 'On Community, open Settings, then Staff passkey, and make a setup code. Type it here.'),
    h('div', { class: 'mt' }, field('Setup code', code)),
    h('p', { class: 'hint', id: 'st-code-hint' }, icon('clock', 'sm'), 'A code works once, for 10 minutes, and only for the person whose address the gate let in.'),
    msg, h('div', { class: 'mt' }, make));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.textContent = '';
    const c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 8) { msg.textContent = 'The code has 8 letters and numbers.'; code.focus(); return; }
    if (!window.PublicKeyCredential) { msg.textContent = NO_PASSKEY; return; }
    make.disabled = true;
    try {
      const o = await post('/staff/enroll/options', { code: c });
      const cred = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(o.options) });
      if (!cred) throw new Error('No passkey was made');
      await post('/staff/enroll/verify', { challengeId: o.challengeId, response: credentialToJSON(cred), code: c });
      toast('Staff passkey made');
      await boot();
    } catch (x) {
      msg.textContent = x && x.name === 'NotAllowedError' ? 'The passkey was cancelled or timed out. Try again.' : ((x && x.message) || 'Could not make the passkey');
    } finally { make.disabled = false; }
  });
  return form;
}

/* ---------- signed in: the shell, the navigation and the screens ---------- */

const allowed = (list) => list.filter(([, , , scope]) => has(scope));
const navs = () => [['Overseer', allowed(OVERSEER_NAV)], ['Admin', allowed(ADMIN_NAV)]].filter(([, items]) => items.length);
const landing = () => (navs()[0] ? navs()[0][1][0][0] : null);

function route(path) {
  const exact = [...OVERSEER_NAV, ...ADMIN_NAV].find(([p]) => p === path);
  if (exact) return has(exact[3]) ? { screen: exact[4], path } : null;
  const m = /^\/admin\/people\/([a-z0-9._]{1,30})$/.exec(path);
  if (m && has('people.lookup')) return { screen: () => person({ handle: m[1] }), path: '/admin/people' };
  return null;
}

let mainEl = null, navEl = null;

function shell() {
  const u = S.session.user;
  navEl = h('nav', { class: 'st-nav', aria: { label: 'Staff panel' } });
  const side = h('aside', { class: 'st-side' },
    h('a', { class: 'st-brand', href: landing() || '/' }, h('span', { class: 'name' }, 'Community'), h('span', { class: 'tag y' }, 'Staff')),
    navEl,
    h('div', { class: 'st-you' },
      S.session.public_origin ? h('a', { class: 'st-link', href: S.session.public_origin, target: '_blank', rel: 'noopener' }, icon('globe'), h('span', { class: 'grow' }, 'Back to Community')) : null,
      h('div', { class: 'st-me' }, h('div', { class: 'st-badge sm' }, icon('shield')), h('div', { class: 'grow' }, h('b', null, '@' + u.handle), h('small', null, u.role + ' · staff passkey')))));
  const bar = h('header', { class: 'st-bar' },
    h('button', { class: 'ib st-menu', type: 'button', aria: { label: 'Menu' }, on: { click: openMenu } }, icon('more', 'b')),
    h('span', { class: 'name st-only-phone' }, 'Community'),
    h('button', { class: 'st-jump', type: 'button', on: { click: palette } }, icon('search', 'sm'), h('span', null, 'Jump to…'), h('kbd', null, 'Ctrl K')),
    h('span', { class: 'grow' }),
    h('button', { class: 'st-clock', type: 'button', role: 'timer', on: { click: () => lock('button') } }, icon('clock', 'sm'), h('span', null, '--:--')),
    btn('Lock', { sm: true, icon: 'lock', on: () => lock('button') }));
  mainEl = h('main', { class: 'st-main', id: 'st-main', tabindex: '-1' });
  mount(h('div', { class: 'st-shell' }, side, h('div', { class: 'st-body' }, bar, mainEl)));
  paintClock();
  render(location.pathname, true);
}

function paintNav(current) {
  navEl.replaceChildren(...navs().map(([group, items]) => h('div', { class: 'st-group' }, h('p', { class: 'mono' }, group),
    items.map(([p, label, ic]) => h('a', { href: p, class: 'st-link', aria: { current: p === current ? 'page' : undefined } }, icon(ic), h('span', { class: 'grow' }, label),
      p === '/overseer/approvals' ? h('span', { class: 'count', hidden: true }) : null)))));
  if (has('approvals.decide')) {
    sget('/staff/approvals').then((r) => {
      const n = r.approvals.filter((a) => a.can_decide).length;
      for (const el of document.querySelectorAll('.st-link .count')) { el.hidden = !n; el.textContent = String(n); el.setAttribute('aria-label', n + ' to decide'); }
    }).catch(() => { /* the count is a hint */ });
  }
}

function render(path, replace) {
  let r = route(path);
  if (!r) {
    const to = landing();
    if (!to) { mainEl.replaceChildren(empty('Nothing here for your role', 'Your role has no panel tools yet. An Overseer can add scopes to it.')); paintNav(''); return; }
    history.replaceState({ n: 0 }, '', to);
    r = route(to);
  } else if (replace) history.replaceState({ n: (history.state && history.state.n) || 0 }, '', path);
  else history.pushState({ n: ((history.state && history.state.n) || 0) + 1 }, '', path);
  const { title, node } = r.screen();
  document.title = title + ' · Community staff';
  paintNav(r.path);
  mainEl.replaceChildren(node);
  mainEl.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function navigate(path, opts = {}) { render(path, !!opts.replace); }

function openMenu() {
  drawer('Staff panel', (close) => {
    const n = navEl.cloneNode(true);
    n.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    return n;
  });
}

/** Ctrl K: go to any section your role allows. */
function palette() {
  const items = navs().flatMap(([g, list]) => list.map(([p, label, ic]) => ({ p, label, ic, g })));
  let shown = items, active = 0;
  const input = h('input', { class: 'pal-in', placeholder: 'Go to…', autocomplete: 'off', role: 'combobox', aria: { expanded: 'true', controls: 'pal-l', autocomplete: 'list', label: 'Go to' } });
  const list = h('ul', { class: 'dd-l pal-l', id: 'pal-l', role: 'listbox', aria: { label: 'Sections' } });
  let close = () => {};
  const pick = (i) => { const it = shown[i]; if (!it) return; close(); navigate(it.p); };
  const paint = () => {
    list.replaceChildren(...shown.map((it, i) => h('li', { role: 'option', id: 'pal-' + i, class: i === active ? 'on' : '', aria: { selected: String(i === active) }, on: { click: () => pick(i) } },
      icon(it.ic, 'sm'), h('span', null, it.label), h('small', null, it.g))));
    if (shown[active]) input.setAttribute('aria-activedescendant', 'pal-' + active); else input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('input', () => { const q = input.value.trim().toLowerCase(); shown = items.filter((it) => it.label.toLowerCase().includes(q)); active = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(active); e.preventDefault(); }
  });
  const d = h('dialog', { class: 'sheet pal', aria: { label: 'Jump to' } }, input, list);
  close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  document.body.append(d);
  paint();
  d.showModal();
  input.focus();
}

setHandlers({ lost: () => { stopClock(); boot(); }, nav: navigate });

// Links inside the panel move with the History API; links elsewhere open normally.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || !mainEl || !mainEl.isConnected) return;
  e.preventDefault();
  navigate(url.pathname);
});
window.addEventListener('popstate', () => { if (mainEl && mainEl.isConnected) render(location.pathname, true); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && mainEl && mainEl.isConnected) { e.preventDefault(); palette(); }
});

boot();
