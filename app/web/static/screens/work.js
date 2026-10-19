// Work: gigs like an Upwork job card, with a Newest tab and a ranking that explains itself.
// Community never holds money: "Paid how" is always shown and pay goes person to person.
import { h, icon } from '../lib/dom.js';
import { get, patch, post } from '../lib/api.js';
import { asOf, pay, timeAgo, tradeLabel } from '../lib/format.js';
import { codeAtLevel } from '../lib/places.js';
import { nav, state } from '../core.js';
import { appBar, btn, empty, errorBox, fail, field, later, linkTabs, pagedList, personRow, sheet, tick, toast } from '../ui.js';
import { placeSearch } from './join.js';

const enc = encodeURIComponent;
const TABS = [['for_you', 'For you'], ['newest', 'Newest'], ['saved', 'Saved'], ['mine', 'My gigs']];

function payLine(g) {
  const p = pay(g.pay_amount, g.pay_currency, g.pay_unit);
  return h('div', { class: 'pay' }, p.amount, ' ', h('small', null, [p.unit, g.pay_note].filter(Boolean).join(' · ')));
}

export function gigCard(g) {
  const poster = g.poster || {};
  const where = g.distance_hint || (g.place && g.place.name);
  return h('a', { class: 'job', href: '/gigs/' + enc(g.id) },
    h('h2', { class: 'ttl' }, g.title),
    h('div', { class: 'm' }, [poster.first_name, where, 'posted ' + timeAgo(g.created_at) + ' ago'].filter(Boolean).join(' · ')),
    payLine(g),
    g.body ? h('p', { class: 'd' }, g.body) : null,
    (g.skills || []).length ? h('div', { class: 'skills' }, g.skills.map((s) => h('span', null, s))) : null,
    h('div', { class: 'trust' }, poster.id_checked ? h('span', { class: 'okk' }, tick(), 'ID checked') : null,
      h('span', null, 'Paid: ', h('b', null, g.paid_how || 'not stated')),
      h('span', null, (g.applicants ?? 0) + ' applied'),
      g.status && g.status !== 'open' ? h('span', { class: 'tag' }, g.status) : null));
}

let homeCity = null;
async function cityCode() {
  if (!state.me || !state.me.home_area) return null;
  if (homeCity && homeCity.home === state.me.home_area) return homeCity.code;
  const r = await get('/places/' + enc(state.me.home_area));
  const code = codeAtLevel([r.area, ...(r.chain || [])], 'city');
  homeCity = { home: state.me.home_area, code };
  return code;
}

export function work({ query }) {
  const tab = TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'for_you';
  const f = { near: query.get('near') === '1', trade: query.get('trade') === '1', min: query.get('min_pay') === '500' };
  const href = (over) => {
    const o = { tab, near: f.near ? '1' : '', trade: f.trade ? '1' : '', min_pay: f.min ? '500' : '', ...over };
    const q = Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + enc(v)).join('&');
    return '/work' + (q ? '?' + q : '');
  };
  const chip = (label, on, over) => h('a', { class: 'chip' + (on ? ' on' : ''), href: href(over), aria: { pressed: String(on) }, role: 'button' }, label);
  const rule = h('span', null, tab === 'newest' ? 'Newest first: time only.' : '');
  let ruleText = '';
  const how = h('button', { type: 'button', on: { click: () => sheet('How For you is ordered', (close) => [h('h2', null, 'For you: how it\'s ordered'), h('p', null, ruleText || 'Distance, your trade and the poster\'s record, with the weights in the public code.'), btn('Got it', { block: true, on: close })]) } }, 'How?');
  const list = state.me ? pagedList({
    fetchPage: async (before) => {
      const params = { tab, before, min_pay: f.min ? 500 : undefined, trade: f.trade ? state.me.trade : undefined };
      if (f.near) { const c = await cityCode(); if (c) { params.level = 'city'; params.code = c; } }
      const r = await get('/gigs', params);
      if (!before && r.rule && tab !== 'newest') { ruleText = r.rule; rule.textContent = r.rule; }
      return { items: r.gigs, end: r.end !== undefined ? r.end : (r.gigs || []).length < 20, as_of: r.as_of };
    },
    render: gigCard,
    emptyNode: empty(tab === 'mine' ? 'You haven\'t posted a gig' : tab === 'saved' ? 'No saved gigs' : 'No gigs here yet', tab === 'mine' ? 'Post one when you need a hand.' : 'Try another filter, or check back later.'),
  }) : errorBox({ status: 401 });
  const node = h('div', null,
    appBar({ title: 'Work', right: [state.me ? btn('Post a gig', { sm: true, icon: 'plus', href: '/gigs/new' }) : null] }),
    linkTabs(TABS.map(([k, l]) => [l, href({ tab: k }), k === tab])),
    h('nav', { class: 'chips', aria: { label: 'Filters' } },
      state.me && state.me.home_area ? chip('Near me', f.near, { near: f.near ? '' : '1' }) : null,
      chip('My trade' + (state.me ? ' · ' + tradeLabel(state.me.trade) : ''), f.trade, { trade: f.trade ? '' : '1' }),
      chip('₱500+', f.min, { min_pay: f.min ? '' : '500' })),
    tab === 'for_you' || tab === 'newest' ? h('div', { class: 'rank' }, icon('sliders', 'sm'), rule, tab === 'for_you' ? how : null) : null,
    list);
  return { node, title: 'Work', tab: 'work' };
}

/* ---------- gig details ---------- */

export function gigPage({ params }) {
  const id = params.id;
  let stick = null;
  const node = later(async () => {
    const r = await get('/gigs/' + enc(id));
    const g = r.gig || {};
    const poster = r.poster || g.poster || {};
    const mine = state.me && poster.id === state.me.id;
    const app = r.my_application;
    document.title = g.title + ' · Work';
    const p = pay(g.pay_amount, g.pay_currency, g.pay_unit);
    const record = later(async () => {
      const w = await get('/people/' + enc(poster.handle) + '/work');
      const rt = w.ratings || {};
      return h('div', { class: 'pad' }, h('div', { class: 'trust' },
        poster.id_checked ? h('span', { class: 'okk' }, tick(), 'ID checked') : h('span', null, 'ID not checked'),
        rt.count ? h('span', null, h('b', null, avg(rt)), ' from ' + rt.count + ' ' + (rt.count === 1 ? 'person' : 'people')) : h('span', null, 'No ratings yet'),
        h('span', null, h('b', null, String(w.gigs_posted ?? 0)), ' gigs posted'),
        w.paid_on_time_share !== undefined && w.paid_on_time_share !== null ? h('span', null, h('b', null, Math.round(Number(w.paid_on_time_share) * 100) + '%'), ' paid on time') : null),
        h('p', { class: 'asof' }, asOf(w.as_of)));
    });
    let action;
    if (mine) {
      action = [btn('See applicants · ' + (g.applicants ?? 0), { block: true, href: '/gigs/' + enc(id) + '/applicants' }),
        g.status === 'open' ? btn('Close', { kind: 'w', on: async () => { if (!confirm('Close this gig to new applications?')) return; try { await patch('/gigs/' + enc(id), { status: 'closed' }); nav(location.pathname, { replace: true }); } catch (e) { fail(e); } } }) : null];
    } else if (app) {
      action = [h('span', { class: 'grow' }, 'You applied · ', h('b', null, app.status || 'sent')),
        app.status === 'picked' ? btn('Mark done', { sm: true, on: async () => { try { await post('/applications/' + enc(app.id) + '/done'); toast('Marked done'); nav('/gigs/' + enc(id) + '/rate'); } catch (e) { fail(e); } } }) : null,
        app.status === 'picked' || app.status === 'done' ? btn('Rate', { sm: true, kind: 'w', href: '/gigs/' + enc(id) + '/rate' }) : null];
    } else if (g.status === 'open') {
      action = state.me ? btn('Apply with proof', { block: true, href: '/gigs/' + enc(id) + '/apply' }) : btn('Log in to apply', { block: true, href: '/login?next=' + enc(location.pathname) });
    } else action = h('span', { class: 'mute' }, 'This gig is ' + (g.status || 'closed') + '.');
    stick = h('div', { class: 'stick' }, action);
    return [
      h('div', { class: 'pad' }, h('p', { class: 'mono mute' }, 'Gig' + (g.space && g.space.name ? ' · ' + g.space.name : '')), h('h1', { class: 'gig-h', tabindex: '-1' }, g.title),
        h('p', { class: 'mute' }, 'Posted ' + timeAgo(g.created_at) + ' ago · ' + (g.applicants ?? 0) + ' applied')),
      h('dl', { class: 'kv' }, h('dt', null, 'Pay'), h('dd', null, p.amount + ' ' + [p.unit, g.pay_note].filter(Boolean).join(' · ')),
        h('dt', null, 'When'), h('dd', null, g.when_text || 'Not stated'),
        h('dt', null, 'Where'), h('dd', null, [g.place && g.place.name, g.distance_hint].filter(Boolean).join(' · ') || 'Not stated'),
        h('dt', null, 'Paid how'), h('dd', null, g.paid_how || 'Not stated')),
      h('div', { class: 'pad mt mb' }, h('p', { class: 'pre' }, g.body || ''), (g.skills || []).length ? h('div', { class: 'skills mt' }, g.skills.map((s) => h('span', null, s))) : null),
      h('h2', { class: 'sect' }, 'About the poster'), personRow(poster), record,
      h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'Community never holds your money'), h('p', null, 'Pay goes directly between the two of you, the way the poster says above.'))),
      stick,
    ];
  });
  return { node: h('div', null, appBar({ back: '/work', title: '' }), node), title: 'Gig', tab: 'work', cls: 'nofab' };
}

const avg = (rt) => {
  const vals = ['on_time', 'quality', 'easy', 'again'].map((k) => Number(rt[k])).filter((n) => Number.isFinite(n) && n > 0);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '–';
};

/* ---------- apply with proof ---------- */

export function apply({ params }) {
  const id = params.id;
  if (!state.me) return { node: h('div', null, appBar({ title: 'Apply', back: '/gigs/' + enc(id) }), errorBox({ status: 401 })), title: 'Apply' };
  const node = later(async () => {
    const [g, c] = await Promise.all([get('/gigs/' + enc(id)), get('/me/credentials')]);
    const gig = g.gig || {};
    const poster = g.poster || gig.poster || {};
    const picked = new Set();
    const creds = c.credentials || [];
    const note = h('textarea', { class: 'area', maxlength: '1000', required: true });
    const send = btn('Send application', { block: true, type: 'submit' });
    const f = h('form', null, h('div', { class: 'pad' },
      h('p', { class: 'mute' }, gig.title + ' · ' + (poster.first_name || '')),
      h('h2', { class: 'lbl' }, 'Attach proof'),
      creds.length ? creds.map((cr) => {
        const b = h('button', { type: 'button', class: 'proof', aria: { pressed: 'false' } },
          h('div', { class: 'top' }, icon('shield', 'sm'), cr.issuer_name || cr.type || 'Signed credential'),
          h('div', { class: 's' }, cr.summary || ''),
          h('div', { class: 'by' }, icon('clock', 'sm'), cr.as_of ? 'as of ' + new Date(cr.as_of).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'no date', cr.valid === false ? ' · not valid' : ''));
        b.addEventListener('click', () => { const on = !picked.has(cr.id); if (on) picked.add(cr.id); else picked.delete(cr.id); b.setAttribute('aria-pressed', String(on)); });
        return b;
      }) : h('p', { class: 'hint' }, 'You have no signed proof yet. ', h('a', { class: 'linkish', href: '/me/proof' }, 'Add proof')),
      field('Note to ' + (poster.first_name || 'the poster'), note),
      h('p', { class: 'hint' }, icon('eye', 'sm'), (poster.first_name || 'The poster') + ' sees only what you attach.')),
    h('div', { class: 'stick' }, send));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!note.value.trim()) { note.focus(); toast('Add a short note', true); return; }
      send.disabled = true;
      try { await post('/gigs/' + enc(id) + '/applications', { note: note.value.trim(), credential_ids: [...picked] }); toast('Application sent'); nav('/gigs/' + enc(id), { replace: true }); }
      catch (x) { fail(x); send.disabled = false; }
    });
    return f;
  });
  return { node: h('div', null, appBar({ title: 'Apply', back: '/gigs/' + enc(id) }), node), title: 'Apply', tab: 'work', cls: 'nofab' };
}

/* ---------- applicants: pick on proof ---------- */

export function applicants({ params }) {
  const id = params.id;
  const node = later(async () => {
    const [g, r] = await Promise.all([get('/gigs/' + enc(id)), get('/gigs/' + enc(id) + '/applications')]);
    const gig = g.gig || {};
    const apps = r.applications || [];
    if (!apps.length) return empty('No applicants yet', 'People who apply show up here with the proof they chose to attach.');
    return [apps.map((a) => {
      const p = a.person || {};
      return h('div', { class: 'li top line' }, h('div', { class: 'grow' },
        personRow(p, h('span', { class: 'tag' }, a.status || 'sent'), '@' + p.handle + ' · ' + tradeLabel(p.trade) + ' · ' + timeAgo(a.created_at)),
        h('p', { class: 'pad pre' }, a.note || ''),
        (a.credentials || []).length ? h('div', { class: 'pad trust' }, a.credentials.map((c) => h('span', { class: 'okk' }, icon('shield', 'sm'), (c.summary || 'Signed credential') + (c.as_of ? ' · as of ' + new Date(c.as_of).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')))) : h('p', { class: 'pad hint' }, 'No proof attached'),
        h('div', { class: 'pad row mt' },
          gig.status === 'open' ? btn('Pick ' + (p.first_name || ''), { sm: true, on: async () => { if (!confirm('Pick ' + (p.first_name || 'this person') + '? The gig will be marked filled.')) return; try { await post('/applications/' + enc(a.id) + '/pick'); toast('Picked'); nav(location.pathname, { replace: true }); } catch (e) { fail(e); } } }) : null,
          a.status === 'picked' ? btn('Mark done', { sm: true, on: async () => { try { await post('/applications/' + enc(a.id) + '/done'); toast('Marked done'); nav('/gigs/' + enc(id) + '/rate'); } catch (e) { fail(e); } } }) : null,
          a.status === 'picked' || a.status === 'done' ? btn('Rate', { sm: true, kind: 'w', href: '/gigs/' + enc(id) + '/rate' }) : null,
          btn('Message', { sm: true, kind: 'w', on: async () => { try { const c = await post('/conversations', { handle: p.handle }); nav('/inbox/' + enc(c.conversation.id)); } catch (e) { fail(e); } } }))));
    }),
    h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'How pay works'), h('p', null, 'You pay the person directly, the way your gig says. When you both mark it done, you can rate each other. Community never holds your money.')))];
  });
  return { node: h('div', null, appBar({ title: 'Applicants', back: '/gigs/' + enc(id) }), node), title: 'Applicants', tab: 'work' };
}

/* ---------- rate on criteria ---------- */

export function rate({ params }) {
  const id = params.id;
  const v = {};
  const crit = [['on_time', 'On time'], ['quality', 'Quality of work'], ['easy', 'Easy to work with'], ['again', 'Would work with again']];
  const send = btn('Send', { block: true, type: 'submit', disabled: true });
  const scale = (k, label) => {
    const g = h('div', { class: 'scale', role: 'radiogroup', aria: { label } });
    for (let i = 1; i <= 5; i++) {
      const b = h('button', { type: 'button', role: 'radio', aria: { checked: 'false', label: label + ': ' + i + ' of 5' }, tabindex: i === 1 ? '0' : '-1' }, String(i));
      b.addEventListener('click', () => {
        v[k] = i;
        g.querySelectorAll('button').forEach((x, j) => { x.setAttribute('aria-checked', String(j + 1 === i)); x.tabIndex = j + 1 === i ? 0 : -1; });
        send.disabled = crit.some(([c]) => !v[c]);
      });
      g.append(b);
    }
    g.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const n = Math.min(5, Math.max(1, (v[k] || 0) + d));
      const b = g.children[n - 1]; b.focus(); b.click();
    });
    return h('div', { class: 'rate' }, h('span', null, label), g);
  };
  const f = h('form', { class: 'pad' }, h('p', { class: 'mute' }, 'Rate on each point, 1 (poor) to 5 (great). Ratings are shown on profiles as averages.'),
    crit.map(([k, l]) => scale(k, l)), h('div', { class: 'mt' }, send));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    send.disabled = true;
    try { await post('/gigs/' + enc(id) + '/ratings', v); toast('Thanks. Your rating is in.'); nav('/gigs/' + enc(id), { replace: true }); }
    catch (x) { fail(x); send.disabled = false; }
  });
  return { node: h('div', null, appBar({ title: 'How did it go?', back: '/gigs/' + enc(id) }), f), title: 'Rate', tab: 'work', cls: 'nofab' };
}

/* ---------- post a gig ---------- */

export function newGig() {
  if (!state.me) return { node: h('div', null, appBar({ title: 'Post a gig', back: '/work' }), errorBox({ status: 401 })), title: 'Post a gig' };
  const inp = (attrs) => h('input', attrs);
  const title = inp({ maxlength: '100', required: true, placeholder: 'Grill helper, Saturday nights' });
  const body = h('textarea', { class: 'area', maxlength: '2000', required: true, placeholder: 'What the work is, who it suits.' });
  const amount = inp({ type: 'number', min: '0', step: '1', inputmode: 'numeric', required: true });
  const unit = h('select', null, [['hour', 'an hour'], ['day', 'a day'], ['night', 'a night'], ['task', 'a task'], ['fixed', 'fixed'], ['week', 'a week'], ['month', 'a month']].map(([k, l]) => h('option', { value: k }, l)));
  const note = inp({ maxlength: '80', placeholder: 'plus dinner' });
  const when = inp({ maxlength: '80', required: true, placeholder: 'Saturdays, 6-11pm' });
  const how = inp({ maxlength: '80', required: true, list: 'paid-how', placeholder: 'Cash, end of each night' });
  const skills = inp({ maxlength: '200', placeholder: 'Food prep, Cash handling' });
  let area = state.me.home_area || null;
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { class: 'pad' },
    field('Title', title), field('Details', body),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Pay (₱)', amount)), h('div', { class: 'grow' }, field('Per', unit))),
    field('Pay note (optional)', note), field('When', when),
    field('Paid how', how, 'Community never holds money. Say how you will pay.'),
    h('datalist', { id: 'paid-how' }, ['Cash', 'GCash', 'Maya', 'Bank transfer'].map((x) => h('option', { value: x }))),
    field('Skills (comma separated)', skills),
    placeSearch('', (a) => { area = a ? a.code : state.me.home_area || null; }, 'Where (leave empty for your home area)'),
    err, h('div', { class: 'mt mb' }, btn('Post gig', { block: true, type: 'submit' })),
    h('p', { class: 'hint' }, icon('shield', 'sm'), 'Posting gigs needs the ID check.'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const r = await post('/gigs', {
        title: title.value.trim(), body: body.value.trim(), pay_amount: Number(amount.value), pay_unit: unit.value, pay_note: note.value.trim() || undefined,
        when_text: when.value.trim(), paid_how: how.value.trim(), skills: skills.value.split(',').map((s) => s.trim()).filter(Boolean), area_code: area || undefined,
      });
      toast('Gig posted');
      nav('/gigs/' + enc(r.gig.id), { replace: true });
    } catch (x) { err.textContent = x.message; }
  });
  return { node: h('div', null, appBar({ title: 'Post a gig', back: '/work' }), f), title: 'Post a gig', tab: 'work', cls: 'nofab' };
}
