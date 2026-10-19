// Spaces (decision 0003): your Spaces, a Space page (Facebook Group page pattern) and its channels
// (Discord pattern). Private Spaces are end-to-end encrypted: see lib/e2e.js.
import { h, icon } from '../lib/dom.js';
import { del, get, post } from '../lib/api.js';
import { fullTime, timeAgo } from '../lib/format.js';
import { openForMember, publicJwk, sealForMembers } from '../lib/e2e.js';
import { ensureIdentity } from '../lib/keystore.js';
import { illustration } from '../lib/brand.js';
import { nav, state } from '../core.js';
import { appBar, avatar, backBtn, btn, buttonTabs, empty, errorBox, fail, iconBtn, later, loading, pagedList, personName, personRow, postView, sheet, toast } from '../ui.js';
import { spaceLine } from './home.js';
import { spaceJoinRow } from './join.js';

const enc = encodeURIComponent;
export const jwkOf = (k) => (!k ? null : typeof k === 'string' ? (() => { try { return JSON.parse(k); } catch { return null; } })() : k);

/* ---------- your Spaces ---------- */

export function spacesList() {
  const input = h('input', { type: 'search', placeholder: 'Find a Space', aria: { label: 'Find a Space' } });
  const form = h('form', { class: 'search', role: 'search' }, icon('search', 'sm'), input);
  form.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) nav('/explore?q=' + enc(input.value.trim())); });
  const node = h('div', null, appBar({ title: 'Spaces' }), form,
    state.me ? h('h2', { class: 'sect' }, 'Yours') : null,
    state.me ? later(async () => {
      const r = await get('/spaces', { mine: 1 });
      return (r.spaces || []).length ? r.spaces.map(spaceLine) : h('p', { class: 'pad mute' }, 'You haven\'t joined any Spaces yet.');
    }) : errorBox({ status: 401 }),
    state.me && state.me.home_area ? h('h2', { class: 'sect' }, 'Near you') : null,
    state.me && state.me.home_area ? later(async () => {
      const r = await get('/spaces', { near: state.me.home_area });
      return (r.spaces || []).length ? r.spaces.map(spaceJoinRow) : h('p', { class: 'pad mute' }, 'No Spaces near you yet.');
    }) : null);
  return { node, title: 'Spaces', tab: 'spaces' };
}

/* ---------- a Space ---------- */

export function spacePage({ params }) {
  const slug = params.slug;
  const node = later(async () => {
    const r = await get('/spaces/' + enc(slug));
    const s = r.space || {};
    document.title = s.name + ' · Community';
    const priv = s.visibility === 'private';
    const mod = r.my_role === 'owner' || r.my_role === 'moderator';
    const member = !!r.my_role;
    const joinBtn = btn(member ? 'Joined' : (priv ? 'Invite only' : 'Join'), { sm: true, kind: member ? 'w' : '', icon: member ? 'check' : null, disabled: !member && priv });
    joinBtn.addEventListener('click', async () => {
      try {
        if (member) { if (!confirm('Leave ' + s.name + '?')) return; await del('/spaces/' + enc(slug) + '/members'); toast('You left ' + s.name); }
        else { await post('/spaces/' + enc(slug) + '/members'); toast('Joined ' + s.name); }
        nav(location.pathname, { replace: true });
      } catch (e) { fail(e); }
    });
    const chans = r.channels || [];
    const body = h('div');
    const tabsDef = [['posts', 'Posts'], ['chat', 'Chat'], ['members', 'Members'], ['about', 'About']];
    const show = (k) => body.replaceChildren(TABS[k]());
    const TABS = {
      posts: () => h('div', null,
        s.rules ? h('button', { type: 'button', class: 'rules', on: { click: () => show('about') } }, icon('pin', 'sm'), h('span', { class: 'grow' }, 'Rules: ' + String(s.rules).split('\n')[0]), icon('chev', 'sm')) : null,
        member ? h('div', { class: 'pad mt mb' }, btn('Post in this Space', { sm: true, kind: 'w', icon: 'pen', href: '/compose?space=' + enc(s.id) + '&name=' + enc(s.name) })) : null,
        pagedList({
          fetchPage: async (before) => { const x = await get('/spaces/' + enc(slug) + '/posts', { before }); return { items: x.posts, end: x.end !== undefined ? x.end : true, as_of: x.as_of }; },
          render: (p) => postView(p), emptyNode: empty('No posts here yet', member ? 'Be the first to post.' : 'Join to post.'),
        })),
      chat: () => h('div', null,
        priv ? h('p', { class: 'lockline' }, icon('lock', 'sm'), 'Private Space · end-to-end encrypted · only members can read') : null,
        chans.length ? chans.map((c) => h('a', { class: 'chan', href: '/s/' + enc(slug) + '/c/' + enc(c.id) }, h('b', { aria: { hidden: 'true' } }, '#'), c.name)) : empty('No channels yet'),
        mod ? h('div', { class: 'pad mt' }, btn('New channel', { sm: true, kind: 'w', icon: 'plus', on: async () => {
          const name = (prompt('Channel name (letters, numbers and dashes)') || '').trim();
          if (!name) return;
          try { await post('/spaces/' + enc(slug) + '/channels', { name }); nav(location.pathname, { replace: true }); } catch (e) { fail(e); }
        } })) : null),
      members: () => later(async () => {
        const m = await get('/spaces/' + enc(slug) + '/members');
        return (m.members || []).length ? m.members.map((x) => personRow(x.person, x.role && x.role !== 'member' ? h('span', { class: 'tag' }, x.role) : null)) : empty('No members listed');
      }),
      about: () => h('div', { class: 'pad' },
        h('h2', { class: 'sect' }, 'About'), h('p', { class: 'pre' }, s.about || 'No description yet.'),
        h('h2', { class: 'sect' }, 'Rules'), h('p', { class: 'pre' }, s.rules || 'No rules written yet.'),
        h('p', { class: 'hint' }, icon(priv ? 'lock' : 'globe', 'sm'), priv ? 'Private: only members can see posts and read the chat. Chat is end-to-end encrypted.' : 'Public: anyone can read. Members can post and chat.'),
        mod ? h('div', { class: 'mt' }, btn('Reports in this Space', { sm: true, kind: 'w', icon: 'flag', href: '/mod?space=' + enc(slug) })) : null),
    };
    const faces = (r.faces || []).slice(0, 4);
    const head = h('div', null,
      h('div', { class: 'cover' }, s.cover_media_id ? h('img', { src: '/media/' + s.cover_media_id, alt: '' }) : illustration('grill', 'ill'), backBtn('/spaces')),
      h('div', { class: 'sp-hd' },
        h('h1', { tabindex: '-1' }, s.name),
        h('p', { class: 'mute row' }, icon(priv ? 'lock' : 'globe', 'sm'), (priv ? 'Private' : 'Public') + ' · ' + (r.members_count ?? s.members ?? 0) + ' members' + (s.area && s.area.name ? ' · ' + s.area.name : (typeof s.area === 'string' ? ' · ' + s.area : ''))),
        faces.length ? h('div', { class: 'row' }, h('div', { class: 'faces' }, faces.map((p) => avatar(p, 'xs'))),
          h('span', { class: 'mute' }, faces.map((p) => p.first_name).slice(0, 2).join(', '))) : null,
        h('div', { class: 'row mt mb' }, joinBtn,
          chans[0] && (member || !priv) ? btn('Chat', { sm: true, kind: 'w', icon: 'msg', href: '/s/' + enc(slug) + '/c/' + enc(chans[0].id) }) : null,
          iconBtn('link', 'Copy link to this Space', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href); } }))),
      buttonTabs(tabsDef, 'posts', show, 'Space sections'));
    show('posts');
    return [head, body];
  });
  return { node, title: 'Space', tab: 'spaces' };
}

/* ---------- a channel ---------- */

export function channel({ params }) {
  const { slug } = params;
  const chId = params.channel;
  let timer = null, alive = true;
  const list = h('div', { role: 'log', aria: { live: 'polite', label: 'Messages' } });
  const seen = new Set();
  const top = h('div');
  const composerSlot = h('div');
  const root = h('div', null, top, list, composerSlot);
  list.append(loading());

  (async () => {
    let r;
    try { r = await get('/spaces/' + enc(slug)); } catch (e) { list.replaceChildren(errorBox(e)); return; }
    const s = r.space || {};
    const priv = s.visibility === 'private';
    const chans = r.channels || [];
    const ch = chans.find((c) => String(c.id) === String(chId)) || { id: chId, name: 'chat' };
    document.title = '#' + ch.name + ' · ' + s.name;
    top.replaceChildren(appBar({ title: '# ' + ch.name, back: '/s/' + enc(slug), right: [h('a', { class: 'ib', href: '/s/' + enc(slug), aria: { label: s.name + ' page' } }, icon('users'))] }),
      chans.length > 1 ? h('nav', { class: 'chips', aria: { label: 'Channels' } }, chans.map((c) => h('a', { class: 'chip' + (String(c.id) === String(chId) ? ' on' : ''), href: '/s/' + enc(slug) + '/c/' + enc(c.id), aria: { current: String(c.id) === String(chId) ? 'page' : undefined } }, '# ' + c.name))) : null,
      h('p', { class: 'lockline' }, icon(priv ? 'lock' : 'globe', 'sm'), priv ? 'Private Space · end-to-end encrypted · only members can read' : 'Public Space · anyone can read'));

    let idn = null;
    if (priv) {
      if (!state.me) { list.replaceChildren(errorBox({ status: 401 })); return; }
      try { idn = await ensureIdentity(state.me); } catch (e) { list.replaceChildren(empty('Can\'t open encrypted chat', e.message)); return; }
    }
    const text = async (m) => {
      if (!priv || m.body) return { t: m.body || '' };
      try { return await openForMember(m.sealed, state.me.id, idn.privateKey, chId); } catch { return null; }
    };
    const row = async (m) => {
      const t = await text(m);
      const a = m.author || {};
      return h('div', { class: 'msgrow' }, avatar(a, 's'), h('div', null,
        h('div', { class: 'hd' }, personName(a), h('time', { class: 'meta', datetime: m.created_at, title: fullTime(m.created_at) }, timeAgo(m.created_at))),
        t ? h('p', null, t.t || '') : h('p', { class: 'locked' }, 'Can\'t read this message on this device (it was sent before this device\'s key existed).')));
    };
    const load = async (first) => {
      const x = await get('/channels/' + enc(chId) + '/messages', { limit: 50 });
      const fresh = (x.messages || []).filter((m) => !seen.has(m.id)).reverse();
      if (first) list.replaceChildren();
      if (first && !fresh.length) list.append(h('p', { class: 'empty', data: { empty: '1' } }, 'No messages here yet. Say hello.'));
      for (const m of fresh) { seen.add(m.id); list.querySelector('[data-empty]')?.remove(); list.append(await row(m)); }
      if (fresh.length) window.scrollTo(0, document.body.scrollHeight);
    };
    try { await load(true); } catch (e) { list.replaceChildren(errorBox(e)); return; }
    const tickPoll = async () => { if (!alive) return; if (document.visibilityState === 'visible') { try { await load(false); } catch { /* keep trying */ } } timer = setTimeout(tickPoll, 6000); };
    timer = setTimeout(tickPoll, 6000);

    if (!r.my_role) { composerSlot.replaceChildren(h('div', { class: 'stick' }, h('span', { class: 'grow mute' }, 'Join this Space to chat.'), btn('Back to the Space', { sm: true, kind: 'w', href: '/s/' + enc(slug) }))); return; }
    const ta = h('textarea', { rows: '1', maxlength: '4000', placeholder: 'Message #' + ch.name, aria: { label: 'Message #' + ch.name } });
    const send = h('button', { class: 'ib', type: 'submit', aria: { label: 'Send' } }, icon('send', 'b'));
    const f = h('form', { class: 'composer' }, ta, send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = ta.value.trim();
      if (!t) return;
      send.disabled = true;
      try {
        let body;
        if (priv) {
          const mem = await get('/spaces/' + enc(slug) + '/members');
          const recipients = [];
          let missing = 0;
          for (const x of mem.members || []) {
            const jwk = jwkOf(x.person && (x.person.dm_public_key || x.dm_public_key));
            if (x.person && x.person.id === state.me.id) continue;
            if (jwk) recipients.push({ id: x.person.id, jwk }); else missing++;
          }
          recipients.push({ id: state.me.id, jwk: publicJwk(idn.publicJwk) });
          body = { sealed: await sealForMembers({ t }, recipients, chId) };
          if (missing) toast(missing + ' member' + (missing === 1 ? ' has' : 's have') + ' no secure key yet and can\'t read this message');
        } else body = { body: t };
        const out = await post('/channels/' + enc(chId) + '/messages', body);
        ta.value = '';
        if (out && out.message && !seen.has(out.message.id)) {
          seen.add(out.message.id);
          list.querySelector('[data-empty]')?.remove();
          list.append(await row({ ...out.message, author: out.message.author || state.me, body: priv ? null : t, sealed: out.message.sealed || body.sealed }));
          window.scrollTo(0, document.body.scrollHeight);
        }
      } catch (err) { fail(err); } finally { send.disabled = false; ta.focus(); }
    });
    composerSlot.replaceChildren(f);
  })();

  return { node: root, title: 'Chat', tab: 'spaces', cls: 'chat-page nofab', cleanup: () => { alive = false; clearTimeout(timer); } };
}
