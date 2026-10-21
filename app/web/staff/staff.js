// The staff panel (decision 0009). Served only on the staff host, after the gate (Cloudflare Access).
// Opening it takes a staff passkey made for this host; a member passkey from the public site does not
// work here. Set up once with a code from Settings on Community. The session locks after the idle time
// the server sends (15 minutes) and the server ends it at 12 hours whatever happens here.
import { h, icon } from '/static/lib/dom.js';
import { get, post, qs } from '/static/lib/api.js';
import { creationOptionsFromJSON, credentialToJSON, requestOptionsFromJSON } from '/static/lib/webauthn.js';
import { fullTime, timeAgo } from '/static/lib/format.js';
import { btn, choiceChips, empty, field, loading, toast } from '/static/ui.js';

const root = () => document.getElementById('app');
const NO_PASSKEY = 'This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.';

/** The last GET /staff/session, and when the idle lock comes (ms since epoch). */
const S = { session: null, idleEnds: 0, tick: null, sync: null };

const KIND_LABEL = {
  session: 'Sign-in', staff: 'Staff', role: 'Roles', invite: 'Invites', report: 'Reports', appeal: 'Appeals',
  account: 'Accounts', switch: 'Switches', approval: 'Approvals', vault: 'Vault', audit: 'Audit',
};

/** Any staff API call. Counts as activity (the server moved the idle time too); a lost session goes back to sign-in. */
async function call(fn) {
  try {
    const r = await fn();
    if (S.session && S.session.user) S.idleEnds = Date.now() + S.session.idle_minutes * 60_000;
    return r;
  } catch (e) {
    if (e && e.status === 401 && e.code === 'staff_sign_in') { stopClock(); await boot(); }
    throw e;
  }
}

function mount(node) {
  root().replaceChildren(node, h('div', { id: 'toast', role: 'status', aria: { live: 'polite' } }));
  const t = node.querySelector('h1');
  if (t) { t.tabIndex = -1; t.focus({ preventScroll: true }); }
}

async function boot() {
  root().replaceChildren(loading('Checking the gate'));
  try {
    S.session = await get('/staff/session');
  } catch (e) {
    mount(h('main', { class: 'st' }, empty('Could not reach the staff panel', (e && e.message) || '', btn('Try again', { kind: 'w', on: boot }))));
    return;
  }
  if (S.session.user) { startClock(new Date(S.session.user.idle_ends_at).getTime()); home(); } else signIn();
}

/* ---------- the idle clock ---------- */

function startClock(ends) {
  stopClock();
  S.idleEnds = ends;
  S.tick = setInterval(paintClock, 1000);
  // Re-read the session each minute without counting as activity: the server's clock wins.
  S.sync = setInterval(async () => {
    try {
      const s = await get('/staff/session');
      if (!s.user) { stopClock(); toast('The staff session ended', true); S.session = s; signIn(); return; }
      S.idleEnds = new Date(s.user.idle_ends_at).getTime();
    } catch { /* offline: the local clock still locks */ }
  }, 60_000);
}

function stopClock() { clearInterval(S.tick); clearInterval(S.sync); S.tick = S.sync = null; }

function paintClock() {
  const left = Math.max(0, S.idleEnds - Date.now());
  const el = document.getElementById('st-clock');
  if (el) {
    const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
    el.lastChild.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('soon', left < 60_000);
    el.setAttribute('aria-label', `Locks in ${m} minutes ${s} seconds unless you use the panel`);
  }
  if (left === 0) lock('idle');
}

async function lock(why) {
  stopClock();
  try { await post('/staff/lock', { why }); } catch { /* the server ends it on its own clock anyway */ }
  S.session = { ...(S.session || {}), user: null };
  toast(why === 'idle' ? 'Locked after ' + ((S.session && S.session.idle_minutes) || 15) + ' minutes idle' : 'Locked');
  await boot();
}

/* ---------- signed out: passkey, or first-time setup with a code ---------- */

function signIn() {
  const s = S.session;
  if (s.gate === 'access' && s.listed === false) {
    mount(h('main', { class: 'st' }, bar(),
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
  mount(h('main', { class: 'st' }, bar(),
    h('div', { class: 'st-main' },
      h('div', { class: 'st-card st-hero mt' }, h('div', { class: 'passkey-art' }, icon('lock', 'lg')),
        h('h1', null, 'Staff panel'),
        h('p', { class: 'mute' }, 'Open it with your staff passkey. It is a different passkey from the one you use on Community, and works only here.'),
        h('div', { class: 'mt' }, open), msg,
        first ? null : h('p', { class: 'linkrow' }, more)),
      setup)));
}

function setupForm() {
  const code = h('input', { class: 'codein', maxlength: '9', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', aria: { describedby: 'st-code-hint' } });
  const msg = h('p', { class: 'err', role: 'alert' });
  const go = btn('Make my staff passkey', { block: true, type: 'submit', icon: 'finger' });
  const form = h('form', { class: 'st-card', id: 'st-setup', novalidate: true },
    h('h2', null, 'First time here'),
    h('p', { class: 'mute' }, 'On Community, open Settings, then Staff passkey, and make a setup code. Type it here.'),
    h('div', { class: 'mt' }, field('Setup code', code)),
    h('p', { class: 'hint', id: 'st-code-hint' }, icon('clock', 'sm'), 'A code works once, for 10 minutes, and only for the person whose address the gate let in.'),
    msg, h('div', { class: 'mt' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.textContent = '';
    const c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 8) { msg.textContent = 'The code has 8 letters and numbers.'; code.focus(); return; }
    if (!window.PublicKeyCredential) { msg.textContent = NO_PASSKEY; return; }
    go.disabled = true;
    try {
      const o = await post('/staff/enroll/options', { code: c });
      const cred = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(o.options) });
      if (!cred) throw new Error('No passkey was made');
      await post('/staff/enroll/verify', { challengeId: o.challengeId, response: credentialToJSON(cred), code: c });
      toast('Staff passkey made');
      await boot();
    } catch (x) {
      msg.textContent = x && x.name === 'NotAllowedError' ? 'The passkey was cancelled or timed out. Try again.' : ((x && x.message) || 'Could not make the passkey');
    } finally { go.disabled = false; }
  });
  return form;
}

/* ---------- signed in ---------- */

function bar() {
  const u = S.session && S.session.user;
  return h('header', { class: 'st-bar' },
    h('span', { class: 'name' }, 'Community'), h('span', { class: 'tag y' }, 'Staff'),
    u ? h('span', { class: 'who grow' }, '@' + u.handle) : h('span', { class: 'grow' }),
    u ? h('span', { class: 'st-clock', id: 'st-clock', role: 'timer' }, icon('clock', 'sm'), h('span', null, '--:--')) : null,
    u ? btn('Lock', { sm: true, icon: 'lock', on: () => lock('button') }) : null);
}

function home() {
  const u = S.session.user;
  const has = (s) => u.scopes.includes(s);
  const pub = S.session.public_origin;
  // Until the panels move here (0.10.0), the tools for these scopes are on Community itself.
  const tools = [
    has('reports.review') && ['flag', 'Moderator queue', 'Reports and appeals', '/mod'],
    has('invites.send') && ['mail', 'Invite by email', 'Send a staff or member invite', '/me/invite'],
  ].filter(Boolean);
  const node = h('main', { class: 'st' }, bar(),
    h('div', { class: 'st-main' },
      h('div', { class: 'st-card mt' },
        h('div', { class: 'st-role' }, h('div', { class: 'st-badge' }, icon('shield', 'lg')),
          h('div', { class: 'grow' }, h('p', { class: 'mono mute' }, 'Your role'), h('h1', { class: 'big' }, u.role), h('p', { class: 'mute' }, '@' + u.handle))),
        h('p', { class: 'mono mute mt' }, 'What it allows'),
        h('div', { class: 'st-scopes' }, u.scopes.map((s) => h('span', { class: 'tag' }, s)))),
      tools.length && pub ? h('div', null, h('h2', { class: 'sect' }, 'Your tools on Community'),
        h('div', { class: 'group st-links' }, tools.map(([ic, t, sub, path]) => h('a', { class: 'li', href: pub + path, rel: 'noopener' },
          icon(ic), h('div', { class: 'grow' }, h('div', { class: 't1' }, t), h('div', { class: 't2' }, sub)), icon('chev', 'sm'))))) : null,
      has('audit.read') ? auditLog() : h('div', { class: 'st-card' }, h('h2', null, 'Everything here is logged'),
        h('p', { class: 'mute' }, 'Signing in, locking and every staff action go in the staff audit log, which no one can change or delete. Overseers read it.'))));
  mount(node);
  paintClock();
}

/* ---------- the audit log ---------- */

function auditLog() {
  const f = { who: '', kind: '', q: '' };
  const list = h('div', { class: 'st-log', aria: { live: 'polite' } });
  const asof = h('p', { class: 'asof pad' });
  const more = h('div', { class: 'st-more' });
  let last = null, seq = 0;

  async function load(reset) {
    const n = ++seq;
    if (reset) { last = null; list.replaceChildren(loading('Reading the log')); more.replaceChildren(); }
    try {
      const r = await call(() => get('/staff/audit' + qs({ who: f.who, kind: f.kind, q: f.q, before: last || undefined })));
      if (n !== seq) return; // a newer filter won
      if (reset) list.replaceChildren();
      for (const e of r.entries) list.append(entry(e));
      if (reset && !r.entries.length) list.append(empty('Nothing matches', f.who || f.kind || f.q ? 'Try fewer filters.' : 'No staff actions yet.'));
      last = r.entries.length ? r.entries[r.entries.length - 1].at : last;
      asof.textContent = 'As of ' + fullTime(r.as_of);
      more.replaceChildren(r.entries.length >= 20 ? btn('Older entries', { kind: 'w', sm: true, on: () => load(false) }) : '');
    } catch (e) {
      if (n === seq) list.replaceChildren(empty('Could not read the log', e.message, btn('Try again', { kind: 'w', sm: true, on: () => load(true) })));
    }
  }

  let timer = null;
  const typed = (key) => (e) => { f[key] = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(() => load(true), 300); };
  const who = h('input', { maxlength: '31', placeholder: 'username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', on: { input: typed('who') } });
  const q = h('input', { maxlength: '80', placeholder: 'words in the entry', autocomplete: 'off', on: { input: typed('q') } });
  const kinds = [['', 'All'], ...Object.entries(KIND_LABEL)];
  const node = h('section', { aria: { label: 'Staff audit log' } },
    h('h2', { class: 'sect' }, 'Staff audit log'),
    h('div', { class: 'st-filters' },
      choiceChips(kinds, '', (v) => { f.kind = v; load(true); }, 'Kind of entry'),
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, field('Who', who)), h('div', { class: 'grow' }, field('Search', q)))),
    list, more, asof);
  load(true);
  return node;
}

function entry(e) {
  return h('article', { class: 'st-entry' },
    h('p', { class: 'what' }, h('b', null, '@' + e.who), ' ', e.text, e.subject ? [' · ', h('b', null, '@' + e.subject)] : null),
    h('div', { class: 'meta' }, h('span', { class: 'tag' }, KIND_LABEL[e.kind] || e.kind), h('time', { datetime: e.at, title: fullTime(e.at) }, timeAgo(e.at) + ' · ' + fullTime(e.at))));
}

boot();
