// Open Books (decision 0009): the community's money, in public. Overview, every entry, approvals,
// who was paid, and the proof, with a check anyone can run in this browser. Trustees sign here with a
// key that never leaves the browser. Every number is live from the ledger, with the time it was read.
import { h, icon } from '../lib/dom.js';
import { del, get, post, put } from '../lib/api.js';
import { asOf, plural, timeAgo } from '../lib/format.js';
import { entryHash, hashFile, loadSigningKey, newSigningKey, peso, pesoShort, saveSigningKey, signBody, verifyLedger } from '../lib/ledger.js';
import { nav, state } from '../core.js';
import { appBar, btn, empty, errorBox, fail, field, later, linkTabs, loading, pagedList, sheet, toast, toggle, buttonTabs, choiceChips } from '../ui.js';
import { control, datePicker, dropdown, fileDrop, niceDate, pesoField } from '../controls.js';

export const CATEGORIES = [['donations', 'Donations'], ['grants', 'Grants'], ['ads', 'Ad income'], ['builders', 'Builders'], ['hosting', 'Hosting'],
  ['legal', 'Legal and filings'], ['events', 'Events'], ['community_aid', 'Community aid'], ['bank_fees', 'Bank fees'], ['other', 'Other']];
const PARTIES = [
  ['company', 'A company', 'Named in public'],
  ['person_consented', 'A person who agreed to be named', 'Named in public, with their consent'],
  ['person_private', 'A person, kept private', 'Shown by a stable ID such as C-0012'],
  ['donors', 'Donors, together', 'Money in only'],
  ['related_party', 'A related party', 'Tied to a trustee or staff: two signatures and the reason'],
];
const ago = (iso) => { const t = timeAgo(iso); return t === 'now' ? 'just now' : t + ' ago'; };
const catLabel = (k) => (CATEGORIES.find((c) => c[0] === k) || [k, k])[1];
const partyName = (p) => (p.kind === 'person_private' ? p.ref : p.kind === 'donors' ? 'Donors' : p.name);
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m, long) => { const [y, n] = m.split('-').map(Number); return (long ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][n - 1] + ' ' + y : MON[n - 1]); };

/** Who you are to the books: { trustee, staff, can_draft, key } or a guest. */
let meCache = null;
async function whoAmI(force) {
  if (!state.me) return { trustee: false, staff: false, can_draft: false, key: null };
  if (!meCache || force || meCache.id !== state.me.id) meCache = { id: state.me.id, ...(await get('/books/me')) };
  return meCache;
}

function frame(tab, node, title) {
  const tabs = linkTabs([['Overview', '/books', tab === 'overview'], ['Activity', '/books/activity', tab === 'activity'], ['Approvals', '/books/approvals', tab === 'approvals'],
    ['Payees', '/books/payees', tab === 'payees'], ['Proof', '/books/proof', tab === 'proof']], 'bk-tabs');
  return { node: h('div', null, appBar({ title: 'Open Books', back: '/' }), tabs, h('div', { class: 'bk-page' }, node)), title: title || 'Open Books', cls: 'cream-page' };
}

const kindIcon = (k) => h('span', { class: 'bk-ic ' + k, aria: { hidden: 'true' } }, icon(k === 'in' ? 'arrin' : 'arrout', 'sm b'));
const amountText = (e) => (e.kind === 'in' ? '+' : '−') + peso(e.amount);

function entryRow(e) {
  const tags = e.reversed_by ? h('span', { class: 'tag' }, 'Reversed') : e.reverses ? h('span', { class: 'tag' }, 'Correction') : null;
  return h('a', { class: 'li line bk-row', href: '/books/e/' + e.seq },
    kindIcon(e.kind),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, e.description), h('div', { class: 't2' }, [partyName(e.party), catLabel(e.category), niceDate(e.date)].join(' · '))),
    h('div', { class: 'side' }, h('b', { class: 'amt ' + e.kind + (e.reversed_by ? ' struck' : '') }, amountText(e)), tags || h('span', { class: 'mono' }, '#' + e.seq)));
}

/* ---------- charts (SVG, sized to their box; no inline styles) ---------- */

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
/** A bar with a 4px rounded data end; `up` grows from the baseline, otherwise it grows right. */
function bar(x, y, w, hgt, cls, up = true) {
  if (w <= 0 || hgt <= 0) return null;
  const r = Math.min(4, up ? w / 2 : hgt / 2, up ? hgt : w);
  const d = up ? `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`
    : `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
  return s('path', { d, class: cls });
}
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
/** Draws when the box has a width, and again when it changes. */
function measured(cls, draw) {
  const box = h('div', { class: 'chart ' + cls });
  let w = 0;
  const ro = new ResizeObserver(() => { const nw = Math.floor(box.clientWidth); if (nw && nw !== w) { w = nw; box.replaceChildren(draw(w)); } });
  ro.observe(box);
  return box;
}

function cashChart(months) {
  return measured('cash', (W) => {
    const H = 210, L = 46, R = 6, T = 14, B = 26;
    const max = niceMax(Math.max(...months.flatMap((m) => [m.in, m.out])));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const gw = (W - L - R) / months.length, bw = Math.max(3, Math.min(12, (gw - 8) / 2));
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'cash-svg',
      'aria-label': 'Money in and out by month, last 12 months. The table view lists every value.' });
    for (const f of [0, 0.5, 1]) {
      svg.append(s('line', { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f), class: f ? 'grid' : 'base' }),
        s('text', { x: L - 8, y: y(max * f) + 4, class: 'axis', 'text-anchor': 'end' }, pesoShort(max * f)));
    }
    const hl = s('rect', { class: 'hl', y: T - 6, height: H - T - B + 6, width: gw, rx: 8, visibility: 'hidden' });
    svg.append(hl);
    months.forEach((m, i) => {
      const cx = L + gw * i + gw / 2;
      // an empty month has no bar (append would print a null as text)
      svg.append(...[bar(cx - bw - 1, y(m.in), bw, y(0) - y(m.in), 'b-in'), bar(cx + 1, y(m.out), bw, y(0) - y(m.out), 'b-out')].filter(Boolean));
      if (gw >= 30 || i % 2 === months.length % 2) svg.append(s('text', { x: cx, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, monthName(m.month)));
    });
    const tip = s('g', { class: 'tip', visibility: 'hidden' });
    const tipBox = s('rect', { width: 150, height: 62, rx: 10 }), t1 = s('text', { x: 12, y: 20, class: 'tt' }), t2 = s('text', { x: 12, y: 38 }), t3 = s('text', { x: 12, y: 54 });
    tip.append(tipBox, t1, t2, t3);
    months.forEach((m, i) => {
      const hit = s('rect', { x: L + gw * i, y: 0, width: gw, height: H, class: 'hit' });
      hit.addEventListener('pointerenter', () => {
        hl.setAttribute('x', L + gw * i); hl.setAttribute('visibility', 'visible');
        t1.textContent = monthName(m.month, true); t2.textContent = 'In  ' + peso(m.in); t3.textContent = 'Out  ' + peso(m.out);
        const x = Math.min(W - 154, Math.max(2, L + gw * i + gw / 2 - 75));
        tip.setAttribute('transform', `translate(${x},${Math.max(0, y(Math.max(m.in, m.out)) - 70)})`); tip.setAttribute('visibility', 'visible');
      });
      hit.addEventListener('pointerleave', () => { hl.setAttribute('visibility', 'hidden'); tip.setAttribute('visibility', 'hidden'); });
      svg.append(hit);
    });
    svg.append(tip);
    return svg;
  });
}

function legend(items) {
  return h('div', { class: 'legend' }, items.map(([cls, label]) => h('span', null, h('i', { class: 'sw ' + cls, aria: { hidden: 'true' } }), label)));
}

function table(head, rows) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i ? h('td', { class: 'num' }, c) : h('th', { scope: 'row' }, c))))))));
}

function catChart(rows, side, budgets) {
  const items = rows.filter((r) => r[side] > 0 || (side === 'out' && budgets.has(r.category))).sort((a, b) => b[side] - a[side]);
  if (!items.length) return h('p', { class: 'mute bk-none' }, side === 'out' ? 'No money out yet.' : 'No money in yet.');
  return measured('cats', (W) => {
    const row = 44, H = items.length * row;
    const max = Math.max(...items.map((r) => Math.max(r[side], side === 'out' ? budgets.get(r.category) || 0 : 0)));
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': (side === 'out' ? 'Money out' : 'Money in') + ' by category' });
    items.forEach((r, i) => {
      const y0 = i * row, bw = (W - 2) * (r[side] / max), budget = side === 'out' ? budgets.get(r.category) : undefined;
      svg.append(...[s('text', { x: 0, y: y0 + 15, class: 'lab' }, catLabel(r.category)),
        s('text', { x: W, y: y0 + 15, class: 'val', 'text-anchor': 'end' }, peso(r[side]) + (budget ? ' of ' + peso(budget) : '')),
        s('rect', { x: 0, y: y0 + 23, width: W, height: 10, rx: 5, class: 'track' }),
        r[side] > 0 ? bar(0, y0 + 23, Math.max(2, bw), 10, side === 'out' ? (budget && r.out > budget ? 'b-over' : 'b-out') : 'b-in', false) : null].filter(Boolean));
      if (budget) svg.append(s('line', { x1: (W - 2) * (budget / max), x2: (W - 2) * (budget / max), y1: y0 + 19, y2: y0 + 37, class: 'budget' }));
    });
    return svg;
  });
}

/* ---------- overview ---------- */

export function books() {
  const node = later(async () => {
    const r = await get('/books');
    const check = h('a', { class: 'bk-check', href: '/books/proof' }, h('span', { class: 'dot' }), 'Checking the chain…');
    get('/books/verify').then((v) => {
      check.classList.add(v.ok ? 'ok' : 'bad');
      check.replaceChildren(h('span', { class: 'dot' }), v.ok ? (v.entries ? `All ${v.entries} entries check out` : 'Nothing to check yet') : `${v.problems.length} problems found`, icon('chev', 'sm'));
    }, () => check.replaceChildren(h('span', { class: 'dot' }), 'Could not run the check'));
    const hero = h('section', { class: 'group bk-hero' },
      h('p', { class: 'mono mute' }, 'Balance, by the books'),
      h('div', { class: 'bk-bal' }, peso(r.balance)),
      h('div', { class: 'row wrap bk-herorow' }, check, r.bank_match ? h('span', { class: 'tag ' + (r.bank_match.bank_balance === r.bank_match.ledger_balance ? 'ok' : 'warn') },
        r.bank_match.bank_balance === r.bank_match.ledger_balance ? 'Bank matches · ' + niceDate(r.bank_match.statement_date) : 'Bank differs · ' + niceDate(r.bank_match.statement_date)) : null),
      h('p', { class: 'asof' }, 'Live · ' + asOf(r.as_of)));
    if (!r.entries) {
      return [hero, h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'No entries yet.'),
        h('p', null, 'Community holds no money until its non-profit foundation is registered and its bank account is open. From the first peso, every entry shows here: signed, chained and checkable by anyone.'),
        btn('How Open Books works', { kind: 'w', sm: true, href: '/books/proof' }))),
      r.drafts_waiting ? h('div', { class: 'pad' }, btn(r.drafts_waiting + ' waiting for signatures', { kind: 'w', sm: true, href: '/books/approvals' })) : null];
    }
    const stats = h('div', { class: 'bk-stats' },
      stat('Money in', peso(r.total_in), 'all time', 'in'), stat('Money out', peso(r.total_out), 'all time', 'out'),
      stat('Waiting', String(r.drafts_waiting), r.drafts_waiting === 1 ? 'draft to sign' : 'drafts to sign', '', '/books/approvals'),
      stat('Anchored', r.anchor ? r.anchor.upto_seq + ' of ' + r.entries : '0 of ' + r.entries, r.anchor ? (r.anchor.stamped ? 'entries, on Bitcoin' : 'entries, stamp pending') : 'entries', '', '/books/proof'));
    // cash flow: chart or table
    const flowBody = h('div');
    const flowChart = () => flowBody.replaceChildren(legend([['in', 'Money in'], ['out', 'Money out']]), cashChart(r.months));
    const flowTable = () => flowBody.replaceChildren(table(['Month', 'In', 'Out'], r.months.slice().reverse().map((m) => [monthName(m.month, true), peso(m.in), peso(m.out)])));
    flowChart();
    const flow = h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'Cash flow'),
      buttonTabs([['chart', 'Chart'], ['table', 'Table']], 'chart', (k) => (k === 'chart' ? flowChart() : flowTable()), 'Cash flow view')), h('p', { class: 'mute bk-sub' }, 'Last 12 months. Corrections count against the month they correct.'), flowBody);
    const budgets = new Map((r.budgets.items || []).map((b) => [b.category, b.amount]));
    const catBody = h('div', null, catChart(r.categories, 'out', budgets));
    const cats = h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'By category'),
      buttonTabs([['out', 'Out'], ['in', 'In']], 'out', (k) => catBody.replaceChildren(catChart(r.categories, k, budgets)), 'Direction')),
      budgets.size ? legend([['out', 'Spent'], ['budget', r.budgets.year + ' budget']]) : null, catBody);
    const recent = h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'Latest'), btn('All activity', { kind: 'w', sm: true, href: '/books/activity' })),
      later(async () => { const x = await get('/books/entries', { limit: 5 }); return x.items.map(entryRow); }));
    return [hero, stats, flow, cats, recent, h('p', { class: 'asof' }, 'Signing rule: one trustee signature up to ' + peso(r.rule.two_sig_over) + ', two above it or for a related party.')];
  });
  return frame('overview', node);
}

function stat(label, value, sub, cls, href) {
  const kids = [h('span', { class: 'mono mute' }, label), h('b', { class: 'bk-num ' + (cls || '') }, value), h('small', { class: 'mute' }, sub)];
  return href ? h('a', { class: 'bk-stat', href }, kids) : h('div', { class: 'bk-stat' }, kids);
}

/* ---------- activity ---------- */

export function booksActivity({ query }) {
  const kind = ['in', 'out'].includes(query.get('kind')) ? query.get('kind') : '';
  const category = CATEGORIES.some((c) => c[0] === query.get('category')) ? query.get('category') : '';
  const go = (k, c) => { const q = new URLSearchParams(); if (k) q.set('kind', k); if (c) q.set('category', c); history.replaceState(history.state, '', '/books/activity' + (q.toString() ? '?' + q : '')); draw(k, c); };
  const filters = h('div', { class: 'bk-filters' },
    choiceChips([['', 'All'], ['in', 'Money in'], ['out', 'Money out']], kind, (k) => go(k, cat.value || ''), 'Direction'),
    h('div', { class: 'bk-catdd' }));
  const cat = dropdown([['', 'Every category'], ...CATEGORIES], { value: category, onChange: (c) => go(filters.querySelector('[aria-checked="true"]')?.dataset.v || '', c) });
  cat.querySelector('.dd-btn').setAttribute('aria-label', 'Category');
  filters.lastChild.append(cat);
  const list = h('div', { class: 'group bk-list' });
  function draw(k, c) {
    let lastMonth = '';
    list.replaceChildren(pagedList({
      fetchPage: (before) => get('/books/entries', { limit: 25, before, kind: k || undefined, category: c || undefined }),
      cursor: (e) => e.seq,
      render: (e) => {
        const m = e.date.slice(0, 7);
        const head = m !== lastMonth ? h('h3', { class: 'sect' }, monthName(m, true)) : null;
        lastMonth = m;
        return h('div', null, head, entryRow(e));
      },
      emptyNode: empty('No entries here', k || c ? 'Nothing matches these filters.' : 'The first entry will show here once the foundation holds money.'),
    }));
  }
  draw(kind, category);
  return frame('activity', h('div', null, filters, list), 'Activity · Open Books');
}

/* ---------- one entry ---------- */

export function booksEntry({ params }) {
  const node = later(async () => {
    const [r, me] = await Promise.all([get('/books/entries/' + encodeURIComponent(params.seq)), whoAmI()]);
    const e = r.entry;
    const kv = (k, v) => h('div', { class: 'bk-kv' }, h('span', { class: 'mute' }, k), h('span', null, v));
    const local = h('p', { class: 'hint' }, icon('shield', 'sm'), 'Checking the hash in this browser…');
    // Recompute the hash here, from the parts, without trusting the server's answer.
    get('/books/ledger').then(async (f) => {
      const row = f.entries[e.seq - 1];
      const mine = await entryHash(row);
      local.replaceChildren(icon(mine === e.hash ? 'check' : 'x', 'sm'), mine === e.hash ? 'This browser recomputed the hash: it matches.' : 'This browser got a different hash: the entry does not match.');
      local.classList.add(mine === e.hash ? 'ok' : 'err');
    }, () => local.replaceChildren('Could not run the check here.'));
    const keeper = me.can_draft && !e.reverses && !e.reversed_by;
    return [
      h('section', { class: 'group bk-hero' }, h('div', { class: 'row' }, kindIcon(e.kind), h('span', { class: 'mono mute grow' }, (e.kind === 'in' ? 'Money in' : 'Money out') + ' · entry #' + e.seq)),
        h('div', { class: 'bk-bal ' + e.kind }, amountText(e)), h('p', { class: 'bk-desc' }, e.description),
        h('div', { class: 'row wrap' }, e.assisted ? h('span', { class: 'tag' }, 'Drafted with AI help') : null, e.reversed_by ? h('a', { class: 'tag k', href: '/books/e/' + e.reversed_by }, 'Reversed by #' + e.reversed_by) : null,
          e.reverses ? h('a', { class: 'tag k', href: '/books/e/' + e.reverses }, 'Corrects #' + e.reverses) : null)),
      h('section', { class: 'group bk-card' }, h('h2', null, 'Details'),
        kv(e.kind === 'in' ? 'From' : 'Paid to', h('span', null, partyName(e.party), ' ', h('span', { class: 'tag' }, (PARTIES.find((p) => p[0] === e.party.kind) || [])[1] || e.party.kind))),
        e.related_note ? kv('Why it was fair', e.related_note) : null,
        kv('Category', catLabel(e.category)), kv('Date', niceDate(e.date)), kv('Drafted by', '@' + e.drafted_by),
        kv('Signed by', e.signers.map((x) => '@' + x).join(', ') + ' (' + e.needs + ' needed)'),
        e.conflicted.length ? kv('Declared a conflict', e.conflicted.map((x) => '@' + x).join(', ')) : null,
        e.evidence.length ? kv('Receipts', h('div', null, e.evidence.map((f) => h('div', { class: 'ev' }, h('b', null, f.name), h('code', null, f.sha256))))) : kv('Receipts', 'None attached')),
      h('section', { class: 'group bk-card' }, h('h2', null, 'Proof'),
        kv('Sealed', niceDate(e.sealed_at.slice(0, 10)) + ' · ' + ago(e.sealed_at)),
        kv('Hash', h('code', { class: 'hash' }, e.hash)), kv('Points at', h('code', { class: 'hash' }, e.prev)),
        kv('Anchor', r.anchored_in ? 'In anchor ' + r.anchored_in.id + ' (entries 1-' + r.anchored_in.upto_seq + ')' : 'Not anchored yet'), local,
        h('details', { class: 'bk-raw' }, h('summary', null, 'What the trustees signed'), h('pre', { class: 'formula' }, r.signed_body))),
      keeper ? h('div', { class: 'pad' }, btn('Reverse this entry', { kind: 'w', sm: true, icon: 'back', on: () => reverseSheet(e) })) : null,
      h('p', { class: 'asof' }, 'Live · ' + asOf(r.as_of)),
    ];
  });
  return frame('activity', node, 'Entry #' + params.seq + ' · Open Books');
}

function reverseSheet(e) {
  sheet('Reverse entry', (close) => {
    const why = h('textarea', { class: 'area', maxlength: 200, placeholder: 'For example: the invoice was for the wrong amount' });
    const date = datePicker({ value: today(), min: e.date, max: today() });
    const err = h('p', { class: 'err', role: 'alert' });
    const go = btn('Draft the reversal', { block: true, on: async () => {
      if (why.value.trim().length < 3) { err.textContent = 'Say what was wrong.'; return; }
      go.disabled = true;
      try { await post('/books/drafts', { reverses: e.seq, description: why.value.trim(), date: date.value }); close(); toast('Drafted. It needs a trustee\'s signature.'); nav('/books/approvals'); }
      catch (x) { err.textContent = x.message; go.disabled = false; }
    } });
    return [h('h2', null, 'Reverse entry #' + e.seq), h('p', { class: 'mute' }, 'Nothing is ever edited. A reversing entry undoes this one exactly (' + amountText(e) + '), and both stay in the books. Then draft the right entry.'),
      field('What was wrong', why), control('Date of the reversal', date), err, h('div', { class: 'mt' }, go)];
  });
}

/* ---------- approvals ---------- */

export function booksApprovals() {
  const box = h('div');
  async function load() {
    box.replaceChildren(loading());
    try {
      const [r, me] = await Promise.all([get('/books/drafts'), whoAmI(true)]);
      const local = me.trustee && state.me ? await loadSigningKey(state.me.id).catch(() => null) : null;
      const ready = !!(me.key && local && local.keyId === me.key.key_id);
      // replaceChildren would print a null as text: drop the empty slots
      box.replaceChildren(...[
        me.trustee ? keyCard(me, local, ready, load) : null,
        me.can_draft ? h('div', { class: 'pad bk-actions' }, btn('New entry', { icon: 'plus', on: () => entrySheet(r.rule, load) })) : null,
        r.drafts.length ? h('div', null, r.drafts.map((d) => draftCard(d, me, local, ready, load)))
          : h('div', { class: 'group' }, empty('Nothing waiting', 'Drafts show here, in public, while they wait for trustees to sign.')),
        h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'How signing works'),
          h('p', null, 'One trustee signs up to ' + peso(r.rule.two_sig_over) + '; two sign above it or for a related party. Nobody signs their own draft, and a trustee with a conflict says so and steps aside. AI tools may help draft, never sign.'))),
        h('p', { class: 'asof' }, 'Live · ' + asOf(r.as_of))].filter(Boolean));
    } catch (e) { box.replaceChildren(errorBox(e, load)); }
  }
  load();
  return frame('approvals', box, 'Approvals · Open Books');
}

function keyCard(me, local, ready, reload) {
  const make = async (b) => {
    b.disabled = true;
    try {
      const k = await newSigningKey();
      await saveSigningKey(state.me.id, k);
      await put('/books/key', { public_key: k.publicJwk });
      toast('Your signing key is ready in this browser.');
      reload();
    } catch (e) { fail(e); b.disabled = false; }
  };
  if (ready) return h('div', { class: 'note-ok bk-key' }, icon('key'), h('div', null, h('b', null, 'You can sign here.'), h('p', null, 'Your key lives in this browser and cannot be copied out. Key ' + me.key.key_id + '.')));
  const first = !me.key;
  const b = btn(first ? 'Make my signing key' : 'Make a new key here', { sm: true, kind: 'y', icon: 'key' });
  b.addEventListener('click', () => (first ? make(b) : sheet('New signing key', (close) => [h('h2', null, 'Make a new key in this browser?'),
    h('p', { class: 'mute' }, 'Your published key (' + me.key.key_id + ') is not in this browser. A new key retires it. Everything you signed with it still checks; signatures waiting on drafts are dropped and you sign them again.'),
    h('div', { class: 'row wrap mt' }, btn('Make a new key', { kind: 'y', icon: 'key', on: (ev) => { close(); make(ev.currentTarget); } }), btn('Cancel', { kind: 'w', on: close }))])));
  return h('div', { class: 'note k bk-key' }, icon('key'), h('div', null, h('b', null, first ? 'Make your signing key' : 'Your key is in another browser'),
    h('p', null, first ? 'You are a trustee. Your key is made here, stays in this browser and never reaches the server: it only gets the public half.' : 'Sign from the browser that has it, or make a new key here.'), b));
}

function draftCard(d, me, local, ready, reload) {
  const b = d.body;
  const mine = state.me && b.drafted_by === state.me.handle;
  const signed = state.me && d.signatures.some((x) => x.handle === state.me.handle);
  const conflicted = state.me && d.conflicts.some((x) => x.handle === state.me.handle);
  const acts = [];
  if (me.trustee && !mine && !signed && !conflicted) {
    const s = btn('Sign', { sm: true, icon: 'check', disabled: !ready });
    s.addEventListener('click', async () => {
      s.disabled = true;
      try {
        const r = await post('/books/drafts/' + d.id + '/sign', { key_id: local.keyId, sig: await signBody(local.privateKey, b) });
        toast(r.sealed ? 'Signed and sealed as entry #' + r.sealed.seq + '.' : r.waiting === 'balance' ? 'Signed. It seals when the balance can cover it.' : 'Signed. It needs one more signature.');
        reload();
      } catch (e) { fail(e); s.disabled = false; }
    });
    acts.push(s, btn('I have a conflict', { sm: true, kind: 'w', on: () => conflictSheet(d, reload) }));
  }
  if (mine || me.staff) acts.push(btn('Withdraw', { sm: true, kind: 'w', on: () => sheet('Withdraw draft', (close) => [h('h2', null, 'Withdraw this draft?'),
    h('p', { class: 'mute' }, 'It was never in the books, so nothing is reversed. Its signatures are dropped.'),
    h('div', { class: 'row wrap mt' }, btn('Withdraw', { kind: 'e', on: async () => { try { await del('/books/drafts/' + d.id); close(); toast('Withdrawn.'); reload(); } catch (e) { fail(e); } } }), btn('Keep it', { kind: 'w', on: close }))]) }));
  if (d.signatures.length >= d.needs && (me.can_draft)) acts.push(btn('Seal now', { sm: true, kind: 'y', on: async () => { try { const r = await post('/books/drafts/' + d.id + '/seal'); toast('Sealed as entry #' + r.sealed.seq + '.'); reload(); } catch (e) { fail(e); } } }));
  const dots = h('span', { class: 'bk-need', aria: { label: d.signatures.length + ' of ' + d.needs + ' signatures' } }, Array.from({ length: d.needs }, (_, i) => h('i', { class: i < d.signatures.length ? 'on' : '' })), d.signatures.length + ' of ' + d.needs);
  return h('article', { class: 'group bk-draft' },
    h('div', { class: 'row' }, kindIcon(b.kind), h('b', { class: 'bk-num grow ' + b.kind }, amountText(b)), dots),
    h('p', { class: 'bk-desc' }, b.description),
    h('p', { class: 't2 mute' }, [partyName(b.party), catLabel(b.category), niceDate(b.date), 'drafted by @' + b.drafted_by, ago(d.created_at)].join(' · ')),
    h('div', { class: 'row wrap' }, b.reverses ? h('a', { class: 'tag k', href: '/books/e/' + b.reverses }, 'Reverses #' + b.reverses) : null, b.party.kind === 'related_party' ? h('span', { class: 'tag y' }, 'Related party') : null,
      b.assisted ? h('span', { class: 'tag' }, 'Drafted with AI help') : null, b.evidence.length ? h('span', { class: 'tag' }, b.evidence.length + (b.evidence.length === 1 ? ' receipt' : ' receipts')) : null),
    b.related_note ? h('p', { class: 'bk-why' }, h('b', null, 'Why it was fair: '), b.related_note) : null,
    d.signatures.length ? h('p', { class: 'hint' }, icon('check', 'sm'), 'Signed by ' + d.signatures.map((x) => '@' + x.handle).join(', ')) : null,
    d.conflicts.map((c) => h('p', { class: 'hint' }, icon('flag', 'sm'), '@' + c.handle + ' declared a conflict' + (c.note ? ': ' + c.note : ''))),
    mine && me.trustee ? h('p', { class: 'hint' }, icon('info', 'sm'), 'You drafted this, so another trustee signs it.') : null,
    acts.length ? h('div', { class: 'row wrap bk-acts' }, acts) : null);
}

function conflictSheet(d, reload) {
  sheet('Declare a conflict', (close) => {
    const note = h('textarea', { class: 'area', maxlength: 200, placeholder: 'For example: I know the owner of this company' });
    return [h('h2', null, 'Declare a conflict'), h('p', { class: 'mute' }, 'You will not sign this draft, and the conflict is published with the entry.'), field('What the conflict is (shown in public)', note),
      h('div', { class: 'row wrap mt' }, btn('Declare it', { on: async () => { try { await post('/books/drafts/' + d.id + '/conflict', { note: note.value.trim() }); close(); reload(); } catch (e) { fail(e); } } }), btn('Cancel', { kind: 'w', on: close }))];
  });
}

/** The new-entry form: every control is a branded one. */
function entrySheet(rule, reload) {
  sheet('New entry', (close) => {
    let kind = 'out', amount = null, files = [], assisted = false;
    const amt = pesoField({ onChange: (c) => { amount = c; needLine(); } });
    const date = datePicker({ value: today(), min: '2026-01-01', max: today() });
    const cat = dropdown(CATEGORIES, { placeholder: 'Choose a category' });
    const who = h('input', { type: 'text', maxlength: 80, autocomplete: 'off' });
    const ref = h('input', { type: 'text', maxlength: 12, autocomplete: 'off', placeholder: 'C-0012' });
    const why = h('textarea', { class: 'area', maxlength: 300, placeholder: 'Quotes compared, why this was the fair choice' });
    const desc = h('textarea', { class: 'area', maxlength: 200, placeholder: 'What it was for' });
    const nameRow = field('Name (shown in public)', who), refRow = field('Stable ID (the foundation keeps who it is)', ref, 'Use the same ID every time for the same person.'), whyRow = field('Why it was fair (shown in public)', why);
    const party = dropdown(PARTIES, { value: 'company', onChange: () => partyRows() });
    const need = h('p', { class: 'bk-needline' });
    const err = h('p', { class: 'err', role: 'alert' });
    function partyRows() {
      const p = party.value;
      nameRow.hidden = !['company', 'person_consented', 'related_party'].includes(p);
      refRow.hidden = p !== 'person_private';
      whyRow.hidden = p !== 'related_party';
      needLine();
    }
    function needLine() {
      const n = party.value === 'related_party' || (amount || 0) > rule.two_sig_over ? 2 : 1;
      need.replaceChildren(icon('key', 'sm'), n === 2 ? 'Needs two trustee signatures' + (party.value === 'related_party' ? ' (related party).' : ' (over ' + peso(rule.two_sig_over) + ').') : 'Needs one trustee signature.');
    }
    const drop = fileDrop({ hash: hashFile, onFiles: (f) => { files = f; } });
    const ai = toggle(false, 'An AI tool helped prepare this', (v) => { assisted = v; });
    const submit = btn('Send for signatures', { block: true, on: async () => {
      err.textContent = '';
      const p = party.value;
      const missing = !amount ? 'Enter the amount.' : !cat.value ? 'Choose a category.' : desc.value.trim().length < 3 ? 'Say what it was for.'
        : (!nameRow.hidden && who.value.trim().length < 2) ? 'Enter the name.' : (!refRow.hidden && !/^C-\d{4,6}$/.test(ref.value.trim())) ? 'The ID looks like C-0012.'
          : (!whyRow.hidden && why.value.trim().length < 10) ? 'Say why it was fair (10 characters or more).' : (p === 'donors' && kind === 'out') ? 'Donors can only give money in.' : '';
      if (missing) { err.textContent = missing; return; }
      submit.disabled = true;
      const partyBody = p === 'person_private' ? { kind: p, ref: ref.value.trim() } : p === 'donors' ? { kind: p } : { kind: p, name: who.value.trim() };
      try {
        await post('/books/drafts', { kind, amount, date: date.value, category: cat.value, party: partyBody, description: desc.value.trim(), evidence: files, assisted,
          related_note: p === 'related_party' ? why.value.trim() : undefined });
        close(); toast('Drafted. Trustees can sign it now.'); reload();
      } catch (e) { err.textContent = e.message; submit.disabled = false; }
    } });
    partyRows();
    const partyCtl = control('Paid to', party);
    return [h('h2', null, 'New entry'), h('p', { class: 'mute' }, 'Everything here is public once it is sealed, except the receipt itself: only its fingerprint is kept.'),
      control('Direction', choiceChips([['out', 'Money out'], ['in', 'Money in']], kind, (k) => { kind = k; partyCtl.querySelector('.lbl').textContent = k === 'in' ? 'From' : 'Paid to'; }, 'Direction')),
      control('Amount', amt), h('div', { class: 'bk-two' }, control('Date', date), control('Category', cat)),
      partyCtl, nameRow, refRow, whyRow,
      field('What it was for', desc), control('Receipt or invoice', drop),
      h('div', { class: 'toggle' }, h('div', { class: 'grow' }, h('p', null, 'An AI tool helped prepare this'), h('p', { class: 'd' }, 'Shown on the entry. Only a person signs.')), ai),
      need, err, submit];
  });
}

/* ---------- payees ---------- */

export function booksPayees() {
  const node = later(async () => {
    const r = await get('/books/payees');
    const row = (p) => h('div', { class: 'li line' }, h('span', { class: 'bk-ic ' + (p.kind === 'person_private' ? 'priv' : '') }, icon(p.kind === 'person_private' ? 'lock' : p.kind === 'donors' ? 'users' : 'work', 'sm')),
      h('div', { class: 'grow' }, h('div', { class: 't1' }, p.name, p.kind === 'related_party' ? h('span', { class: 'tag y' }, 'Related') : null),
        h('div', { class: 't2' }, (PARTIES.find((x) => x[0] === p.kind) || [])[1] + ' · ' + p.entries + (p.entries === 1 ? ' entry' : ' entries') + ' · last ' + niceDate(p.last_date))),
      h('b', { class: 'amt' }, peso(p.amount)));
    return [
      h('h2', { class: 'sect' }, 'Paid by the community'),
      h('div', { class: 'group' }, r.paid.length ? r.paid.map(row) : empty('Nobody has been paid yet', 'Every company and person paid shows here with their total.')),
      h('h2', { class: 'sect' }, 'Money came from'),
      h('div', { class: 'group' }, r.funders.length ? r.funders.map(row) : empty('No money in yet', 'Donors are counted together; grants and companies are named.')),
      h('div', { class: 'note' }, icon('lock'), h('div', null, h('b', null, 'People are protected.'), h('p', null, 'A person is named only if they agreed. Otherwise they show by a stable ID, so their total is still public, and Community never stores who it is.'))),
      h('p', { class: 'asof' }, 'Live · ' + asOf(r.as_of) + ' · corrections netted'),
    ];
  });
  return frame('payees', node, 'Payees · Open Books');
}

/* ---------- proof ---------- */

const CHECKS = [['order', 'Every entry in order'], ['link', 'Every entry points at the one before'], ['hash', 'Every hash matches its contents'],
  ['signature', 'Every signature checks against a published key'], ['rule', 'Every signing rule was kept'], ['balance', 'The balance never went below zero'], ['anchor', 'Every anchor still matches']];

export function booksProof() {
  const box = h('div');
  async function load() {
    box.replaceChildren(loading());
    try {
      const [s, an, rc, tr, me] = await Promise.all([get('/books'), get('/books/anchors'), get('/books/reconciliations'), get('/books/trustees'), whoAmI()]);
      box.replaceChildren(checkCard(), anchorsCard(s, an, me, load), bankCard(rc, me, load), trusteesCard(tr, me, load), rulesCard(s, me, load),
        h('p', { class: 'asof' }, 'Live · ' + asOf(s.as_of)));
    } catch (e) { box.replaceChildren(errorBox(e, load)); }
  }
  load();
  return frame('proof', box, 'Proof · Open Books');
}

function checkCard() {
  const out = h('div', { aria: { live: 'polite' } });
  const run = btn('Check the books here', { icon: 'shield', on: async () => {
    run.disabled = true;
    out.replaceChildren(h('p', { class: 'mute' }, 'Downloading the ledger…'));
    try {
      const f = await get('/books/ledger');
      const prog = h('p', { class: 'mute' }, 'Checking…');
      out.replaceChildren(prog);
      const v = await verifyLedger(f, (i, n) => { if (i % 25 === 0 || i === n) prog.textContent = 'Checked ' + i + ' of ' + n + '…'; });
      out.replaceChildren(...[h('div', { class: v.ok ? 'note-ok' : 'note k' }, icon(v.ok ? 'check' : 'x'), h('div', null, h('b', null, v.ok ? (v.entries ? 'Everything checks out.' : 'Nothing to check yet.') : v.problems.length + ' problems found.'),
        h('p', null, [v.entries + plural(v.entries, ' entry', ' entries'), v.anchors + plural(v.anchors, ' anchor', ' anchors'), 'balance ' + peso(v.balance)].join(', ') + '. Checked in this browser, ' + asOf(f.as_of) + '.'))),
      h('ul', { class: 'bk-checks' }, CHECKS.map(([k, label]) => { const n = v.problems.filter((p) => p.check === k).length; return h('li', { class: n ? 'bad' : 'ok' }, icon(n ? 'x' : 'check', 'sm'), h('span', { class: 'grow' }, label), n ? h('b', null, n) : null); })),
      v.problems.length ? h('ul', { class: 'bk-probs' }, v.problems.slice(0, 50).map((p) => h('li', null, h('b', null, p.seq ? '#' + p.seq : 'Anchor ' + p.anchor), ' ' + p.detail))) : null].filter(Boolean));
    } catch (e) { out.replaceChildren(errorBox(e)); }
    run.disabled = false;
  } });
  return h('section', { class: 'group bk-card' }, h('h2', null, 'Check it yourself'),
    h('p', { class: 'mute' }, 'Your browser downloads every entry and checks the hashes, signatures and rules itself. It does not take the server\'s word for anything.'),
    h('div', { class: 'row wrap' }, run, h('a', { class: 'btn w sm', href: '/api/books/ledger?download=1', download: '' }, icon('download', 'sm b'), 'Download the ledger')), out);
}

function anchorsCard(s, an, me, reload) {
  const make = me.can_draft && s.unanchored > 0 ? btn('Anchor ' + s.unanchored + (s.unanchored === 1 ? ' new entry' : ' new entries'), { sm: true, kind: 'y', icon: 'anchor', on: async (e) => {
    e.currentTarget.disabled = true; try { await post('/books/anchors'); toast('Anchored. It is stamped on Bitcoin next.'); reload(); } catch (x) { fail(x); }
  } }) : null;
  return h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'Anchored on Bitcoin'), make),
    h('p', { class: 'mute' }, 'An anchor is one fingerprint (a Merkle root) of every entry so far, stamped on Bitcoin with OpenTimestamps. After that, nobody can rewrite those entries, not even whoever runs the server.'),
    an.anchors.length ? an.anchors.map((a) => h('div', { class: 'li line' }, h('span', { class: 'bk-ic' }, icon('anchor', 'sm')),
      h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Entries 1-' + a.upto_seq), h('div', { class: 't2' }, h('code', null, a.root.slice(0, 24) + '…'), ' · @' + a.made_by + ' · ' + niceDate(a.created_at.slice(0, 10)))),
      a.stamped ? h('a', { class: 'btn w sm', href: '/api/books/anchors/' + a.id + '/proof', download: '' }, icon('download', 'sm b'), '.ots') : h('span', { class: 'tag' }, 'Stamp pending')))
      : h('p', { class: 'mute bk-none' }, 'No anchors yet.'));
}

function bankCard(rc, me, reload) {
  const add = me.can_draft ? btn('Record a statement', { sm: true, kind: 'w', icon: 'plus', on: () => sheet('Bank statement', (close) => {
    const date = datePicker({ value: today(), min: '2026-01-01', max: today() });
    const bal = pesoField();
    let fileHash = null;
    const drop = fileDrop({ hash: hashFile, max: 1, label: 'Add the statement', onFiles: (f) => { fileHash = f[0] ? f[0].sha256 : null; } });
    const note = h('input', { type: 'text', maxlength: 200, autocomplete: 'off' });
    const err = h('p', { class: 'err', role: 'alert' });
    return [h('h2', null, 'Record a bank statement'), h('p', { class: 'mute' }, 'The closing balance goes next to the ledger\'s balance for that date, matched or not. Only the statement\'s fingerprint is kept.'),
      control('Statement date', date), control('Closing balance', bal), control('Statement file', drop), field('Note (optional, public)', note), err,
      h('div', { class: 'mt' }, btn('Save', { block: true, on: async () => {
        if (bal.value === null) { err.textContent = 'Enter the closing balance.'; return; }
        try { const r = await post('/books/reconciliations', { statement_date: date.value, bank_balance: bal.value, statement_sha256: fileHash, note: note.value.trim() }); close(); toast(r.reconciliation.matched ? 'Saved: it matches.' : 'Saved: it does not match. That shows in public.', !r.reconciliation.matched); reload(); }
        catch (e) { err.textContent = e.message; }
      } }))];
  }) }) : null;
  return h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'Bank match'), add),
    h('p', { class: 'mute' }, 'Every month a trustee records the bank statement\'s closing balance. A difference is shown, never hidden.'),
    rc.reconciliations.length ? table(['Statement', 'Bank', 'Books', ''], rc.reconciliations.map((x) => [niceDate(x.statement_date), peso(x.bank_balance, true), peso(x.ledger_balance, true),
      x.bank_balance === x.ledger_balance ? 'Match' : 'Off by ' + peso(Math.abs(x.bank_balance - x.ledger_balance), true)])) : h('p', { class: 'mute bk-none' }, 'No statements recorded yet.'));
}

function trusteesCard(tr, me, reload) {
  const appoint = me.staff ? btn('Appoint', { sm: true, kind: 'w', icon: 'plus', on: () => sheet('Appoint a trustee', (close) => {
    const hdl = h('input', { type: 'text', maxlength: 31, autocomplete: 'off', placeholder: '@handle' });
    return [h('h2', null, 'Appoint a trustee'), h('p', { class: 'mute' }, 'Shown in public with your handle as the one who appointed them.'), field('Their handle', hdl),
      h('div', { class: 'mt' }, btn('Appoint', { block: true, on: async () => { try { await post('/books/trustees', { handle: hdl.value.trim() }); close(); reload(); } catch (e) { fail(e); } } }))];
  }) }) : null;
  const active = tr.trustees.filter((t) => !t.ended_at), former = tr.trustees.filter((t) => t.ended_at);
  const row = (t) => h('div', { class: 'li line' }, h('span', { class: 'bk-ic' }, icon(t.key_id ? 'key' : 'user', 'sm')),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, h('a', { href: '/u/' + encodeURIComponent(t.handle) }, t.first_name + ' · @' + t.handle)),
      h('div', { class: 't2' }, t.ended_at ? 'Trustee until ' + niceDate(t.ended_at.slice(0, 10)) : 'Since ' + niceDate(t.appointed_at.slice(0, 10)) + (t.appointed_by ? ', appointed by @' + t.appointed_by : '') + ' · ' + (t.key_id ? 'key ' + t.key_id : 'no key yet'))),
    me.staff && !t.ended_at ? btn('End', { sm: true, kind: 'w', on: () => sheet('End trustee', (close) => [h('h2', null, 'End @' + t.handle + ' as trustee?'), h('p', { class: 'mute' }, 'Their key is retired. What they signed stays and still checks.'),
      h('div', { class: 'row wrap mt' }, btn('End', { kind: 'e', on: async () => { try { await del('/books/trustees/' + encodeURIComponent(t.handle)); close(); reload(); } catch (e) { fail(e); } } }), btn('Cancel', { kind: 'w', on: close }))]) }) : null);
  return h('section', { class: 'group bk-card' }, h('div', { class: 'row bk-cardhead' }, h('h2', { class: 'grow' }, 'Trustees'), appoint),
    active.length ? active.map(row) : h('p', { class: 'mute bk-none' }, 'No trustees yet.'), former.length ? [h('h3', { class: 'sect' }, 'Former trustees'), former.map(row)] : null);
}

function rulesCard(s, me, reload) {
  const year = s.budgets.year;
  const edit = me.staff ? h('div', { class: 'row wrap' },
    btn('Change the limit', { sm: true, kind: 'w', on: () => sheet('Signing limit', (close) => {
      const v = pesoField({ value: s.rule.two_sig_over });
      return [h('h2', null, 'Signing limit'), h('p', { class: 'mute' }, 'Above this, an entry needs two signatures. The change is published, with your handle.'), control('Two signatures above', v),
        h('div', { class: 'mt' }, btn('Publish', { block: true, on: async () => { if (v.value === null) return; try { await put('/books/rule', { two_sig_over: v.value }); close(); reload(); } catch (e) { fail(e); } } }))];
    }) }),
    btn('Set a budget', { sm: true, kind: 'w', on: () => sheet('Budget', (close) => {
      const c = dropdown(CATEGORIES.filter(([k]) => !['donations', 'grants', 'ads'].includes(k)), { placeholder: 'Choose a category' });
      const v = pesoField();
      return [h('h2', null, year + ' budget'), h('p', { class: 'mute' }, 'Shown next to what was spent. Every change is published.'), control('Category', c), control('Budget for ' + year, v),
        h('div', { class: 'mt' }, btn('Publish', { block: true, on: async () => { if (!c.value || v.value === null) return; try { await post('/books/budgets', { year, category: c.value, amount: v.value }); close(); reload(); } catch (e) { fail(e); } } }))];
    }) })) : null;
  return h('section', { class: 'group bk-card' }, h('h2', null, 'The rules'),
    h('ul', { class: 'bk-rules' },
      h('li', null, 'One trustee signature up to ' + peso(s.rule.two_sig_over) + ', two above it or for a related party' + (s.rule.set_by ? ' (set by @' + s.rule.set_by + ', ' + niceDate(s.rule.set_at.slice(0, 10)) + ')' : '') + '.'),
      h('li', null, 'Nobody signs their own draft. A trustee with a conflict declares it and cannot sign.'),
      h('li', null, 'Nothing is edited or deleted. Mistakes get a reversing entry.'),
      h('li', null, 'The money stays in the foundation\'s bank account. Only fingerprints go on Bitcoin.'),
      h('li', null, 'A person is named only with their consent.')), edit);
}
