// The Overseer panel (decision 0009): Overview, Approvals, Staff, Roles & scopes, Audit log, Platform
// switches and Vault requests. Every number comes from the server with the time it was read.
import { h, icon } from '/static/lib/dom.js';
import { asOf, count, fullTime, plural, timeAgo } from '/static/lib/format.js';
import { btn, buttonTabs, choiceChips, empty, fail, field, later, loading, toast } from '/static/ui.js';
import { enc, go, has, sdel, sget, spost, sput } from './core.js';
import { checkbox, confirmBox, dropdown, leftText, ring, spark, undoToast } from './kit.js';

const KIND_LABEL = {
  session: 'Sign-in', staff: 'Staff', role: 'Roles', invite: 'Invites', report: 'Reports', appeal: 'Appeals',
  account: 'Accounts', switch: 'Switches', approval: 'Approvals', vault: 'Vault', audit: 'Audit', review: 'Live review',
};
const DAYS = [['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '365 days']];
const STALE_MS = 5 * 60_000;

/** The page head: title, a line under it, and the time the data was read (red after 5 minutes). */
export function head(title, sub, iso, refresh) {
  const t = iso ? h('span', { class: 'asof-pill' + (Date.now() - Date.parse(iso) > STALE_MS ? ' stale' : ''), title: fullTime(iso) }, icon('clock', 'sm'), asOf(iso)) : null;
  if (t && refresh) {
    const tick = setInterval(() => { if (!t.isConnected) clearInterval(tick); else t.classList.toggle('stale', Date.now() - Date.parse(iso) > STALE_MS); }, 30_000);
  }
  return h('header', { class: 'pg-head' }, h('div', { class: 'grow' }, h('h1', null, title), sub ? h('p', { class: 'mute' }, sub) : null),
    h('div', { class: 'row' }, t, refresh ? btn('Refresh', { sm: true, kind: 'w', on: refresh, aria: { label: 'Read again' } }) : null));
}

export function entry(e) {
  return h('article', { class: 'st-entry' },
    h('p', { class: 'what' }, h('b', null, '@' + e.who), ' ', e.text, e.subject ? [' · ', h('b', null, '@' + e.subject)] : null),
    h('div', { class: 'meta' }, h('span', { class: 'tag' }, KIND_LABEL[e.kind] || e.kind), h('time', { datetime: e.at, title: fullTime(e.at) }, timeAgo(e.at) + ' · ' + fullTime(e.at))));
}

/* ---------- Overview ---------- */

export function overview() {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const o = await sget('/staff/overview');
    const tile = (path, label, big, sub, chart, hot) => h('a', { class: 'tile' + (hot ? ' hot' : ''), href: path },
      h('span', { class: 'mono mute' }, label), h('b', { class: 'big' }, big), sub ? h('span', { class: 'mute' }, sub) : null, chart);
    const needs = o.needs.length
      ? h('div', { class: 'needs' }, o.needs.map((n) => h('a', { class: 'need', href: { approvals: '/overseer/approvals', reports: '/admin', staff: '/overseer/staff' }[n.kind] },
        h('b', null, count(n.count)), h('span', null, n.text), icon('chev', 'sm'))))
      : h('div', { class: 'need clear' }, icon('check'), h('span', null, 'All clear. Nothing is waiting on you.'));
    return [head('Overview', 'What needs you, and Community in four numbers.', o.as_of, load),
      h('h2', { class: 'sect' }, 'Needs you'), needs,
      h('div', { class: 'tiles' },
        tile('/admin/people', 'People', count(o.people.total), `+${count(o.people.week)} this week`, spark(o.people.series, 'line', 'Active accounts over 8 weeks: ' + o.people.series.join(', '))),
        o.reports ? tile('/admin', 'Open reports', count(o.reports.open), 'last 7 days below', spark(o.reports.series, 'bars', 'Reports per day, last 7 days: ' + o.reports.series.join(', ')), o.reports.open > 0) : null,
        o.staff ? tile('/overseer/staff', 'Staff', count(o.staff.total), o.staff.ending ? `${o.staff.ending} ${plural(o.staff.ending, 'role ends', 'roles end')} within 14 days` : 'no role ends soon') : null,
        tile('/overseer/switches', 'Joining', o.joining.invite_only ? 'Invite only' : 'Open', o.switches.read_only ? 'Read-only mode is ON' : (o.switches.launched ? 'Launched' : 'Not launched'), null, o.switches.read_only)),
      o.latest ? h('section', null, h('div', { class: 'row sect-row' }, h('h2', { class: 'sect grow' }, 'Latest activity'), h('a', { class: 'linkbtn', href: '/overseer/audit' }, 'View all')),
        h('div', { class: 'st-log' }, o.latest.length ? o.latest.map(entry) : empty('No staff actions yet', ''))) : null];
  }, 'Reading Community'));
  load();
  return { title: 'Overview', node: box };
}

/* ---------- Approvals ---------- */

export function approvals() {
  let tab = 'waiting';
  const list = h('div');
  const load = () => list.replaceChildren(later(async () => {
    const r = await sget('/staff/approvals', { status: tab });
    const only = r.overseers < 2 ? h('div', { class: 'note k' }, icon('info'), h('div', null, h('b', null, 'You are the only Overseer.'),
      h('p', null, 'Requests here wait for a second Overseer. Until there is one, these changes are made with npm run staff on the server.'))) : null;
    if (!r.approvals.length) return [only, empty(tab === 'waiting' ? 'Nothing waiting' : 'No decided requests yet', tab === 'waiting' ? 'Requests that need a second Overseer show here for 72 hours.' : '')];
    return [only, r.approvals.map((a) => card(a, r.window_hours)), h('p', { class: 'asof pad' }, asOf(r.as_of))];
  }, 'Reading requests'));
  function card(a, windowH) {
    const left = (Date.parse(a.expires_at) - Date.now()) / (windowH * 3600e3);
    const status = { waiting: 'Waiting', approved: 'Approved', declined: 'Declined', withdrawn: 'Withdrawn', expired: 'Expired' }[a.status];
    const steps = h('ol', { class: 'steps-row', aria: { label: 'Progress' } },
      h('li', { class: 'done' }, 'Asked'), h('li', { class: a.status === 'waiting' ? 'now' : 'done' }, 'Second Overseer'),
      h('li', { class: a.status === 'approved' ? 'done' : '' }, a.status === 'approved' ? 'Carried out' : a.status === 'waiting' ? 'Carried out' : status));
    const act = async (verb) => {
      const reason = verb === 'decline' ? await confirmBox({ title: 'Decline this request?', text: a.title, confirm: 'Decline', danger: true, reason: 'Why (the asker sees this)' })
        : await confirmBox({ title: verb === 'approve' ? 'Approve and carry it out?' : 'Withdraw your request?', text: a.title + (verb === 'approve' ? '. The change is made now, and both of you are named in the audit log.' : ''), confirm: verb === 'approve' ? 'Approve' : 'Withdraw' });
      if (reason === null) return;
      try { await spost(`/staff/approvals/${enc(a.id)}/${verb}`, verb === 'decline' ? { reason } : {}); toast({ approve: 'Approved and carried out', decline: 'Declined', withdraw: 'Withdrawn' }[verb]); load(); } catch (e) { fail(e); load(); }
    };
    return h('article', { class: 'ap-card' },
      h('div', { class: 'row top' }, a.status === 'waiting' ? h('div', { class: 'ring-w' }, ring(left, `${leftText(a.expires_at)} left of 72 hours`), h('span', null, leftText(a.expires_at))) : null,
        h('div', { class: 'grow' }, h('h3', null, a.title),
          h('p', { class: 'mute' }, `Asked by @${a.asked_by_handle} · ${timeAgo(a.asked_at)}`, a.decided_by_handle ? ` · ${status.toLowerCase()} by @${a.decided_by_handle}` : '', a.reason ? ` · “${a.reason}”` : '')),
        h('span', { class: 'tag ' + (a.status === 'approved' ? 'ok' : a.status === 'waiting' ? 'y' : '') }, status)),
      steps,
      a.status === 'waiting' ? h('div', { class: 'row wrap mt' },
        a.can_decide ? [btn('Approve', { sm: true, icon: 'check', on: () => act('approve') }), btn('Decline', { sm: true, kind: 'w', on: () => act('decline') })]
          : h('span', { class: 'mute' }, 'Waiting for another Overseer.'),
        a.mine ? btn('Withdraw', { sm: true, kind: 'w', on: () => act('withdraw') }) : null) : null);
  }
  load();
  return { title: 'Approvals', node: h('div', null, head('Approvals', 'A second Overseer must approve these within 72 hours. When time runs out nothing happens.'),
    h('div', { class: 'pad mb' }, buttonTabs([['waiting', 'Waiting'], ['done', 'Decided']], tab, (k) => { tab = k; load(); }, 'Requests')), list) };
}

/* ---------- Staff ---------- */

export function staff() {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/members');
    const roleOpts = r.roles.map((n) => [n, n, n === 'Overseer' ? 'needs a second Overseer' : null]);
    const rows = r.staff.map((s) => {
      const ends = s.ends_at ? (Date.parse(s.ends_at) - Date.now() < 14 * 86400e3 ? h('span', { class: 'tag e' }, 'ends in ' + leftText(s.ends_at)) : h('span', { class: 'mute' }, 'until ' + new Date(s.ends_at).toLocaleDateString())) : h('span', { class: 'mute' }, 'no end date');
      const actions = h('div', { class: 'row wrap' });
      if (s.role !== 'Overseer') {
        actions.append(
          btn('Renew 90 days', { sm: true, kind: 'w', on: async () => { try { await spost(`/staff/members/${enc(s.handle)}/renew`, { days: 90 }); toast('Renewed'); load(); } catch (e) { fail(e); } } }),
          dropdown(roleOpts, s.role, async (v) => {
            try {
              const x = await spost('/staff/members', { handle: s.handle, role: v, days: 90 });
              toast(x && x.approval ? 'Asked a second Overseer' : 'Role changed to ' + v); load();
            } catch (e) { fail(e); load(); }
          }, 'Role for @' + s.handle));
      }
      actions.append(btn('Remove', { sm: true, kind: 'w', icon: 'x', on: async () => {
        if (s.role === 'Overseer') {
          if ((await confirmBox({ title: `Remove @${s.handle} as an Overseer?`, text: 'A second Overseer must approve within 72 hours.', confirm: 'Ask', danger: true })) === null) return;
          try { await sdel(`/staff/members/${enc(s.handle)}`); toast('Asked a second Overseer'); go('/overseer/approvals'); } catch (e) { fail(e); load(); }
          return;
        }
        if (!(await undoToast(`Removing @${s.handle} as ${s.role}…`))) return;
        try { await sdel(`/staff/members/${enc(s.handle)}`); toast(`@${s.handle} is no longer ${s.role}`); load(); } catch (e) { fail(e); load(); }
      } }));
      return h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, '@' + s.handle), h('div', { class: 'row wrap' }, h('span', { class: 'tag ' + (s.role === 'Overseer' ? 'k' : '') }, s.role), ends,
        s.granted_by ? h('span', { class: 'mute' }, 'by @' + s.granted_by) : null)), actions);
    });
    const invites = r.invites.length ? h('div', { class: 'st-log' }, r.invites.map((i) => h('div', { class: 'srow' },
      h('div', { class: 'grow' }, h('b', null, i.role + (i.days ? ` · ${i.days} days` : '')), h('div', { class: 'mute' }, `Invited by @${i.invited_by || 'the server'} · open until ${new Date(i.expires_at).toLocaleDateString()}`, i.note ? ` · ${i.note}` : '')),
      btn('Cancel', { sm: true, kind: 'w', on: async () => { if (!(await undoToast('Cancelling the invite…'))) return; try { await sdel('/staff/invites/' + i.id); toast('Invite cancelled'); load(); } catch (e) { fail(e); } } })))) : null;
    return [head('Staff', `${r.staff.length} ${plural(r.staff.length, 'person holds', 'people hold')} a staff role. Roles other than Overseer end unless renewed.`, r.as_of, load),
      h('div', { class: 'st-log' }, rows),
      h('div', { class: 'two' }, giveForm(r, roleOpts, load), inviteForm(r, load)),
      invites ? [h('h2', { class: 'sect' }, 'Invites not yet accepted'), invites] : null];
  }, 'Reading staff'));
  load();
  return { title: 'Staff', node: box };
}

function giveForm(r, roleOpts, reload) {
  let role = r.roles.find((n) => n !== 'Overseer') || 'Overseer', days = '90';
  const who = h('input', { maxlength: '31', placeholder: 'username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const email = h('input', { type: 'email', maxlength: '254', placeholder: 'only to open the staff host', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { class: 'st-card', novalidate: true }, h('h2', null, 'Give a role'), h('p', { class: 'mute' }, 'To someone who already has an account.'),
    field('Username', who), h('div', { class: 'mt' }, h('span', { class: 'lbl' }, 'Role'), dropdown(roleOpts, role, (v) => { role = v; }, 'Role')),
    h('div', { class: 'mt' }, h('span', { class: 'lbl' }, 'For'), dropdown(DAYS, days, (v) => { days = v; }, 'For how long')),
    h('div', { class: 'mt' }, field('Their gate address (optional)', email, 'Kept only as a keyed hash, to match the address the gate lets in.')), err,
    h('div', { class: 'mt' }, btn('Give the role', { block: true, type: 'submit' })));
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!who.value.trim()) { err.textContent = 'Type their username.'; who.focus(); return; }
    try {
      const x = await spost('/staff/members', { handle: who.value.trim(), role, days: Number(days), email: email.value.trim() || undefined });
      toast(x && x.approval ? 'Asked a second Overseer' : 'Done'); reload();
    } catch (x) { err.textContent = x.message; }
  });
  return f;
}

function inviteForm(r, reload) {
  const roles = r.roles.filter((n) => n !== 'Overseer');
  let role = roles[0], days = '90';
  const email = h('input', { type: 'email', maxlength: '254', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { class: 'st-card', novalidate: true }, h('h2', null, 'Invite staff'), h('p', { class: 'mute' }, 'Someone new. They join Community with this address and get the role. Overseers are made after they join, with two people.'),
    field('Email address', email), h('div', { class: 'mt' }, h('span', { class: 'lbl' }, 'Role'), dropdown(roles.map((n) => [n, n]), role, (v) => { role = v; }, 'Role')),
    h('div', { class: 'mt' }, h('span', { class: 'lbl' }, 'For'), dropdown(DAYS, days, (v) => { days = v; }, 'For how long')), err,
    h('div', { class: 'mt' }, btn('Send invite', { block: true, type: 'submit', icon: 'send' })),
    h('p', { class: 'hint' }, icon('lock', 'sm'), 'The address is used to send the invite and kept only as a keyed hash.'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { err.textContent = 'Type a full email address.'; email.focus(); return; }
    try { await spost('/staff/invites', { email: email.value.trim(), role, days: Number(days) }); toast('Invite sent'); reload(); } catch (x) { err.textContent = x.message; }
  });
  return f;
}

/* ---------- Roles & scopes ---------- */

export function roles() {
  const box = h('div');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/roles');
    const cards = r.roles.map((role) => {
      if (role.locked) {
        return h('article', { class: 'st-card role locked' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, role.name), h('span', { class: 'tag k' }, icon('lock', 'sm'), 'Locked')),
          h('p', { class: 'mute' }, `Every scope, including the Overseer-only ones (${r.overseer_only.join(', ')}). It cannot be edited. ${role.holders} ${plural(role.holders, 'holder')}.`));
      }
      const picked = new Set(role.scopes);
      const bar = h('div', { class: 'savebar', hidden: true }, h('span', { class: 'grow' }, 'Unsaved changes'),
        btn('Discard', { sm: true, kind: 'w', on: () => load() }),
        btn('Save', { sm: true, on: async () => { try { await sput('/staff/roles/' + enc(role.name), { scopes: [...picked] }); toast('Saved ' + role.name); load(); } catch (e) { fail(e); } } }));
      const dirty = () => { bar.hidden = [...picked].sort().join() === [...role.scopes].sort().join(); };
      return h('article', { class: 'st-card role' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, role.name), h('span', { class: 'mute' }, `${role.holders} ${plural(role.holders, 'holder')}${role.invites ? `, ${role.invites} ${plural(role.invites, 'invite')}` : ''}`),
          !role.holders && !role.invites ? btn('Delete', { sm: true, kind: 'w', icon: 'trash', on: async () => {
            if ((await confirmBox({ title: `Delete the role ${role.name}?`, text: 'No one holds it. This is logged.', confirm: 'Delete', danger: true })) === null) return;
            try { await sdel('/staff/roles/' + enc(role.name)); toast('Deleted'); load(); } catch (e) { fail(e); }
          } }) : null),
        r.groups.map((g) => h('fieldset', { class: 'scopes' }, h('legend', null, g.group),
          g.scopes.map((s) => checkbox(picked.has(s.id), s.label, (v) => { if (v) picked.add(s.id); else picked.delete(s.id); dirty(); }, `${s.id} · ${s.what}`, s.risk)))),
        bar);
    });
    const name = h('input', { maxlength: '30', placeholder: 'e.g. Trust Team', autocomplete: 'off' });
    const err = h('p', { class: 'err', role: 'alert' });
    const add = h('form', { class: 'st-card', novalidate: true }, h('h2', null, 'New role'), h('p', { class: 'mute' }, 'Starts with no scopes; tick them after.'),
      field('Name', name), err, h('div', { class: 'mt' }, btn('Add role', { type: 'submit', icon: 'plus' })));
    add.addEventListener('submit', async (e) => { e.preventDefault(); err.textContent = ''; try { await spost('/staff/roles', { name: name.value.trim(), scopes: [] }); toast('Role added'); load(); } catch (x) { err.textContent = x.message; } });
    return [head('Roles & scopes', 'A role is a list of scopes. The server checks scopes, never role names.', r.as_of, load), cards, add];
  }, 'Reading roles'));
  load();
  return { title: 'Roles & scopes', node: box };
}

/* ---------- Audit log ---------- */

export function audit() {
  const f = { who: '', kind: '', q: '' };
  const list = h('div', { class: 'st-log', aria: { live: 'polite' } });
  const asof = h('p', { class: 'asof pad' });
  const more = h('div', { class: 'st-more' });
  const csv = h('a', { class: 'btn sm w', href: '/api/staff/audit.csv', download: '' }, icon('download', 'sm b'), 'Export CSV');
  let last = null, seq = 0;
  async function load(reset) {
    const n = ++seq;
    if (reset) { last = null; list.replaceChildren(loading('Reading the log')); more.replaceChildren(); }
    const params = { who: f.who, kind: f.kind, q: f.q };
    csv.href = '/api/staff/audit.csv' + (Object.values(params).some(Boolean) ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString() : '');
    try {
      const r = await sget('/staff/audit', { ...params, before: last || undefined });
      if (n !== seq) return;
      if (reset) list.replaceChildren();
      for (const e of r.entries) list.append(entry(e));
      if (reset && !r.entries.length) list.append(empty('Nothing matches', f.who || f.kind || f.q ? 'Try fewer filters.' : 'No staff actions yet.'));
      last = r.entries.length ? r.entries[r.entries.length - 1].at : last;
      asof.textContent = 'As of ' + fullTime(r.as_of);
      more.replaceChildren(r.entries.length >= 20 ? btn('Older entries', { kind: 'w', sm: true, on: () => load(false) }) : '');
    } catch (e) { if (n === seq) list.replaceChildren(empty('Could not read the log', e.message, btn('Try again', { kind: 'w', sm: true, on: () => load(true) }))); }
  }
  let timer = null;
  const typed = (key) => (e) => { f[key] = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(() => load(true), 300); };
  const who = h('input', { maxlength: '31', placeholder: 'username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', on: { input: typed('who') } });
  const q = h('input', { maxlength: '80', placeholder: 'words in the entry', autocomplete: 'off', on: { input: typed('q') } });
  load(true);
  return { title: 'Audit log', node: h('div', null,
    head('Audit log', 'Every staff action. Nobody can change or delete an entry, Overseers included.'),
    h('div', { class: 'st-filters' }, choiceChips([['', 'All'], ...Object.entries(KIND_LABEL)], '', (v) => { f.kind = v; load(true); }, 'Kind of entry'),
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, field('Who', who)), h('div', { class: 'grow' }, field('Search', q))), h('div', null, csv)),
    list, more, asof) };
}

/* ---------- Platform switches ---------- */

/** A switch that asks first: onWant(next) resolves true when the change was made or asked for. */
function askSwitch(on, label, onWant, disabled) {
  const b = h('button', { class: 'tg', type: 'button', role: 'switch', disabled: !!disabled, aria: { checked: String(!!on), label } });
  b.addEventListener('click', async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.disabled = true;
    try { if (await onWant(next)) b.setAttribute('aria-checked', String(next)); } catch (e) { fail(e); } finally { b.disabled = !!disabled; }
  });
  return b;
}

export function switches() {
  const box = h('div');
  const platform = has('switches.platform'), staging = has('switches.staging');
  const load = () => box.replaceChildren(later(async () => {
    const r = await sget('/staff/switches');
    const waiting = new Set(r.waiting);
    const swRow = (title, desc, ctl, extra) => h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, title), h('div', { class: 'mute' }, desc), extra), ctl);
    const plat = platform ? h('section', null, h('h2', { class: 'sect' }, 'Community'), h('div', { class: 'st-log' },
      swRow('Invite only', r.invite_only.note, askSwitch(true, 'Invite only', async () => false, true), h('span', { class: 'tag' }, icon('lock', 'sm'), 'Fixed for now')),
      r.switches.map((s) => {
        const meta = { launched: ['Launched', 'Marks Community as launched (the transparency report says so). Needs a second Overseer.'], read_only: ['Read-only mode', 'Members can read, sign in, report and use their data rights; nothing else is saved. For emergencies, so one Overseer is enough.'] }[s.key];
        const pending = waiting.has('switch:' + s.key);
        return swRow(meta[0], meta[1], askSwitch(s.is_on, meta[0], async (next) => {
          const note = await confirmBox({ title: `${next ? 'Switch on' : 'Switch off'}: ${meta[0]}?`, text: s.two_person ? 'A second Overseer must approve within 72 hours.' : 'This changes Community for everyone at once.', confirm: s.two_person ? 'Ask' : (next ? 'Switch on' : 'Switch off'), danger: next, reason: 'Why (kept with the switch)' });
          if (note === null) return false;
          const x = await spost('/staff/switches/' + s.key, { on: next, note });
          if (x && x.approval) { toast('Asked a second Overseer'); load(); return false; }
          toast(meta[0] + (next ? ' is on' : ' is off')); return true;
        }, pending), h('div', { class: 'row wrap' }, pending ? h('span', { class: 'tag y' }, 'Waiting for a second Overseer') : null,
          s.note ? h('span', { class: 'mute' }, `“${s.note}”${s.updated_by ? ' · @' + s.updated_by : ''} · ${timeAgo(s.updated_at)}`) : null));
      }))) : null;
    const feats = h('section', null, h('h2', { class: 'sect' }, `Feature switches · this server reads ${r.stage}`),
      r.features.length ? h('div', { class: 'st-log' }, r.features.map((f) => {
        const pending = waiting.has('feature:' + f.id);
        return h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, f.name), h('div', { class: 'mute mono-s' }, f.id), pending ? h('span', { class: 'tag y' }, 'Production: waiting for a second Overseer') : null),
          h('label', { class: 'sw-l' }, 'Staging', askSwitch(f.staging, f.name + ' in staging', async (next) => { await spost(`/staff/features/${enc(f.id)}/staging`, { on: next }); toast('Staging ' + (next ? 'on' : 'off')); return true; }, !staging)),
          h('label', { class: 'sw-l' }, 'Production', askSwitch(f.production, f.name + ' in production', async (next) => {
            if (next && (await confirmBox({ title: `Switch on "${f.name}" in production?`, text: 'A second Overseer must approve within 72 hours.', confirm: 'Ask' })) === null) return false;
            const x = await spost(`/staff/features/${enc(f.id)}/production`, { on: next });
            if (x && x.approval) { toast('Asked a second Overseer'); load(); return false; }
            toast('Production ' + (next ? 'on' : 'off')); return true;
          }, !platform || pending)),
          staging && !f.production ? btn('Remove', { sm: true, kind: 'w', icon: 'trash', on: async () => {
            if (!(await undoToast(`Removing "${f.id}"…`))) return;
            try { await sdel('/staff/features/' + enc(f.id)); toast('Removed'); load(); } catch (e) { fail(e); }
          } }) : null);
      })) : empty('No feature switches yet', 'Add one when code is ready to be switched on step by step.'));
    let add = null;
    if (staging) {
      const id = h('input', { maxlength: '41', placeholder: 'places.world', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
      const nm = h('input', { maxlength: '60', placeholder: 'Places: World', autocomplete: 'off' });
      const err = h('p', { class: 'err', role: 'alert' });
      add = h('form', { class: 'st-card', novalidate: true }, h('h2', null, 'Add a feature switch'), h('p', { class: 'mute' }, 'It starts off in staging and in production.'),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, field('Id (what the code checks)', id)), h('div', { class: 'grow' }, field('Name', nm))), err,
        h('div', { class: 'mt' }, btn('Add', { type: 'submit', icon: 'plus' })));
      add.addEventListener('submit', async (e) => { e.preventDefault(); err.textContent = ''; try { await spost('/staff/features', { id: id.value.trim(), name: nm.value.trim() }); toast('Added'); load(); } catch (x) { err.textContent = x.message; } });
    }
    return [head('Platform switches', 'Switches that change Community for everyone. The big ones need two Overseers.', r.as_of, load), plat, feats, add];
  }, 'Reading switches'));
  load();
  return { title: 'Platform switches', node: box };
}

/* ---------- Vault requests ---------- */

export function vault() {
  return { title: 'Vault requests', node: h('div', null, head('Vault requests', 'Court-order requests to open one sealed identity record (decision 0001).'),
    later(async () => {
      const r = await sget('/staff/vault');
      return [h('div', { class: 'st-card' }, h('div', { class: 'row top' }, h('div', { class: 'passkey-art sm' }, icon('lock', 'lg')),
        h('div', { class: 'grow' }, h('h2', null, r.built ? 'No requests' : 'The vault is not built yet'), h('p', { class: 'mute' }, r.note))),
        h('ol', { class: 'steps-row mt', aria: { label: 'How a request will work' } }, h('li', null, 'Court order'), h('li', null, 'Second Overseer'), h('li', null, 'Open 30 minutes'), h('li', null, 'Person told')),
        h('div', { class: 'mt' }, btn('New vault request', { disabled: !r.built, icon: 'plus', aria: { disabled: String(!r.built) } })),
        !r.built ? h('p', { class: 'hint' }, icon('info', 'sm'), 'This button works once the sealed vault exists.') : null),
        h('p', { class: 'asof pad' }, asOf(r.as_of))];
    }, 'Reading requests')) };
}

export const OVERSEER_NAV = [
  ['/overseer', 'Overview', 'home', 'staff.manage', overview],
  ['/overseer/approvals', 'Approvals', 'check', 'approvals.decide', approvals],
  ['/overseer/staff', 'Staff', 'users', 'staff.manage', staff],
  ['/overseer/roles', 'Roles & scopes', 'shield', 'roles.manage', roles],
  ['/overseer/audit', 'Audit log', 'clock', 'audit.read', audit],
  ['/overseer/switches', 'Platform switches', 'sliders', 'switches.platform', switches],
  ['/overseer/vault', 'Vault requests', 'lock', 'vault.request', vault],
];
