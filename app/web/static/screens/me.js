// Me: the profile (Instagram pattern with signed proof under the bio), settings (iOS grouped rows),
// adding proof (W3C Verifiable Credentials, decision 0001 point 2) and connected socials.
import { h, icon } from '../lib/dom.js';
import { del, get, patch, post } from '../lib/api.js';
import { asOf, count, TRADES, tradeLabel } from '../lib/format.js';
import { uploadPhoto } from '../lib/media.js';
import { illustration } from '../lib/brand.js';
import { nav, state } from '../core.js';
import { appBar, avatar, btn, buttonTabs, empty, errorBox, fail, field, followBtn, iconLink, later, pagedList, postView, tick, toast, toggle } from '../ui.js';
import { placeSearch } from './join.js';

const enc = encodeURIComponent;

export function meRedirect() {
  if (!state.me) { nav('/login?next=/me', { replace: true }); return { node: h('div'), title: 'Me' }; }
  nav('/u/' + enc(state.me.handle), { replace: true });
  return { node: h('div'), title: 'Me' };
}

const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function proofCard(c) {
  return h('div', { class: 'proof' },
    h('div', { class: 'top' }, icon('shield', 'sm'), c.issuer_name || c.type || 'Signed credential'),
    h('div', { class: 's' }, c.summary || ''),
    h('div', { class: 'by' }, icon('check', 'sm'), 'Signed' + (c.issuer_name ? ' by ' + c.issuer_name : '') + (c.as_of ? ' · as of ' + dateShort(c.as_of) : '')));
}

export function profile({ params }) {
  const node = later(async () => {
    const r = await get('/people/' + enc(params.handle));
    const p = r.person;
    const mine = state.me && state.me.id === p.id;
    document.title = (p.first_name || p.handle) + ' (@' + p.handle + ') · Community';
    const creds = (p.credentials || []).filter((c) => c.shown !== false);
    const body = h('div');
    const TABS = {
      posts: () => pagedList({
        fetchPage: async (before) => {
          const r = await get('/people/' + enc(p.handle) + '/posts', { before });
          return { items: r.posts, end: r.end === true || !(r.posts || []).length, as_of: r.as_of };
        },
        render: (x) => postView(x, { showPlace: true }),
        emptyNode: empty('No posts yet', mine ? 'Your posts show here.' : 'Nothing posted yet.'),
      }),
      work: () => later(async () => {
        const w = await get('/people/' + enc(p.handle) + '/work');
        const rt = w.ratings || {};
        const rows = [['On time', rt.on_time], ['Quality of work', rt.quality], ['Easy to work with', rt.easy], ['Would work with again', rt.again]];
        return h('div', { class: 'pad' },
          rt.count ? rows.map(([l, v]) => h('div', { class: 'rate' }, h('span', null, l), h('span', { class: 'bignum' }, v ? Number(v).toFixed(1) : '–'))) : h('p', { class: 'mute' }, 'No ratings yet.'),
          h('div', { class: 'counts' }, h('span', null, h('b', null, String(rt.count || 0)), ' ratings'), h('span', null, h('b', null, String(w.gigs_posted ?? 0)), ' gigs posted'), h('span', null, h('b', null, String(w.gigs_done ?? 0)), ' gigs done'),
            w.paid_on_time_share !== undefined && w.paid_on_time_share !== null ? h('span', null, h('b', null, Math.round(Number(w.paid_on_time_share) * 100) + '%'), ' paid on time') : null),
          h('p', { class: 'asof' }, asOf(w.as_of)));
      }),
      proof: () => h('div', { class: 'pad mt' }, creds.length ? creds.map(proofCard) : h('p', { class: 'mute' }, mine ? 'You haven\'t added proof yet.' : 'No proof shown.'),
        mine ? h('div', { class: 'mt' }, btn('Add proof', { sm: true, kind: 'w', icon: 'plus', href: '/me/proof' })) : null),
      about: () => h('div', { class: 'pad mt' }, h('p', { class: 'pre' }, p.bio || 'No bio yet.'),
        h('p', { class: 'mute' }, tradeLabel(p.trade) + (p.home_area_name ? ' · ' + p.home_area_name : ''))),
    };
    const show = (k) => body.replaceChildren(TABS[k]());
    show('posts');
    const msg = !mine && state.me ? btn('Message', { sm: true, kind: 'w', on: async () => { try { const c = await post('/conversations', { handle: p.handle }); nav('/inbox/' + enc(c.conversation.id)); } catch (e) { fail(e); } } }) : null;
    return [
      h('div', { class: 'pcover' }, p.cover_media_id ? h('img', { src: '/media/' + p.cover_media_id, alt: '' }) : illustration(p.trade === 'grill' ? 'grill' : p.trade === 'fresh' ? 'fish' : 'rider', 'ill'),
        mine ? iconLink('gear', 'Settings', '/me/settings') : null),
      h('div', { class: 'phd' },
        h('div', { class: 'top' }, avatar(p, 'l'), h('div', { class: 'row' },
          mine ? btn('Edit profile', { sm: true, kind: 'w', href: '/me/settings' }) : (state.me ? followBtn(p, p.is_following) : btn('Log in to follow', { sm: true, kind: 'w', href: '/login' })), msg)),
        h('h1', { tabindex: '-1' }, p.first_name || p.handle, p.id_checked ? tick() : null),
        h('div', { class: 'mute' }, '@' + p.handle + ' · ' + tradeLabel(p.trade) + (p.home_area_name ? ' · ' + p.home_area_name : '')),
        p.bio ? h('p', { class: 'pre' }, p.bio) : null,
        h('div', { class: 'counts' },
          h('span', null, h('b', null, count(p.followers)), ' followers'), h('span', null, h('b', null, count(p.following)), ' following'),
          h('span', null, h('b', null, count(p.salamats)), ' salamats'), p.as_of ? h('span', null, asOf(p.as_of)) : null),
        creds[0] ? h('a', { class: 'proof mb', href: '#', on: { click: (e) => { e.preventDefault(); show('proof'); } } },
          h('div', { class: 'top' }, icon('shield', 'sm'), 'Signed proof'), h('div', { class: 's' }, creds[0].summary || ''), h('div', { class: 'by' }, creds[0].as_of ? 'as of ' + dateShort(creds[0].as_of) : '')) : null),
      buttonTabs([['posts', 'Posts'], ['work', 'Work'], ['proof', 'Proof'], ['about', 'About']], 'posts', show, 'Profile sections'),
      body,
      mine ? h('div', null, h('h2', { class: 'sect' }, 'Elsewhere'), h('a', { class: 'li', href: '/me/socials' }, icon('link'), h('div', { class: 'grow' }, h('div', { class: 't1' }, 'Your other accounts')), icon('chev', 'sm'))) : null,
    ];
  });
  const mineTab = state.me && state.me.handle === params.handle;
  return { node, title: 'Profile', tab: mineTab ? 'me' : 'home' };
}

/* ---------- settings ---------- */

const row = (ic, title, sub, href, side) => h(href ? 'a' : 'div', { class: 'li', href }, icon(ic), h('div', { class: 'grow' }, h('div', { class: 't1' }, title), sub ? h('div', { class: 't2' }, sub) : null), side || (href ? icon('chev', 'sm') : null));

export function settings() {
  const me = state.me;
  if (!me) return { node: h('div', null, appBar({ title: 'Settings', back: '/' }), errorBox({ status: 401 })), title: 'Settings' };
  const first = h('input', { value: me.first_name || '', maxlength: '40' });
  const bio = h('textarea', { class: 'area', maxlength: '300' }); bio.value = me.bio || '';
  const trade = h('select', null, TRADES.map(([k, l]) => h('option', { value: k, selected: k === me.trade }, l)));
  let home = me.home_area;
  const err = h('p', { class: 'err', role: 'alert' });
  const av = h('span', null, avatar(me, 'l'));
  const upload = (col, label) => {
    const inp = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr', id: 'up-' + col });
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; inp.value = '';
      if (!f) return;
      try { toast('Removing location data and uploading…'); const m = await uploadPhoto(f); const r = await patch('/me', { [col]: m.id }); Object.assign(state.me, r.user); toast(label + ' updated'); if (col === 'avatar_media_id') av.replaceChildren(avatar(state.me, 'l')); }
      catch (e) { fail(e); }
    });
    return [h('label', { class: 'btn sm w', for: 'up-' + col }, icon('image', 'sm'), label), inp];
  };
  const homeName = h('span', null, me.home_area ? '…' : 'Not set');
  if (me.home_area) get('/places/' + enc(me.home_area)).then((r) => { homeName.textContent = r.area ? r.area.name : me.home_area; }).catch(() => { homeName.textContent = me.home_area; });
  const form = h('form', { class: 'group pad' },
    h('div', { class: 'row mt' }, av, h('div', { class: 'row wrap' }, upload('avatar_media_id', 'Photo'), upload('cover_media_id', 'Cover'))),
    field('First name', first), h('div', null, h('label', { class: 'lbl', for: 'bio' }, 'Bio'), Object.assign(bio, { id: 'bio' })),
    field('What do you do?', trade),
    h('p', { class: 'hint' }, 'Home area: ', homeName),
    placeSearch('', (a) => { home = a ? a.code : me.home_area; }, 'Change home area'),
    err, h('div', { class: 'mt mb' }, btn('Save profile', { block: true, type: 'submit' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await patch('/me', { first_name: first.value.trim(), bio: bio.value.trim(), trade: trade.value, home_area: home || null });
      Object.assign(state.me, r.user);
      window.dispatchEvent(new Event('cm:auth'));
      toast('Saved');
    } catch (x) { err.textContent = x.message; }
  });
  const choice = (key, title, desc) => h('div', { class: 'li' }, h('div', { class: 'grow' }, h('div', { class: 't1' }, title), h('div', { class: 't2' }, desc)),
    toggle(!!me[key], title, async (v) => { const r = await patch('/me', { [key]: v }); Object.assign(state.me, r.user); toast(v ? 'Switched on' : 'Switched off. Raw data deleted.'); }));
  const node = h('div', { class: 'cream-page' }, appBar({ title: 'Settings', back: '/u/' + enc(me.handle) }),
    h('h2', { class: 'sect' }, 'Profile'), form,
    h('h2', { class: 'sect' }, 'Help improve Community'),
    h('div', { class: 'group' }, choice('improve_usage', 'Usage and errors', 'Off unless you switch it on. Raw data kept 90 days at most.'), choice('improve_surveys', 'Surveys and tests', 'We may ask you to try new things.')),
    h('h2', { class: 'sect' }, 'Your records'),
    h('div', { class: 'group' }, row('lock', 'Your data', 'What we hold, download, delete', '/me/data'), row('eye', 'Who opened my records', '', '/me/records'),
      row('shield', 'What moderators did', 'Removals and warnings, with appeals', '/me/actions'), row('star', 'Proof', 'Signed credentials you show', '/me/proof'), row('link', 'Your other accounts', '', '/me/socials')),
    h('h2', { class: 'sect' }, 'Community'),
    h('div', { class: 'group' }, row('scale', 'Transparency report', '', '/transparency'), me.role === 'staff' ? row('flag', 'Moderator queue', 'Staff', '/mod') : null),
    h('div', { class: 'pad mb' }, btn('Log out', { block: true, kind: 'w', icon: 'logout', on: async () => { try { await post('/accounts/logout'); } catch { /* signed out anyway */ } state.me = null; window.dispatchEvent(new Event('cm:auth')); nav('/', { replace: true }); } })));
  return { node, title: 'Settings', tab: 'me' };
}

/* ---------- proof ---------- */

export function proof() {
  if (!state.me) return { node: h('div', null, appBar({ title: 'Proof', back: '/' }), errorBox({ status: 401 })), title: 'Proof' };
  const list = h('div');
  const load = () => {
    list.replaceChildren(later(async () => {
      const r = await get('/me/credentials');
      const cs = r.credentials || [];
      if (!cs.length) return empty('No proof yet', 'Add a credential signed by a trusted issuer, and choose whether your profile shows it.');
      return cs.map((c) => h('div', { class: 'mb' }, proofCard(c), h('div', { class: 'toggle' }, h('div', { class: 'grow' }, h('p', null, 'Show on my profile')),
        toggle(c.shown !== false, 'Show on my profile', async (v) => { await patch('/me/credentials/' + enc(c.id), { shown: v }); }),
        btn('Remove', { sm: true, kind: 'w', icon: 'trash', on: async () => { if (!confirm('Remove this credential?')) return; try { await del('/me/credentials/' + enc(c.id)); load(); } catch (e) { fail(e); } } }))));
    }));
  };
  load();
  const ta = h('textarea', { class: 'area', placeholder: '{ "@context": [...], "type": [...], "proof": ... }', spellcheck: 'false' });
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr', id: 'vc-file' });
  file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (f) ta.value = await f.text(); });
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'pad' }, h('h2', { class: 'sect' }, 'Add a credential'),
    h('p', { class: 'mute' }, 'Ask a trusted issuer to sign your record from live data. You keep the file; only its signed numbers come in, with their "as of" date.'),
    h('div', { class: 'row mb' }, h('label', { class: 'btn sm w', for: 'vc-file' }, icon('download', 'sm'), 'Choose file'), file),
    field('Or paste it', ta), err, h('div', { class: 'mt' }, btn('Check and add', { block: true, type: 'submit' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    let vc;
    try { vc = JSON.parse(ta.value); } catch { err.textContent = 'That is not a credential file (not valid JSON).'; return; }
    try { await post('/me/credentials', { vc }); ta.value = ''; toast('Checked and added'); load(); } catch (x) { err.textContent = x.message; }
  });
  return { node: h('div', null, appBar({ title: 'Proof', back: '/me/settings' }), h('div', { class: 'pad mt' }, list), form), title: 'Proof', tab: 'me' };
}

/* ---------- socials ---------- */

export function socials() {
  return {
    node: h('div', null, appBar({ title: 'Your other accounts', back: '/me/settings' }),
      empty('Not available yet', 'Connecting Instagram, TikTok, Facebook and Threads (decision 0004) is not built on this server yet.'),
      h('p', { class: 'hint pad' }, icon('lock', 'sm'), 'When it comes, we will never ask for your other passwords.')),
    title: 'Your other accounts', tab: 'me',
  };
}
