// Safety and your data: report, what we hold (export, delete), who opened my records, moderator
// actions and appeals, the transparency report ("No numbers yet" before launch) and the mod queue.
import { h, icon } from '../lib/dom.js';
import { del, get, patch, post } from '../lib/api.js';
import { asOf, fullTime, timeAgo } from '../lib/format.js';
import { nav, state } from '../core.js';
import { appBar, avatar, btn, empty, errorBox, fail, field, later, sheet, toast, toggle } from '../ui.js';

const enc = encodeURIComponent;
const needMe = (title, back) => ({ node: h('div', null, appBar({ title, back }), errorBox({ status: 401 })), title });

export const REASONS = [
  ['scam', 'Scam or fake gig'], ['harassment', 'Harassment or hate'], ['private_info', 'Someone\'s private info'],
  ['violence', 'Violence or threats'], ['child_safety', 'Child safety'], ['other', 'Something else'],
];

/* ---------- report ---------- */

export function report({ query }) {
  if (!state.me) return needMe('Report', '/');
  const kind = query.get('kind') || 'post';
  const id = query.get('id') || '';
  const name = query.get('name') || '';
  let reason = '';
  const note = h('textarea', { class: 'area', maxlength: '500' });
  const send = btn('Send report', { block: true, type: 'submit', disabled: true });
  const f = h('form', null,
    h('p', { class: 'pad h1' }, kind === 'post' ? 'What\'s wrong with this post?' : 'What\'s wrong?'),
    h('p', { class: 'pad mute' }, (name || 'They') + ' won\'t see who reported.'),
    h('fieldset', { class: 'menu pad' }, h('legend', { class: 'sr' }, 'Reason'), REASONS.map(([k, lab]) => {
      const r = h('input', { type: 'radio', name: 'reason', value: k });
      r.addEventListener('change', () => { reason = k; send.disabled = false; });
      return h('label', { class: 'li' }, h('span', { class: 'grow' }, lab), r);
    })),
    h('div', { class: 'pad' }, field('Anything else? (optional)', note),
      h('p', { class: 'hint' }, icon('shield', 'sm'), 'Child safety goes straight to trained staff, and the content is hidden at once.')),
    h('div', { class: 'stick' }, send));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!id) { toast('Nothing to report', true); return; }
    send.disabled = true;
    try {
      await post('/reports', { target_kind: kind, target_id: id, reason, note: note.value.trim() || undefined });
      toast(reason === 'child_safety' ? 'Sent to trained staff. Thank you.' : 'Report sent. Thank you.');
      if (history.state && history.state.n > 0) history.back(); else nav('/', { replace: true });
    } catch (x) { fail(x); send.disabled = false; }
  });
  return { node: h('div', null, appBar({ title: 'Report', back: '/' }), f), title: 'Report', cls: 'nofab' };
}

/* ---------- your data ---------- */

export function data() {
  if (!state.me) return needMe('Your data', '/me/settings');
  const holds = later(async () => {
    const r = await get('/me/data');
    const hs = r.holds || [];
    if (!hs.length) return h('p', { class: 'pad mute' }, 'Nothing listed.');
    return [h('div', { class: 'group' }, hs.map((x) => h('div', { class: 'li top' }, icon(x.sealed ? 'lock' : 'user'),
      h('div', { class: 'grow' }, h('div', { class: 't1' }, x.label || x.what || x.name || ''), h('div', { class: 't2 pre' }, [x.detail || x.why || x.description, x.kept || x.retention].filter(Boolean).join(' · '))),
      x.count !== undefined && x.count !== null ? h('span', { class: 'tag' }, String(x.count)) : (x.sealed ? h('span', { class: 'tag k' }, 'Sealed') : null)))),
    r.as_of ? h('p', { class: 'asof' }, asOf(r.as_of)) : null];
  });
  const confirmIn = h('input', { autocomplete: 'off', placeholder: 'DELETE' });
  const delForm = h('form', { class: 'pad' }, h('p', { class: 'mute' }, 'Your posts and profile are removed and you are signed out everywhere. Records under a legal hold are kept as the law requires. This cannot be undone.'),
    field('Type DELETE to confirm', confirmIn), h('div', { class: 'mt mb' }, btn('Delete my account', { block: true, kind: 'e', type: 'submit', icon: 'trash' })));
  delForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (confirmIn.value.trim() !== 'DELETE') { toast('Type DELETE in capitals to confirm', true); return; }
    try { await del('/me', { confirm: 'DELETE' }); state.me = null; window.dispatchEvent(new Event('cm:auth')); toast('Your account is deleted'); nav('/', { replace: true }); }
    catch (x) { fail(x); }
  });
  const me = state.me;
  const node = h('div', { class: 'cream-page' }, appBar({ title: 'Your data', back: '/me/settings' }),
    h('h2', { class: 'sect' }, 'What we hold about you'), holds,
    h('h2', { class: 'sect' }, 'Your choices'),
    h('div', { class: 'group' }, h('div', { class: 'li' }, h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Usage and errors')), toggle(!!me.improve_usage, 'Usage and errors', async (v) => { await patch('/me', { improve_usage: v }); me.improve_usage = v; })),
      h('div', { class: 'li' }, h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Surveys and tests')), toggle(!!me.improve_surveys, 'Surveys and tests', async (v) => { await patch('/me', { improve_surveys: v }); me.improve_surveys = v; }))),
    h('h2', { class: 'sect' }, 'Your records'),
    h('div', { class: 'group' },
      h('a', { class: 'li', href: '/me/records' }, icon('eye'), h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Who opened my records')), icon('chev', 'sm')),
      h('a', { class: 'li', href: '/api/me/export', download: 'community-export.json' }, icon('download'), h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Download everything'), h('div', { class: 't2' }, 'A JSON file of everything about you')))),
    h('h2', { class: 'sect' }, 'Delete my account'), h('div', { class: 'group' }, delForm));
  return { node, title: 'Your data', tab: 'me' };
}

/* ---------- who opened my records ---------- */

export function records() {
  if (!state.me) return needMe('Record log', '/me/data');
  const node = later(async () => {
    const r = await get('/me/record-log');
    const os = r.openings || [];
    const top = os.length
      ? h('div', null, h('h2', { class: 'sect' }, 'Openings'), h('div', { class: 'group' }, os.map((o) => h('div', { class: 'li top' }, icon('scale'), h('div', { class: 'grow' },
        h('div', { class: 't1' }, fullTime(o.opened_at || o.created_at)), h('div', { class: 't2 pre' }, [o.basis || o.legal_basis, o.approvers && ('Approved by ' + [].concat(o.approvers).join(' and ')), o.produced && ('Handed over: ' + o.produced)].filter(Boolean).join('\n')))))))
      : h('div', { class: 'note k' }, icon('lock', 'lg'), h('div', null, h('b', null, 'Never opened'), h('p', null, 'Your sealed records have not been opened. ' + asOf(r.as_of) + '.')));
    return [top,
      h('h2', { class: 'sect' }, 'If they are ever opened, you\'ll see'),
      h('div', { class: 'group' }, [['cal', 'When'], ['scale', 'Which court order'], ['users', 'The two people who approved'], ['download', 'Exactly what was handed over']].map(([ic, t]) => h('div', { class: 'li' }, icon(ic), h('div', { class: 'grow t1' }, t)))),
      h('p', { class: 'pad hint' }, 'You\'re told when it happens, unless the law forbids it for a time.'),
      h('div', { class: 'pad' }, btn('Transparency report', { kind: 'w', sm: true, href: '/transparency' }))];
  });
  return { node: h('div', { class: 'cream-page' }, appBar({ title: 'Record log', back: '/me/data' }), node), title: 'Record log', tab: 'me' };
}

/* ---------- what moderators did ---------- */

export function actions() {
  if (!state.me) return needMe('Moderator actions', '/me/settings');
  const node = later(async () => {
    const r = await get('/me/mod-actions');
    const as = r.actions || [];
    if (!as.length) return empty('Nothing here', 'No moderator has acted on anything you posted.');
    return as.map((a) => h('div', { class: 'job' }, h('div', { class: 'row' }, h('span', { class: 'tag' + (a.action === 'remove' ? ' k' : '') }, a.action), h('span', { class: 'mute grow' }, timeAgo(a.created_at))),
      h('p', { class: 'pre' }, a.note || a.reason || ''),
      a.appealed_at || a.appeal ? h('p', { class: 'hint' }, 'Appeal sent' + (a.appeal_outcome ? ' · ' + a.appeal_outcome : '')) :
        btn('Appeal', { sm: true, kind: 'w', on: () => sheet('Appeal', (close) => {
          const ta = h('textarea', { class: 'area', maxlength: '500', required: true });
          const f = h('form', null, h('h2', null, 'Appeal this decision'), h('p', { class: 'mute' }, 'A different moderator decides. You can appeal once.'), field('Why it should be undone', ta), h('div', { class: 'mt' }, btn('Send appeal', { block: true, type: 'submit' })));
          f.addEventListener('submit', async (e) => { e.preventDefault(); try { await post('/me/mod-actions/' + enc(a.id) + '/appeal', { note: ta.value.trim() }); close(); toast('Appeal sent'); nav(location.pathname, { replace: true }); } catch (x) { fail(x); } });
          return f;
        }) })));
  });
  return { node: h('div', null, appBar({ title: 'Moderator actions', back: '/me/settings' }), node), title: 'Moderator actions', tab: 'me' };
}

/* ---------- transparency ---------- */

export function transparency() {
  const node = later(async () => {
    const r = await get('/transparency');
    const c = r.counts || {};
    const rows = [['Legal requests received', c.legal_requests], ['Records handed over', c.produced], ['Requests refused', c.refused], ['Posts removed', c.posts_removed], ['Reports', c.reports]];
    return [
      h('h1', { class: 'h1', tabindex: '-1' }, 'Every request, counted.'), h('p', { class: 'mute' }, 'Twice a year, plus live counts.'),
      rows.map(([l, v]) => h('div', { class: 'rate' }, h('span', null, l), h('span', { class: 'bignum' }, r.launched ? String(v ?? 0) : '—'))),
      r.launched ? h('p', { class: 'asof' }, 'Live · ' + asOf(r.as_of)) :
        h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'No numbers yet.'), h('p', null, 'Community hasn\'t launched. The first report comes six months after launch. We never show made-up numbers.'))),
    ];
  });
  return { node: h('div', null, appBar({ title: 'Transparency', back: '/' }), h('div', { class: 'pad' }, node)), title: 'Transparency' };
}

/* ---------- moderator queue ---------- */

export function mod({ query }) {
  if (!state.me) return needMe('Reports', '/');
  const space = query.get('space') || '';
  const node = later(async () => {
    let r;
    try { r = await get('/mod/reports', { space: space || undefined }); }
    catch (e) { if (e.status === 403) return empty('Moderators only', 'Space moderators see their Space\'s reports; staff see the rest.'); throw e; }
    const rs = r.reports || [];
    return [rs.length ? rs.map(card) : empty('No open reports', 'Nothing is waiting for review.'),
      h('div', { class: 'note k' }, icon('shield'), h('div', null, h('b', null, 'Child safety never comes here.'), h('p', null, 'Trained staff take it down, preserve it and report it.'))),
      r.as_of ? h('p', { class: 'asof' }, asOf(r.as_of)) : null];
  });
  return { node: h('div', null, appBar({ title: space ? 'Reports · ' + space : 'Reports', back: space ? '/s/' + enc(space) : '/me/settings' }), node), title: 'Reports' };
}

function card(r) {
  const who = r.target_author || r.author || r.person;
  const reason = (REASONS.find((x) => x[0] === r.reason) || [r.reason, r.reason])[1];
  const el = h('div', { class: 'job' },
    h('div', { class: 'row' }, who ? avatar(who, 's') : null, h('div', { class: 'grow' },
      h('div', { class: 't1' }, reason || 'Report'), h('div', { class: 'm' }, [r.target_kind, (r.reports_count || r.count) ? (r.reports_count || r.count) + ' reports' : null, timeAgo(r.created_at) + ' ago'].filter(Boolean).join(' · '))),
      h('span', { class: 'tag' }, r.status || 'open')),
    r.excerpt || r.target_body || r.note ? h('p', { class: 'pre' }, r.excerpt || r.target_body || r.note) : null,
    r.revealed && r.revealed.length ? h('div', { class: 'note' }, h('div', null, h('b', null, 'Shown by the reporter'), r.revealed.map((m) => h('p', { class: 'pre' }, m.text || '')))) : null,
    r.target_kind === 'post' && r.target_id ? h('a', { class: 'linkish', href: '/p/' + enc(r.target_id) }, 'Open the post') : null,
    h('div', { class: 'row wrap mt' }, [['keep', 'Keep', 'w'], ['warn', 'Warn', 'y'], ['remove', 'Remove', 'e'], ['escalate', 'Escalate', 'w']].map(([action, label, kind]) =>
      btn(label, { sm: true, kind, on: () => decide(r, action, label, el) }))));
  return el;
}

function decide(r, action, label, el) {
  sheet(label, (close) => {
    const ta = h('textarea', { class: 'area', maxlength: '500', required: true });
    const f = h('form', null, h('h2', null, label + ': say why'), h('p', { class: 'mute' }, 'The person sees this note and can appeal once. Every action is logged.'),
      field('Note, against the public rules', ta), h('div', { class: 'mt' }, btn(label, { block: true, type: 'submit' })));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!ta.value.trim()) { ta.focus(); return; }
      try { await post('/mod/reports/' + enc(r.id) + '/decide', { action, note: ta.value.trim() }); close(); el.remove(); toast('Done: ' + label.toLowerCase()); } catch (x) { fail(x); }
    });
    return f;
  });
}
