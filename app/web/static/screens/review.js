// Live site review roulette. /review: anyone sends their website for the PopCart Community live, one
// entry per live, after agreeing to every consent point and typing their name as a signature.
// /review/host (staff): the round, the wheel and the queue, made to be shown on the live. H hides the
// controls. The server draws the pick; the wheel only lands on it.
import { h, icon } from '../lib/dom.js';
import { del, get, patch, post } from '../lib/api.js';
import { asOf, fullTime } from '../lib/format.js';
import { brandName, popMark } from '../lib/brand.js';
import { state } from '../core.js';
import { btn, empty, errorBox, fail, field, loading, sheet, toast } from '../ui.js';

const CONTACT = 'support.popcart@gmail.com';
const HANDLE = '@popcartphl';

/**
 * The version of the consent text on this page (TERMS, dataTerms, CONSENTS). An entry sends this,
 * never the server's, so it records the text the person actually read. Raise it with the server's
 * CONSENT_VERSION (app/modules/review/routes.ts) whenever the text changes.
 */
export const CONSENT_VERSION = '2026-10-22';
/** Days an entry is kept: part of the consent text, so fixed here with it (a test holds it equal to the server's). */
export const KEEP_DAYS = 90;

/** The consent points, keyed as the server checks them (app/modules/review/routes.ts, CONSENTS). */
export const CONSENTS = [
  ['shown', 'I agree to have my website shown and reviewed live, including critical feedback.'],
  ['recorded', 'I agree the live and clips of my website may be recorded and published.'],
  ['owner', 'I own this website or have permission to submit it.'],
  ['clean', 'It has no malware, phishing, adult or illegal content, and no private data I don\'t want shown.'],
  ['draw', 'I understand a random draw decides who is reviewed, and entries can be skipped.'],
  ['data', 'I have read how my data is stored and how to withdraw.'],
];

const TERMS = [
  ['What happens.', 'If the roulette picks your entry, the PopCart Community host opens your website live on the PopCart Community stream and gives an honest review of its design, copy, speed and usability. Feedback may be critical. It is an opinion for learning, not professional, legal or security advice.'],
  ['Recording.', 'The live may be recorded, and the recording, clips and screenshots of your website may be published on PopCart\'s social pages (' + HANDLE + ') indefinitely.'],
  ['Your site, your responsibility.', 'You confirm you own the website or have permission to submit it, and that it contains no malware, phishing, adult, hateful or illegal content and no private personal data (yours or anyone else\'s) you would not want shown publicly. Entries that break this are removed without review.'],
  ['Safety.', 'The host opens sites in a separate browser kept only for reviews, never the one they use day to day. Do not submit links that try to download files, ask for logins or ask for payment.'],
  ['No guarantee.', 'Sending your site does not guarantee a review. Staff check every entry before it joins the wheel, a random draw decides who is picked, and the host may skip any entry. No payment is asked for or offered.'],
];

const dataTerms = (days) => ['Your data.', `We store the link, the name and handle you give, your typed signature and the time you agreed. To hold one entry per browser, this page keeps a random code in one essential cookie, and we keep a keyed hash of that code and of your internet address, both cleared when the next round starts. Nothing is sold. Entries are deleted after ${days} days. To withdraw or delete your entry at any time, email ${CONTACT} with "Review" in the subject. Withdrawing cannot undo a live that already happened or clips already published.`];

function check(label, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'agree' }, input, h('span', { class: 'box', aria: { hidden: 'true' } }, icon('check', 'sm b')), h('span', null, label));
}

const statusPill = (st) => {
  const open = !!(st && st.round && st.round.accepting);
  return h('span', { class: ['rvpill', open ? 'on' : ''] }, h('i', { aria: { hidden: 'true' } }), open ? 'Open now · ' + st.round.code : 'Closed until next live');
};

/* ---------- /review: send your site ---------- */

export function review() {
  const d = { url: '', name: '', handle: '', signature: '', consents: {} };
  let st = null;
  let timer = 0;
  // the consent text changed while this page was open: only a reload shows the new text
  let stale = false;
  let sending = false;
  const node = h('div', { class: 'rv' }, loading());
  const pillSlot = h('div', { class: 'rvtop-r' });
  const submit = btn('Enter the roulette', { block: true, type: 'submit', disabled: true, icon: 'send' });
  const why = h('p', { class: 'hint rvwhy', aria: { live: 'polite' } });
  const msg = h('p', { class: 'err', role: 'alert' });
  const sigLine = h('div', { class: 'rvsig' });

  const ready = () => d.url.trim() && d.name.trim() && d.signature.trim().length >= 2 && CONSENTS.every(([k]) => d.consents[k]);
  const update = () => {
    const open = !!(st && st.round && st.round.accepting);
    submit.disabled = sending || stale || !open || !ready() || (st && st.entered);
    why.textContent = stale ? 'The consent text has changed. Reload the page and read it again.'
      : st && st.entered ? 'This browser already has an entry in this round. One entry per live.'
      : !open ? 'Entries open when the live starts. Follow ' + HANDLE + ' on TikTok to know when.'
        : !ready() ? 'Fill in your site and name, agree to every point and sign to enter.' : '';
    const s = d.signature.trim();
    sigLine.replaceChildren(...(s.length >= 2
      ? [h('span', { class: 'rvsig-name' }, s), h('span', { class: 'mono' }, 'Signed ' + fullTime(new Date().toISOString()))]
      : [h('span', { class: 'mono mute' }, 'Not signed')]));
  };

  const input = (key, attrs) => {
    const el = h('input', { ...attrs, value: d[key] });
    el.addEventListener('input', () => { d[key] = el.value; update(); });
    return el;
  };

  const steps = h('ol', { class: 'rvsteps', aria: { label: 'How it works' } },
    [['01', 'Drop your link'], ['02', 'Sign the consent'], ['03', 'The wheel picks']].map(([n, t]) => h('li', null, h('b', null, n), h('span', null, t))));

  function form() {
    return h('form', { class: 'rvform', novalidate: true, on: { submit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      msg.textContent = '';
      sending = true;
      submit.disabled = true;
      try {
        const r = await post('/review/entries', { url: d.url, name: d.name, handle: d.handle, signature: d.signature, consents: d.consents, consent_version: CONSENT_VERSION });
        clearInterval(timer);
        done(r.entry);
      } catch (err) {
        msg.textContent = err.message;
        if (err.code === 'consent_changed') stale = true;
        else if (err.code === 'closed' || err.code === 'already_entered') refresh();
        sending = false;
        update();
      }
    } } },
    h('section', { class: 'rvcard', aria: { labelledby: 'rv-site' } },
      h('h2', { id: 'rv-site' }, 'Your site'),
      field('Website link', input('url', { type: 'url', inputmode: 'url', autocomplete: 'url', placeholder: 'https://yourname.com', maxlength: 300, required: true })),
      field('Name we read out', input('name', { type: 'text', autocomplete: 'nickname', maxlength: 60, required: true })),
      field('Chat handle · optional', input('handle', { type: 'text', autocomplete: 'off', placeholder: '@you', maxlength: 40 }))),
    h('section', { class: 'rvcard', aria: { labelledby: 'rv-terms' } },
      h('h2', { id: 'rv-terms' }, 'Disclaimer & consent'),
      h('div', { class: 'rvterms' }, [...TERMS, dataTerms(KEEP_DAYS)].map(([lead, text]) => h('p', null, h('b', null, lead), ' ', text))),
      h('div', { class: 'rvchecks', role: 'group', aria: { label: 'Consent' } }, CONSENTS.map(([k, label]) => check(label, (v) => { d.consents[k] = v; update(); })))),
    h('section', { class: 'rvcard', aria: { labelledby: 'rv-sign' } },
      h('h2', { id: 'rv-sign' }, 'Sign'),
      field('Type your full name as your signature', input('signature', { type: 'text', autocomplete: 'name', maxlength: 80, required: true })),
      sigLine),
    h('div', { class: 'rvgo' }, submit, why, msg));
  }

  function done(entry) {
    node.replaceChildren(top(), h('section', { class: 'rvdone', role: 'status' },
      h('p', { class: 'mono' }, 'Entry in · ' + entry.round),
      h('h1', { class: 'x', tabindex: '-1' }, 'You\'re in.'),
      h('p', { class: 'lede' }, 'Watch the live on TikTok, ' + HANDLE + '. If the wheel picks you, we open your site on stream.'),
      h('dl', { class: 'rvsum' },
        h('dt', null, 'Site'), h('dd', null, entry.url),
        h('dt', null, 'Name we read out'), h('dd', null, entry.name),
        entry.handle ? [h('dt', null, 'Chat handle'), h('dd', null, entry.handle)] : null,
        h('dt', null, 'Agreed'), h('dd', null, fullTime(entry.consented_at))),
      h('p', { class: 'hint' }, icon('info', 'sm'), h('span', null, 'Changed your mind? Email ' + CONTACT + ' with "Review" in the subject and we delete your entry. Staff check every entry before it joins the wheel.')),
      btn('Join the Community', { kind: 'w', href: '/' })));
    node.querySelector('h1').focus();
  }

  const top = () => h('header', { class: 'rvtop' }, h('a', { href: '/', class: 'rvbrand', aria: { label: 'Community home' } }, brandName('m')), pillSlot);

  function paint() {
    pillSlot.replaceChildren(statusPill(st));
    node.replaceChildren(top(),
      h('section', { class: 'rvhero' },
        h('p', { class: 'mono' }, 'Live site review'),
        h('h1', { class: 'x', tabindex: '-1' }, 'Get your site reviewed live.'),
        h('p', { class: 'lede' }, 'Roulette · one entry per live. Staff check it, the wheel picks, we open your site on the PopCart Community live and review it honestly.'),
        steps),
      form(),
      h('footer', { class: 'rvfoot' }, 'This page sets one essential cookie, so each browser enters once per live. Its fonts are served by Community itself. Questions: ' + CONTACT + '.'));
    update();
  }

  async function refresh() {
    try {
      const first = !st;
      st = await get('/review');
      if (st.consent_version !== CONSENT_VERSION) stale = true;
      if (first) paint(); else { pillSlot.replaceChildren(statusPill(st)); update(); }
    } catch (e) {
      if (!st) node.replaceChildren(errorBox(e, refresh));
    }
  }

  refresh();
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
  return { node, bare: true, cls: 'bare-review', title: 'Live site review', cleanup: () => clearInterval(timer) };
}

/* ---------- the wheel ---------- */

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  el.append(...kids.flat().filter(Boolean));
  return el;
};
const CX = 200, CY = 220, R = 186;
const pt = (deg, r) => [CX + r * Math.sin(deg * Math.PI / 180), CY - r * Math.cos(deg * Math.PI / 180)];
const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Where the wheel stops so `index` of `n` sits under the pointer, at least `turns` full turns on. Pure. */
export function landing(from, index, n, turns = 6, jitter = 0) {
  const seg = 360 / n;
  const want = index * seg + seg / 2 + jitter * seg * 0.35;
  const delta = (((-want - from) % 360) + 360) % 360;
  return from + turns * 360 + delta;
}

function wheel() {
  let angle = 0;
  const spin = s('g', { class: 'rwspin' });
  const svg = s('svg', { class: 'rw', viewBox: '0 0 400 420', role: 'img', 'aria-label': 'The review wheel' },
    s('circle', { cx: CX, cy: CY + 6, r: R + 8, class: 'rwlift' }),
    spin,
    s('circle', { cx: CX, cy: CY, r: R + 8, class: 'rwrim' }),
    s('circle', { cx: CX, cy: CY, r: 44, class: 'rwhub' }),
    s('path', { d: `M${CX - 22} 2H${CX + 22}L${CX} 48Z`, class: 'rwptr' }));
  const mark = popMark('rwmark');
  if (mark) { for (const [k, v] of Object.entries({ x: CX - 26, y: CY - 26, width: 52, height: 52 })) mark.setAttribute(k, String(v)); svg.append(mark); }
  const set = (a) => { angle = a; spin.setAttribute('transform', `rotate(${a % 360} ${CX} ${CY})`); };

  function draw(items, winId) {
    const n = items.length;
    svg.setAttribute('aria-label', n ? `The review wheel, ${n} ${n === 1 ? 'site' : 'sites'} in the draw` : 'The review wheel, empty');
    if (!n) { spin.replaceChildren(s('circle', { cx: CX, cy: CY, r: R, class: 'rwseg rwempty' })); return; }
    // six colours round the wheel; the last segment never matches the first it touches
    const col = (i) => (i === n - 1 && i > 0 && i % 6 === 0 ? 2 : i % 6);
    const seg = 360 / n, size = n > 24 ? 11 : n > 12 ? 13 : 16, max = n > 24 ? 11 : 13;
    spin.replaceChildren(...items.map((it, i) => {
      const a0 = i * seg, a1 = a0 + seg, mid = a0 + seg / 2;
      const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
      const shape = n === 1 ? s('circle', { cx: CX, cy: CY, r: R, class: 'rwseg sg' + col(i) })
        : s('path', { d: `M${CX} ${CY}L${x0} ${y0}A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${x1} ${y1}Z`, class: 'rwseg sg' + col(i) });
      const [tx, ty] = pt(mid, R - 18);
      const label = s('text', { x: tx, y: ty, class: 'rwtx tx' + col(i), 'font-size': size, 'text-anchor': 'end', 'dominant-baseline': 'central', transform: `rotate(${mid - 90} ${tx} ${ty})` });
      label.textContent = short(it.name, max);
      return s('g', { class: it.id === winId ? 'rwwin' : null }, shape, n <= 60 ? label : null);
    }));
  }

  let stopped = false;
  /** Spin to `index`; resolves when it stops. Reduced motion: jump there. */
  function spinTo(index, n) {
    const to = landing(angle, index, n, 6, Math.random() * 2 - 1);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { set(to); return Promise.resolve(); }
    const from = angle, ms = 5200, t0 = performance.now();
    // fast out, long slow settle, no overshoot: the pointer never passes the pick and swings back
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    return new Promise((ok) => {
      const step = (now) => {
        if (stopped) { ok(); return; }
        const t = Math.min(1, (now - t0) / ms);
        set(from + (to - from) * ease(t));
        if (t < 1) requestAnimationFrame(step); else { set(to); ok(); }
      };
      requestAnimationFrame(step);
    });
  }
  return { svg, draw, spinTo, stop: () => { stopped = true; } };
}

/* ---------- /review/host: the round, the wheel, the queue (staff) ---------- */

function confirmSheet(title, text, action, run) {
  sheet(title, (close) => h('div', { class: 'sheetbody' }, h('h2', null, title), h('p', { class: 'mute' }, text),
    h('div', { class: 'row wrap' }, btn(action, { kind: 'e', on: async () => { close(); await run(); } }), btn('Cancel', { kind: 'w', on: close }))));
}

const STATUS_LABEL = { pending: 'To check', waiting: 'In the draw', picked: 'Up now', reviewed: 'Reviewed', skipped: 'Skipped' };

export function reviewHost() {
  if (!state.me) return { node: errorBox({ status: 401 }), bare: true, title: 'Review host' };
  if (state.me.role !== 'staff') return { node: empty('Staff only', 'The review host screen is for Community staff.', btn('Send a site instead', { href: '/review' })), bare: true, title: 'Review host' };

  let view = null, drawn = null, spinning = false, offline = false, timer = 0, hidden = false;
  const w = wheel();
  const live = h('p', { class: 'rhlive', aria: { live: 'assertive' } });
  const roundLine = h('div', { class: 'rhround' });
  const ctl = h('div', { class: 'rhctl ctl' });
  // Spin stays in stream mode: drawing must never need the controls (and the To check list) on screen
  const spinBtn = btn('Spin', { kind: 'y', icon: 'star', cls: 'rhspin' });
  const next = h('section', { class: 'rhnext', aria: { label: 'Up next' } });
  const queue = h('section', { class: 'rhq', aria: { label: 'Entries' } });
  // entries no one has checked yet: only with the controls, so they never reach the stream unchecked
  const check = h('section', { class: 'rhq rhcheck ctl', aria: { label: 'To check' } });
  // a withdrawal can come after its round: find the entry in any round (staff, controls only)
  const findIn = h('input', { type: 'search', placeholder: 'Name, handle or site', maxlength: 100, aria: { label: 'Find an entry in any round' } });
  const found = h('ol');
  const find = h('section', { class: 'rhq rhfind ctl', aria: { label: 'Find an entry' } }, h('h2', { class: 'mono' }, 'Withdraw an entry · any round'),
    h('form', { class: 'row', on: { submit: (e) => { e.preventDefault(); search(); } } }, h('div', { class: 'field grow' }, findIn), btn('Find', { sm: true, kind: 'w', type: 'submit' })), found);
  const off = h('p', { class: 'rhoff', role: 'status', hidden: true });
  const share = location.host + '/review';
  const node = h('div', { class: 'rh' },
    h('header', { class: 'rhtop' }, h('div', { class: 'rhbrand' }, brandName('m')), roundLine),
    ctl,
    h('div', { class: 'rhbody' },
      h('div', { class: 'rhwheel' }, w.svg, spinBtn, live),
      h('div', { class: 'rhside' }, next, check, queue, find)),
    off,
    h('footer', { class: 'rhfoot' }, h('span', null, 'Send your site: ', h('b', null, share)), h('span', { class: 'ctl' }, ' · H hides controls')));

  const copy = async (url) => {
    try { await navigator.clipboard.writeText(url); toast('Link copied. Open it in the review browser.'); } catch { toast('Could not copy: ' + url, true); }
  };
  let busy = false;
  const act = (fn) => async () => {
    if (busy) return;
    busy = true;
    ctl.classList.add('busy');
    try { apply(await fn()); } catch (e) { fail(e); } finally { busy = false; ctl.classList.remove('busy'); }
  };
  const setOpen = (v) => act(() => patch('/review/rounds/current', { accepting: v }))();
  const newRound = act(() => post('/review/rounds'));
  const mark = (id, status) => act(() => patch('/review/entries/' + id, { status }))();
  const remove = (e) => confirmSheet('Remove this entry?', `${e.name} (${e.url}) is deleted for good. Use this when it breaks the rules or the person asked to withdraw.`, 'Remove', async () => {
    try { await del('/review/entries/' + e.id); toast('Entry removed'); await refresh(); if (findIn.value.trim().length >= 2) await search(); } catch (err) { fail(err); }
  });
  async function search() {
    const q = findIn.value.trim();
    if (q.length < 2) { found.replaceChildren(); return; }
    try {
      const r = await get('/review/entries', { q });
      found.replaceChildren(...(r.entries.length ? r.entries.map((e) => h('li', { class: 'rhqi' },
        h('div', { class: 'grow' }, h('div', { class: 'rhqn' }, e.name, e.handle ? h('span', { class: 'mute' }, ' ' + e.handle) : null), h('div', { class: 'rhqu' }, e.url + ' · ' + e.round)),
        h('button', { class: 'ib', type: 'button', aria: { label: 'Remove ' + e.name }, on: { click: () => remove(e) } }, icon('trash', 'sm b'))))
        : [h('li', { class: 'rhwait' }, 'No entry matches.')]));
    } catch (e) { fail(e); }
  }

  spinBtn.addEventListener('click', async () => {
    if (spinning) return;
    spinning = true;
    spinBtn.disabled = true;
    live.textContent = 'Spinning…';
    try {
      const r = await post('/review/spin');
      drawn = { pool: r.pool, picked: r.picked };
      w.draw(r.pool);
      await w.spinTo(r.pool.findIndex((p) => p.id === r.picked), r.pool.length);
      spinning = false;
      apply(r);
      const e = r.entries.find((x) => x.id === r.picked);
      live.textContent = e ? 'Up next: ' + e.name : '';
    } catch (e) {
      spinning = false;
      live.textContent = (e && e.message) || 'Could not spin';
      fail(e);
      paint();
    }
  });

  function paint() {
    const v = view;
    const round = v && v.round;
    const entries = (v && v.entries) || [];
    const waiting = entries.filter((e) => e.status === 'waiting');
    const picked = entries.find((e) => e.status === 'picked');
    roundLine.replaceChildren(...(round
      ? [h('span', { class: 'mono' }, round.code + ' · ' + (round.accepting ? 'entries open' : 'entries closed')), h('span', { class: 'mono rhcount' }, v.counts.in + ' in · ' + v.counts.left + ' left'),
        v.counts.to_check ? h('span', { class: 'mono rhcount ctl' }, v.counts.to_check + ' to check') : null].filter(Boolean)
      : [h('span', { class: 'mono' }, 'No round yet')]));
    ctl.replaceChildren(
      btn('Open entries', { sm: true, kind: round && round.accepting ? 'w' : 'y', disabled: !round || round.accepting, on: () => setOpen(true) }),
      btn('Close entries', { sm: true, kind: 'w', disabled: !round || !round.accepting, on: () => setOpen(false) }),
      btn('New round', { sm: true, kind: 'w', on: () => (entries.length ? confirmSheet('Start a new round?', 'The wheel empties and entries stay closed until you open them. This round\'s entries are kept until they are 90 days old.', 'New round', newRound) : newRound()) }),
      ...(v ? [h('span', { class: 'mono rhasof' }, asOf(v.as_of))] : []));
    // after a draw the wheel keeps the pool it spun, with the pick marked, until that site is done
    if (!spinning) { if (picked && drawn && drawn.picked === picked.id) w.draw(drawn.pool, picked.id); else w.draw(waiting); }
    spinBtn.disabled = spinning || !!picked || !waiting.length;

    next.replaceChildren(h('h2', { class: 'mono' }, 'Up next'), picked
      ? h('div', { class: 'rhpick' },
        h('div', { class: 'rhname' }, picked.name),
        h('div', { class: 'rhurl' }, picked.url),
        picked.handle ? h('div', { class: 'mono' }, picked.handle) : null,
        h('div', { class: 'row wrap ctl' },
          // copied, not opened here: this browser is signed in to the host screen; sites go in the review browser
          btn('Copy link', { sm: true, kind: 'y', icon: 'link', on: () => copy(picked.url) }),
          btn('Reviewed', { sm: true, icon: 'check', on: () => mark(picked.id, 'reviewed') }),
          btn('Skip', { sm: true, kind: 'w', on: () => mark(picked.id, 'skipped') }),
          btn('Back in the draw', { sm: true, kind: 'w', on: () => mark(picked.id, 'waiting') })))
      : h('p', { class: 'rhwait' }, !v ? 'Loading…' : waiting.length ? 'Spin the wheel.' : round && round.accepting ? 'Waiting for entries.' : 'Open entries to start.'));

    const pending = entries.filter((e) => e.status === 'pending');
    const shown = entries.filter((e) => e.status !== 'pending');
    check.hidden = !pending.length;
    check.replaceChildren(h('h2', { class: 'mono' }, 'To check · ' + pending.length), h('ol', null, pending.map((e) => h('li', { class: 'rhqi' },
      h('div', { class: 'grow' }, h('div', { class: 'rhqn' }, e.name, e.handle ? h('span', { class: 'mute' }, ' ' + e.handle) : null), h('div', { class: 'rhqu' }, e.url)),
      btn('Let in', { sm: true, icon: 'check', on: () => mark(e.id, 'waiting') }),
      h('button', { class: 'ib', type: 'button', aria: { label: 'Remove ' + e.name }, on: { click: () => remove(e) } }, icon('trash', 'sm b'))))));

    queue.replaceChildren(h('h2', { class: 'mono' }, 'Queue'), shown.length
      ? h('ol', null, shown.map((e) => h('li', { class: ['rhqi', 'st-' + e.status] },
        h('div', { class: 'grow' }, h('div', { class: 'rhqn' }, e.name, e.handle ? h('span', { class: 'mute' }, ' ' + e.handle) : null), h('div', { class: 'rhqu' }, e.url)),
        h('span', { class: 'tag' }, STATUS_LABEL[e.status] || e.status),
        h('span', { class: 'ctl row' },
          e.status === 'reviewed' || e.status === 'skipped' ? h('button', { class: 'ib', type: 'button', aria: { label: 'Back in the draw: ' + e.name }, on: { click: () => mark(e.id, 'waiting') } }, icon('back', 'sm b')) : null,
          h('button', { class: 'ib', type: 'button', aria: { label: 'Remove ' + e.name }, on: { click: () => remove(e) } }, icon('trash', 'sm b'))))))
      : h('p', { class: 'rhwait' }, pending.length ? 'Let entries in once you have checked them.' : 'No entries yet. Share ' + share + '.'));
  }

  function apply(v) {
    view = v;
    paint();
  }

  async function refresh() {
    try {
      const v = await get('/review/host');
      if (offline) { offline = false; off.hidden = true; }
      if (!spinning) apply(v);
    } catch (e) {
      // the layout stays: the next poll that works fills it in
      offline = true;
      off.textContent = (view ? 'Queue offline. ' : 'Could not load the queue: ' + ((e && e.message) || 'error') + '. ') + 'Retrying…';
      off.hidden = false;
    }
  }

  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable], dialog')) return;
    if ((e.key === 'h' || e.key === 'H') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      hidden = !hidden;
      node.classList.toggle('noctl', hidden);
      document.body.classList.toggle('streaming', hidden);
      // no toast while hidden: that is what the stream sees
      if (!hidden) toast('Controls shown');
    }
  };
  document.addEventListener('keydown', onKey);
  paint();
  refresh();
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
  return { node, bare: true, cls: 'bare-host', title: 'Review host', cleanup: () => { clearInterval(timer); w.stop(); document.removeEventListener('keydown', onKey); } };
}
