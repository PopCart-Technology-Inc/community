// The Admin panel (decision 0009): the tools invited staff use, each shown only for its scope. Reports
// and appeals (reports.review), people (people.lookup, accounts.suspend), member invites (invites.send),
// health (ops.health), staging switches (switches.staging) and the live review (review.host).
import { h, icon } from '/static/lib/dom.js';
import { asOf, count, fullTime, timeAgo } from '/static/lib/format.js';
import { btn, buttonTabs, empty, fail, field, later, loading, toast } from '/static/ui.js';
import { enc, has, sget, spost } from './core.js';
import { confirmBox, dropdown } from './kit.js';
import { head, switches } from './overseer.js';
import { liveReview } from './review.js';

const REASON = { scam: 'Scam or fake gig', harassment: 'Harassment or hate', private_info: 'Private info', violence: 'Violence or threats', child_safety: 'Child safety', other: 'Something else' };
const DECISIONS = [['keep', 'Keep', 'w', 'k'], ['warn', 'Warn', 'y', 'w'], ['remove', 'Remove', 'e', 'r'], ['escalate', 'Escalate', 'w', 'e']];

/* ---------- Reports ---------- */

export function reports() {
  let tab = 'open';
  const list = h('div', { class: 'cards' });
  const load = () => list.replaceChildren(later(async () => {
    const r = await sget('/staff/reports', { status: tab === 'open' ? undefined : 'decided' });
    if (!r.reports.length) return empty(tab === 'open' ? 'No open reports' : 'Nothing decided yet', tab === 'open' ? 'Nothing is waiting for review.' : '');
    return [h('div', { class: 'cards' }, r.reports.map((x) => card(x, tab === 'open'))), h('p', { class: 'asof pad' }, asOf(r.as_of))];
  }, 'Reading reports'));
  function card(x, open) {
    const t = x.target || {};
    const what = t.body || t.title || (t.handle ? '@' + t.handle : null) || (t.sealed ? 'End-to-end encrypted: only what the reporter revealed is shown.' : 'The content is gone.');
    const el = h('article', { class: 'rp-card' + (x.reason === 'child_safety' ? ' cs' : ''), tabindex: open ? '0' : undefined, aria: { label: `${REASON[x.reason] || x.reason} report about a ${x.target_kind}` } },
      h('div', { class: 'row top' }, h('div', { class: 'grow' }, h('h3', null, REASON[x.reason] || x.reason),
        h('p', { class: 'mute' }, [x.target_kind, x.space ? 'in ' + x.space.slug : 'staff queue', timeAgo(x.created_at), x.hidden_on_report ? 'hidden at once' : null].filter(Boolean).join(' · '))),
        h('span', { class: 'tag ' + (x.status === 'escalated' ? 'e' : '') }, x.status)),
      h('blockquote', { class: 'pre' }, what),
      t.author ? h('p', { class: 'mute' }, 'By @' + t.author.handle) : null,
      x.note ? h('p', null, h('b', null, 'Reporter’s note: '), x.note) : null,
      x.reporter ? h('p', { class: 'mute' }, 'Reported by @' + x.reporter.handle) : null,
      x.revealed && x.revealed.length ? h('div', { class: 'note' }, h('div', null, h('b', null, 'Shown by the reporter'), x.revealed.map((m) => h('p', { class: 'pre' }, m.text || '')))) : null,
      x.decision_note ? h('p', { class: 'mute' }, 'Decision: ' + x.decision_note) : null,
      open ? h('div', { class: 'row wrap mt' }, DECISIONS.map(([a, label, kind, key]) => btn(label, { sm: true, kind, on: () => decide(x, a, label, el), aria: { keyshortcuts: key.toUpperCase() } })),
        h('span', { class: 'mute kbd-hint' }, 'K W R E')) : null);
    if (open) {
      el.addEventListener('keydown', (e) => {
        if (e.target !== el || e.ctrlKey || e.metaKey || e.altKey) return;
        const d = DECISIONS.find((d) => d[3] === e.key.toLowerCase());
        if (d) { e.preventDefault(); decide(x, d[0], d[1], el); }
      });
    }
    return el;
  }
  async function decide(x, action, label, el) {
    const needs = action === 'warn' || action === 'remove';
    const note = await confirmBox({ title: `${label}: ${REASON[x.reason] || x.reason}`, text: needs ? 'The person sees this note and can appeal once.' : 'Logged with your name in the staff audit log.',
      confirm: label, danger: action === 'remove', reason: needs ? 'Why, against the public rules' : 'Note (optional)', minReason: needs ? 3 : 0 });
    if (note === null) return;
    try {
      await spost(`/staff/reports/${enc(x.id)}/decide`, { action, note: note || undefined });
      const next = el.nextElementSibling;
      el.remove(); toast('Done: ' + label.toLowerCase());
      if (next && next.tabIndex === 0) next.focus();
    } catch (e) { fail(e); }
  }
  load();
  return { title: 'Reports', node: h('div', null, head('Reports', 'From every Space, and the staff-only queue. Child-safety reports only with that scope.'),
    h('div', { class: 'pad mb' }, buttonTabs([['open', 'Open'], ['decided', 'Decided']], tab, (k) => { tab = k; load(); }, 'Reports')), list) };
}

/* ---------- Appeals ---------- */

export function appeals() {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/appeals');
    if (!r.appeals.length) return empty('No appeals waiting', 'People can appeal a warning, a removal or a suspension once.');
    return [h('div', { class: 'cards' }, r.appeals.map((a) => h('article', { class: 'rp-card' },
      h('h3', null, `${a.action} · ${a.target_kind}`), h('p', { class: 'mute' }, `${a.subject ? '@' + a.subject.handle : 'Deleted account'} · appealed ${timeAgo(a.appealed_at)}`),
      h('p', null, h('b', null, 'Reason given: '), a.reason || '—'), h('blockquote', { class: 'pre' }, a.appeal_note),
      a.can_decide ? h('div', { class: 'row wrap mt' }, [['upheld', 'Uphold', 'w'], ['overturned', 'Overturn', 'y']].map(([d, label, kind]) => btn(label, { sm: true, kind, on: async () => {
        const note = await confirmBox({ title: label + ' this appeal?', text: d === 'overturned' ? 'The content comes back, or the suspension is lifted.' : 'The decision stands.', confirm: label, reason: 'Note (the person sees this)' });
        if (note === null) return;
        try { await spost(`/staff/appeals/${enc(a.id)}/decide`, { decision: d, note }); toast('Decided'); load(); } catch (e) { fail(e); }
      } }))) : h('p', { class: 'mute' }, 'Another staff member decides this one: you took the action, or it is about you.')))),
      h('p', { class: 'asof pad' }, asOf(r.as_of))];
  }, 'Reading appeals'));
  load();
  return { title: 'Appeals', node: h('div', null, head('Appeals', 'Decided by a different staff member from the one who acted.'), box) };
}

/* ---------- People ---------- */

export function people() {
  const results = h('div', { class: 'st-log', aria: { live: 'polite' } });
  let timer = null, seq = 0;
  const q = h('input', { maxlength: '31', placeholder: 'username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = q.value.trim(), n = ++seq;
      if (v.replace(/^@/, '').length < 2) { results.replaceChildren(); return; }
      results.replaceChildren(loading('Looking'));
      try {
        const r = await sget('/staff/people', { q: v });
        if (n !== seq) return;
        results.replaceChildren(...(r.people.length ? r.people.map((p) => h('a', { class: 'srow', href: '/admin/people/' + enc(p.handle) },
          h('div', { class: 'grow' }, h('b', null, '@' + p.handle), h('div', { class: 'mute' }, p.first_name)), p.status !== 'active' ? h('span', { class: 'tag e' }, p.status) : null, icon('chev', 'sm')))
          : [empty('No one by that name', 'Look-alikes count: 0 finds o, 1 finds i.')]));
      } catch (e) { if (n === seq) results.replaceChildren(empty('Could not look', e.message)); }
    }, 300);
  });
  return { title: 'People', node: h('div', null, head('People', 'Public profile and account status only. Every lookup is logged and shows in that person\'s record log.'),
    h('div', { class: 'pad mb' }, field('Find by username', q)), results) };
}

export function person({ handle }) {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/people/' + enc(handle));
    const p = r.person;
    const facts = [['Status', p.status === 'suspended' ? `Suspended${p.suspended_until ? ' until ' + fullTime(p.suspended_until) : ''}` : p.status], ['Joined', fullTime(p.created_at)],
      ['Staff role', p.staff_role || 'none'], ['Posts', count(p.posts)], ['Moderation actions', count(p.actions)], ['ID checked', p.id_checked ? 'yes' : 'no']];
    let actions = null;
    if (has('accounts.suspend')) {
      if (p.status === 'active') {
        let days = '7';
        actions = h('div', { class: 'st-card' }, h('h2', null, 'Suspend'), h('p', { class: 'mute' }, 'Signs them out everywhere. It lifts on its own; they can appeal once.'),
          h('div', { class: 'row wrap mt' }, dropdown([['1', '1 day'], ['3', '3 days'], ['7', '7 days']], days, (v) => { days = v; }, 'For how long'),
            btn('Suspend', { kind: 'e', on: async () => {
              const reason = await confirmBox({ title: `Suspend @${p.handle} for ${days} ${days === '1' ? 'day' : 'days'}?`, text: 'They are told why and can appeal once.', confirm: 'Suspend', danger: true, reason: 'Why, against the public rules' });
              if (reason === null) return;
              try { await spost(`/staff/people/${enc(p.handle)}/suspend`, { days: Number(days), reason }); toast('Suspended'); load(); } catch (e) { fail(e); }
            } })));
      } else if (p.status === 'suspended') {
        actions = h('div', { class: 'st-card' }, h('h2', null, 'Lift the suspension'), h('p', { class: 'mute' }, 'They can sign in again at once.'),
          h('div', { class: 'mt' }, btn('Lift now', { kind: 'w', on: async () => {
            const reason = await confirmBox({ title: `Lift @${p.handle}'s suspension?`, confirm: 'Lift', reason: 'Why (they see this)' });
            if (reason === null) return;
            try { await spost(`/staff/people/${enc(p.handle)}/unsuspend`, { reason }); toast('Lifted'); load(); } catch (e) { fail(e); }
          } })));
      }
    }
    return [head('@' + p.handle, p.first_name, r.as_of, load),
      h('dl', { class: 'facts st-card' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      actions,
      h('h2', { class: 'sect' }, 'Moderation history'),
      h('div', { class: 'st-log' }, r.history.length ? r.history.map((a) => h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, `${a.action} · ${a.target_kind}`), h('div', { class: 'mute' }, a.reason || '—')),
        h('span', { class: 'mute' }, timeAgo(a.created_at)), a.appeal_decision ? h('span', { class: 'tag' }, 'appeal ' + a.appeal_decision) : a.appealed_at ? h('span', { class: 'tag y' }, 'appealed') : null)) : empty('Nothing on record', ''))];
  }, 'Reading the account'));
  load();
  return { title: '@' + handle, node: h('div', null, h('div', { class: 'pad' }, h('a', { class: 'linkbtn', href: '/admin/people' }, '‹ People')), box) };
}

/* ---------- Member invites ---------- */

export function invite() {
  const email = h('input', { type: 'email', autocomplete: 'off', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: '254' });
  const note = h('input', { maxlength: '80', placeholder: 'Only staff see this' });
  const err = h('p', { class: 'err', role: 'alert' }), done = h('div', { aria: { live: 'polite' } });
  const f = h('form', { class: 'st-card', novalidate: true },
    h('p', { class: 'mute' }, 'They get an email with the join page. Joining needs this address and a code sent to it, so the invite can\'t be passed on.'),
    field('Email address', email), h('div', { class: 'mt' }, field('Note (optional)', note)), err, h('div', { class: 'mt' }, btn('Send invite', { block: true, type: 'submit', icon: 'send' })), done,
    h('p', { class: 'hint' }, icon('lock', 'sm'), 'The address is used to send the invite and kept only as a keyed hash. Inviting the same address again renews it for 7 days.'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; done.replaceChildren();
    const v = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { err.textContent = 'Type a full email address.'; email.focus(); return; }
    try {
      const r = await spost('/staff/member-invites', { email: v, note: note.value.trim() || undefined });
      done.replaceChildren(h('div', { class: 'note-ok mt' }, icon('check', 'sm'), h('span', null, 'Invite sent. It works until ' + fullTime(r.expires_at) + '.')));
      email.value = ''; note.value = '';
    } catch (x) { err.textContent = x.message; }
  });
  return { title: 'Invite a member', node: h('div', null, head('Invite a member', 'Joining is by invite while Community is invite-only.'), f) };
}

/* ---------- Health ---------- */

export function health() {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/health');
    const up = r.uptime_s < 3600 ? Math.round(r.uptime_s / 60) + ' min' : r.uptime_s < 172800 ? Math.round(r.uptime_s / 3600) + ' h' : Math.round(r.uptime_s / 86400) + ' d';
    const tile = (label, big, sub, ok) => h('div', { class: 'tile' + (ok === false ? ' hot' : '') }, h('span', { class: 'mono mute' }, label), h('b', { class: 'big' }, big), sub ? h('span', { class: 'mute' }, sub) : null);
    return [head('Health', 'The server, the database and the migrations. Never personal data.', r.as_of, load),
      h('div', { class: 'tiles' }, tile('Version', r.version, 'Node ' + r.node), tile('Up for', up, 'since ' + fullTime(r.started_at)),
        tile('Database', r.db.ok ? 'OK' : 'Down', r.db.ms + ' ms to answer', r.db.ok), tile('Migrations', String(r.migrations.n), r.migrations.last), tile('Feature switches read', r.stage, ''))];
  }, 'Checking'));
  load();
  return { title: 'Health', node: box };
}

export const ADMIN_NAV = [
  ['/admin', 'Reports', 'flag', 'reports.review', reports],
  ['/admin/appeals', 'Appeals', 'scale', 'reports.review', appeals],
  ['/admin/people', 'People', 'search', 'people.lookup', people],
  ['/admin/invite', 'Invite a member', 'mail', 'invites.send', invite],
  ['/admin/switches', 'Feature switches', 'sliders', 'switches.staging', switches],
  ['/admin/health', 'Health', 'gear', 'ops.health', health],
  ['/admin/review', 'Live review', 'star', 'review.host', liveReview],
];
