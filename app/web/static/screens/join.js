// Welcome, joining (invite-only for now, decision 0006 point 8) and passkey login.
// Join: Before you join (EN/FIL, unticked boxes) -> improvement switches (off) -> profile -> passkey -> Spaces.
import { h, icon } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { creationOptionsFromJSON, credentialToJSON, requestOptionsFromJSON } from '../lib/webauthn.js';
import { HANDLE_RE, TRADES, tradeLabel } from '../lib/format.js';
import { brandName, illustration } from '../lib/brand.js';
import { nav, state } from '../core.js';
import { appBar, btn, choiceChips, empty, errorBox, fail, field, followBtn, later, loading, personRow, toggle } from '../ui.js';

const authed = (user) => { state.me = user; window.dispatchEvent(new Event('cm:auth')); };
const canPasskey = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
const NO_PASSKEY = 'This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.';

/* ---------- welcome (signed out) ---------- */

export function welcome() {
  const node = h('div', { class: 'welcome' },
    brandName('l'),
    illustration('rider', 'ill'),
    h('div', { class: 'hero' },
      h('h1', { class: 'x big', tabindex: '-1' }, 'The network for people who work.'),
      h('p', { class: 'lede' }, 'Show your work. Find your crew. Get hired. Open source, never sold.'),
      btn('Look around first', { block: true, href: '/places' }),
      btn('Log in with passkey', { block: true, kind: 'w', href: '/login' }),
      h('p', { class: 'center hint' }, 'Joining is by invite while we finish the privacy review. Got an invite link? Open it to join.')));
  return { node, bare: true, title: 'Welcome' };
}

/* ---------- login ---------- */

export function login({ query }) {
  const next = safeNext(query.get('next'));
  const msg = h('p', { class: 'err', role: 'alert' });
  const go = btn('Log in with passkey', { block: true, icon: 'finger' });
  go.addEventListener('click', async () => {
    msg.textContent = '';
    if (!canPasskey()) { msg.textContent = NO_PASSKEY; return; }
    go.disabled = true;
    try {
      const { challengeId, options } = await post('/accounts/login/options');
      const cred = await navigator.credentials.get({ publicKey: requestOptionsFromJSON(options) });
      if (!cred) throw new Error('No passkey was chosen');
      const r = await post('/accounts/login/verify', { challengeId, response: credentialToJSON(cred) });
      authed(r.user);
      nav(next, { replace: true });
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError' ? 'Log in was cancelled or timed out. Try again.' : ((e && e.message) || 'Could not log in');
    } finally { go.disabled = false; }
  });
  const node = h('div', null, appBar({ back: '/', title: '' }), h('div', { class: 'ob' },
    h('div', { class: 'passkey-art' }, icon('finger', 'lg')),
    h('h1', { tabindex: '-1' }, 'Log in'),
    h('p', { class: 'sub' }, 'Use the passkey on this phone or computer: your fingerprint, face or screen lock. No password.'),
    go, msg,
    h('p', { class: 'hint' }, icon('info', 'sm'), 'New here? Joining is by invite for now: open your invite link.')));
  return { node, bare: true, title: 'Log in' };
}

const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

/* ---------- join ---------- */

const POINTS = {
  en: [
    ['lock', 'Your sign-in records are sealed, kept apart from your profile.'],
    ['scale', 'They are opened only for a court order. Two people approve, every opening is logged, and you are told.'],
    ['eyeoff', 'We never sell your data or show you ads. No tracking.'],
    ['users', 'The community rules apply to everyone, staff included.'],
    ['user', 'You must be 18 or older.'],
  ],
  fil: [
    ['lock', 'Selyado ang records ng pag-sign in mo, hiwalay sa profile mo.'],
    ['scale', 'Bubuksan lang ang mga ito kapag may utos ng korte. Dalawang tao ang mag-aapruba, nakatala ang bawat pagbukas, at sasabihan ka.'],
    ['eyeoff', 'Hindi namin ibinebenta ang data mo at walang ads. Walang tracking.'],
    ['users', 'Pareho ang patakaran ng komunidad para sa lahat, kasama ang staff.'],
    ['user', 'Dapat 18 taong gulang ka pataas.'],
  ],
};
const T = {
  en: { h: 'Before you join', sub: 'Five things, in plain words.', agree: (v) => `I've read and agree to the Terms, Privacy notice and Community rules (version ${v}).`, adult: "I'm 18 or older.", go: 'Agree and continue', full: 'The full Terms, Privacy notice and Community rules are published before sign-up opens to everyone.' },
  fil: { h: 'Bago ka sumali', sub: 'Limang bagay, sa simpleng salita.', agree: (v) => `Nabasa ko at sang-ayon ako sa Terms, Privacy notice at Community rules (bersyon ${v}).`, adult: 'Ako ay 18 taong gulang pataas.', go: 'Sumang-ayon at magpatuloy', full: 'Ilalabas ang buong Terms, Privacy notice at Community rules bago magbukas ang sign-up para sa lahat.' },
};

export function join({ query }) {
  const code = (query.get('code') || '').trim();
  const root = h('div');
  if (state.me) {
    root.append(empty('You\'re already in', 'You are signed in as @' + state.me.handle + '.', btn('Go home', { href: '/' })));
    return { node: root, bare: true, title: 'Join' };
  }
  if (!code) {
    root.append(appBar({ back: '/', title: '' }), empty('Joining is by invite for now',
      'While the privacy review is done, people join with an invite link from the Community team. Open the link you were sent.',
      btn('Look around first', { href: '/places' })));
    return { node: root, bare: true, title: 'Join' };
  }
  const d = { code, lang: 'en', agree: false, adult: false, terms: null, improve_usage: false, improve_surveys: false, first_name: '', handle: '', trade: '', home_area: null, home_name: '' };
  const steps = [before, choices, profile, passkey, findSpaces];
  let i = 0;
  const show = (n) => {
    i = n;
    root.replaceChildren(steps[i](d, { next: () => show(i + 1), back: () => (i > 0 ? show(i - 1) : nav('/')), goto: show }));
    const h1 = root.querySelector('h1'); if (h1) h1.focus();
    window.scrollTo(0, 0);
  };
  root.append(loading('Checking your invite'));
  Promise.all([post('/accounts/invite/check', { code }), get('/terms')]).then(([, t]) => { d.terms = t.version; show(0); }, (e) => {
    root.replaceChildren(appBar({ back: '/', title: '' }), e.status === 404
      ? empty('This invite can\'t be used', 'It has been used or has expired. Ask the person who invited you for a new link.')
      : errorBox(e));
  });
  return { node: root, bare: true, title: 'Join' };
}

const progress = (n) => h('div', { class: 'progress', role: 'progressbar', aria: { label: 'Joining', valuemin: '1', valuemax: '5', valuenow: String(n) } },
  [1, 2, 3, 4, 5].map((k) => h('i', { class: k <= n ? 'on' : '' })));

function stepBar(go, right) {
  return h('header', { class: 'abar' }, h('button', { class: 'ib', type: 'button', aria: { label: 'Back' }, on: { click: go.back } }, icon('back', 'b')), h('span', { class: 'grow' }), right || null);
}

function checkbox(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'agree' }, input, h('span', { class: 'box', aria: { hidden: 'true' } }, icon('check', 'sm b')), h('span', null, label));
}

function before(d, go) {
  const L = T[d.lang];
  const lang = h('div', { class: 'lang', role: 'group', aria: { label: 'Language' } },
    [['en', 'EN', 'English'], ['fil', 'FIL', 'Filipino']].map(([k, lab, full]) => h('button', {
      type: 'button', lang: k === 'fil' ? 'fil' : 'en', aria: { pressed: String(d.lang === k), label: full },
      on: { click: () => { d.lang = k; go.goto(0); } },
    }, lab)));
  const next = btn(L.go, { block: true, disabled: !(d.agree && d.adult) });
  const update = () => { next.disabled = !(d.agree && d.adult); };
  next.addEventListener('click', go.next);
  return h('div', { lang: d.lang === 'fil' ? 'fil' : 'en' }, stepBar(go, lang), progress(1), h('div', { class: 'ob' },
    h('h1', { tabindex: '-1' }, L.h), h('p', { class: 'sub' }, L.sub),
    POINTS[d.lang].map(([ic, text]) => h('div', { class: 'pt' }, h('span', { class: 'ico' }, icon(ic, 'sm')), h('span', null, text))),
    checkbox(L.agree(d.terms), d.agree, (v) => { d.agree = v; update(); }),
    checkbox(L.adult, d.adult, (v) => { d.adult = v; update(); }),
    next,
    h('p', { class: 'hint' }, icon('info', 'sm'), L.full)));
}

function choices(d, go) {
  const row = (title, desc, key) => h('div', { class: 'toggle' }, h('div', { class: 'grow' }, h('p', null, h('b', null, title)), h('p', { class: 'd' }, desc)), toggle(d[key], title, (v) => { d[key] = v; }));
  return h('div', null, stepBar(go), progress(2), h('div', { class: 'ob' },
    h('h1', { tabindex: '-1' }, 'Help us improve?'),
    h('p', { class: 'sub' }, 'Both are off. Turn on only what you\'re happy with. You can change this any time in Settings.'),
    row('Usage and errors', 'Which screens break or confuse. Raw data deleted after 90 days.', 'improve_usage'),
    row('Surveys and tests', 'We may ask you to try new things.', 'improve_surveys'),
    h('p', { class: 'hint' }, 'Never sold, never for ads, never used to rank you. Turn it off and we delete your raw data.'),
    h('div', { class: 'mt' }, btn('Next', { block: true, on: go.next }))));
}

/** City search against /places/search. Calls onPick({ code, name, parent_name }) or onPick(null). */
export function placeSearch(initial, onPick, label = 'City') {
  const input = h('input', { type: 'search', autocomplete: 'off', value: initial || '', placeholder: 'Start typing a city or barangay', aria: { autocomplete: 'list' } });
  const list = h('div', { class: 'suggest', role: 'listbox', aria: { label: 'Places' } });
  list.hidden = true;
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    onPick(null);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    t = setTimeout(async () => {
      try {
        const r = await get('/places/search', { q });
        list.replaceChildren(...(r.areas || []).map((a) => h('button', { type: 'button', role: 'option', on: { click: () => {
          input.value = a.name; list.hidden = true; onPick(a);
        } } }, h('b', null, a.name), a.parent_name ? h('span', { class: 'mute' }, ' · ' + a.parent_name) : null)));
        if (!(r.areas || []).length) list.replaceChildren(h('p', { class: 'hint pad' }, 'No place by that name.'));
        list.hidden = false;
      } catch (e) { list.replaceChildren(h('p', { class: 'hint pad' }, e.message)); list.hidden = false; }
    }, 250);
  });
  return h('div', null, field(label, input), list);
}

function profile(d, go) {
  const err = h('p', { class: 'err', role: 'alert' });
  const first = h('input', { value: d.first_name, autocomplete: 'given-name', maxlength: '40', required: true });
  const handle = h('input', { value: d.handle, autocomplete: 'username', maxlength: '30', autocapitalize: 'none', spellcheck: 'false', required: true });
  const hint = h('span', null, '3-30 letters, numbers, dots or underscores.');
  handle.addEventListener('input', () => {
    handle.value = handle.value.toLowerCase();
    hint.textContent = HANDLE_RE.test(handle.value) ? 'Looks good.' : '3-30 letters, numbers, dots or underscores.';
  });
  const trades = choiceChips(TRADES.map(([k, l]) => [k, l]), d.trade, (v) => { d.trade = v; }, 'What do you do?');
  const city = placeSearch(d.home_name, (a) => { d.home_area = a ? a.code : null; d.home_name = a ? a.name : ''; });
  const next = btn('Next', { block: true, type: 'submit' });
  const form = h('form', { class: 'ob', novalidate: true },
    h('h1', { tabindex: '-1' }, 'Set up your profile'),
    h('p', { class: 'sub' }, 'Public, so people in your trade can find you. Add a photo later in Settings.'),
    field('First name', first),
    h('div', null, h('label', { class: 'lbl', for: 'handle' }, 'Username'), h('div', { class: 'field' }, h('span', { class: 'mute', aria: { hidden: 'true' } }, '@'), Object.assign(handle, { id: 'handle' })), h('p', { class: 'hint', aria: { live: 'polite' } }, hint)),
    h('p', { class: 'lbl', id: 'trade-l' }, 'What do you do?'), trades,
    city,
    h('p', { class: 'hint' }, icon('lock', 'sm'), 'Never your address, plate or phone.'),
    err, h('div', { class: 'mt' }, next));
  trades.setAttribute('aria-labelledby', 'trade-l');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    d.first_name = first.value.trim();
    d.handle = handle.value.trim().toLowerCase();
    if (!d.first_name) { err.textContent = 'Add your first name.'; first.focus(); return; }
    if (!HANDLE_RE.test(d.handle)) { err.textContent = 'Pick a username: 3-30 letters, numbers, dots or underscores.'; handle.focus(); return; }
    if (!d.trade) { err.textContent = 'Pick what you do (or Other).'; return; }
    go.next();
  });
  if (d.error) { err.textContent = d.error; d.error = ''; }
  return h('div', null, stepBar(go), progress(3), form);
}

function passkey(d, go) {
  const msg = h('p', { class: 'err', role: 'alert' });
  const make = btn('Create passkey', { block: true, icon: 'finger' });
  make.addEventListener('click', async () => {
    msg.textContent = '';
    if (!canPasskey()) { msg.textContent = NO_PASSKEY; return; }
    make.disabled = true;
    try {
      const { challengeId, options } = await post('/accounts/register/options', {
        code: d.code, handle: d.handle, first_name: d.first_name, trade: d.trade, home_area: d.home_area || undefined,
        agree: d.agree, adult: d.adult, terms_version: d.terms, improve_usage: d.improve_usage, improve_surveys: d.improve_surveys,
      });
      const cred = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
      if (!cred) throw new Error('No passkey was made');
      const r = await post('/accounts/register/verify', { challengeId, response: credentialToJSON(cred) });
      authed(r.user);
      go.next();
    } catch (e) {
      if (e && e.code === 'handle_taken') { d.error = e.message; go.goto(2); return; }
      if (e && e.code === 'terms_changed') { try { d.terms = (await get('/terms')).version; } catch { /* keep */ } d.agree = false; go.goto(0); return; }
      msg.textContent = e && e.name === 'NotAllowedError' ? 'The passkey was cancelled or timed out. Try again.' : ((e && e.message) || 'Could not make the passkey');
    } finally { make.disabled = false; }
  });
  return h('div', null, stepBar(go), progress(4), h('div', { class: 'ob center' },
    h('div', { class: 'passkey-art' }, icon('finger', 'lg')),
    h('h1', { tabindex: '-1' }, 'No password needed'),
    h('p', { class: 'sub' }, 'Log in with your fingerprint, face or screen lock, the way you unlock your phone. Your private key never leaves this device.'),
    make, msg));
}

function findSpaces(d) {
  const done = btn('Done', { block: true, on: () => nav('/', { replace: true }) });
  return h('div', null, h('header', { class: 'abar' }, h('h1', { class: 't', tabindex: '-1' }, 'Find your people'), h('a', { class: 'btn sm w', href: '/' }, 'Skip')),
    h('p', { class: 'pad mute' }, 'Spaces near you and people in your trade. Suggestions come from your trade and city, never from your contacts.'),
    d.home_area ? h('h2', { class: 'sect' }, 'Spaces near you') : null,
    d.home_area ? later(async () => {
      const r = await get('/spaces', { near: d.home_area });
      if (!(r.spaces || []).length) return h('p', { class: 'pad mute' }, 'No Spaces near you yet.');
      return r.spaces.slice(0, 8).map((s) => spaceJoinRow(s));
    }) : null,
    h('h2', { class: 'sect' }, 'People in your trade · ' + tradeLabel(d.trade)),
    later(async () => {
      const r = await get('/people', { trade: d.trade });
      if (!(r.people || []).length) return h('p', { class: 'pad mute' }, 'Nobody else in your trade here yet.');
      return r.people.slice(0, 8).map((p) => personRow(p, followBtn(p, false)));
    }),
    h('div', { class: 'pad mt' }, done));
}

export function spaceJoinRow(s) {
  const b = btn(s.role ? 'Joined' : 'Join', { sm: true, kind: s.role ? 'w' : '' });
  if (s.role || s.visibility === 'private') { b.disabled = !s.role && s.visibility === 'private'; if (b.disabled) b.lastChild.textContent = 'Invite only'; }
  b.addEventListener('click', async () => {
    if (b.lastChild.textContent !== 'Join') return;
    b.disabled = true;
    try { await post('/spaces/' + encodeURIComponent(s.slug) + '/members'); b.lastChild.textContent = 'Joined'; b.classList.add('w'); } catch (e) { fail(e); b.disabled = false; }
  });
  return h('div', { class: 'li' }, h('span', { class: 'av sq' }, (s.name || '?').charAt(0)),
    h('a', { class: 'grow', href: '/s/' + encodeURIComponent(s.slug) }, h('div', { class: 't1' }, s.name), h('div', { class: 't2' }, (s.members ?? 0) + ' members · ' + (s.visibility || 'public'))), b);
}
