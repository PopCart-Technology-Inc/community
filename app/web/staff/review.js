// The live review host (scope review.host): the round, the wheel and the queue, made to be shown on the
// PopCart Community live. H hides the controls and the panel around them (stream mode). The server
// draws the pick; the wheel only lands on it. Entries come from the public page, /review.
import { h, icon } from '/static/lib/dom.js';
import { asOf } from '/static/lib/format.js';
import { brandName, popMark } from '/static/lib/brand.js';
import { btn, fail, sheet, toast } from '/static/ui.js';
import { enc, S, sdel, sget, spatch, spost } from './core.js';

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

/* ---------- the host screen ---------- */

function confirmSheet(title, text, action, run) {
  sheet(title, (close) => h('div', { class: 'sheetbody' }, h('h2', null, title), h('p', { class: 'mute' }, text),
    h('div', { class: 'row wrap' }, btn(action, { kind: 'e', on: async () => { close(); await run(); } }), btn('Cancel', { kind: 'w', on: close }))));
}

const STATUS_LABEL = { pending: 'To check', waiting: 'In the draw', picked: 'Up now', reviewed: 'Reviewed', skipped: 'Skipped' };

export function liveReview() {

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
  const share = (S.session && S.session.public_origin ? new URL(S.session.public_origin).host : location.host) + '/review';
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
  // every view request is numbered; one that comes back after a newer one was shown is dropped
  let asked = 0, shownSeq = 0;
  const fresh = (n, v) => { if (n > shownSeq) { shownSeq = n; apply(v); } };
  let busy = false;
  const act = (fn) => async () => {
    if (busy) return;
    busy = true;
    ctl.classList.add('busy');
    const n = ++asked;
    try { fresh(n, await fn()); } catch (e) { fail(e); } finally { busy = false; ctl.classList.remove('busy'); }
  };
  const setOpen = (v) => act(() => spatch('/staff/review/rounds/current', { accepting: v }))();
  const newRound = act(() => spost('/staff/review/rounds'));
  const mark = (id, status) => act(() => spatch('/staff/review/entries/' + enc(id), { status }))();
  const remove = (e) => confirmSheet('Remove this entry?', `${e.name} (${e.url}) is deleted for good. Use this when it breaks the rules or the person asked to withdraw.`, 'Remove', async () => {
    try { await sdel('/staff/review/entries/' + enc(e.id)); toast('Entry removed'); await refresh(); if (findIn.value.trim().length >= 2) await search(); } catch (err) { fail(err); }
  });
  async function search() {
    const q = findIn.value.trim();
    if (q.length < 2) { found.replaceChildren(); return; }
    try {
      const r = await sget('/staff/review/entries', { q });
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
      const n = ++asked;
      const r = await spost('/staff/review/spin');
      drawn = { pool: r.pool, picked: r.picked };
      w.draw(r.pool);
      await w.spinTo(r.pool.findIndex((p) => p.id === r.picked), r.pool.length);
      spinning = false;
      fresh(n, r);
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
        // Copy link, Reviewed and Skip stay in stream mode: finishing a pick must never need the
        // controls (and the To check list) on screen
        h('div', { class: 'row wrap' },
          // copied, not opened here: this browser is signed in to the host screen; sites go in the review browser
          btn('Copy link', { sm: true, kind: 'y', icon: 'link', on: () => copy(picked.url) }),
          btn('Reviewed', { sm: true, icon: 'check', on: () => mark(picked.id, 'reviewed') }),
          btn('Skip', { sm: true, kind: 'w', on: () => mark(picked.id, 'skipped') }),
          h('span', { class: 'ctl' }, btn('Back in the draw', { sm: true, kind: 'w', on: () => mark(picked.id, 'waiting') }))))
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
      const n = ++asked;
      const v = await sget('/staff/review/host');
      if (offline) { offline = false; off.hidden = true; }
      if (!spinning) fresh(n, v);
    } catch (e) {
      // the layout stays: the next poll that works fills it in
      offline = true;
      off.textContent = (view ? 'Queue offline. ' : 'Could not load the queue: ' + ((e && e.message) || 'error') + '. ') + 'Retrying…';
      off.hidden = false;
    }
  }

  // The panel has no cleanup hook: once this screen is gone, the poll and the key stop themselves.
  const gone = () => {
    if (node.isConnected) return false;
    clearInterval(timer);
    w.stop();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('streaming');
    return true;
  };
  const onKey = (e) => {
    if (gone()) return;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable], dialog')) return;
    if ((e.key === 'h' || e.key === 'H') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      hidden = !hidden;
      node.classList.toggle('noctl', hidden);
      // stream mode: the panel's sidebar and top bar go too (staff.css)
      document.body.classList.toggle('streaming', hidden);
      // no toast while hidden: that is what the stream sees
      if (!hidden) toast('Controls shown');
    }
  };
  document.addEventListener('keydown', onKey);
  paint();
  refresh();
  timer = setInterval(() => { if (!gone() && document.visibilityState === 'visible') refresh(); }, 3000);
  return { title: 'Live review', node };
}
