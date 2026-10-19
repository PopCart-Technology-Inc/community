// Inbox and direct messages, end-to-end encrypted in the browser (decision 0001, point 4).
// The server only ever sees { sealed: { v: 1, iv, ct } }; see lib/e2e.js and docs/e2e-client.md.
import { h, icon } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { fullTime, timeAgo } from '../lib/format.js';
import { deriveDmKey, open, seal } from '../lib/e2e.js';
import { ensureIdentity } from '../lib/keystore.js';
import { nav, state } from '../core.js';
import { appBar, avatar, backBtn, btn, buttonTabs, empty, errorBox, fail, field, iconBtn, loading, personName, sheet, toast } from '../ui.js';
import { jwkOf } from './spaces.js';

const enc = encodeURIComponent;

export function inbox() {
  if (!state.me) return { node: h('div', null, appBar({ title: 'Inbox' }), errorBox({ status: 401 })), title: 'Inbox', tab: 'inbox' };
  const body = h('div');
  const load = (requests) => {
    body.replaceChildren(loading());
    get('/conversations', requests ? { requests: 1 } : {}).then((r) => {
      const cs = r.conversations || [];
      body.replaceChildren(cs.length ? h('div', null, cs.map((c) => h('a', { class: 'li', href: '/inbox/' + enc(c.id) },
        avatar(c.other),
        h('div', { class: 'grow' }, h('div', { class: 't1' }, (c.other && (c.other.first_name || c.other.handle)) || 'Someone'),
          h('div', { class: 't2' + (c.unread ? ' unread' : '') }, c.accepted === false ? 'Message request' : 'Encrypted conversation')),
        h('div', { class: 'side' }, c.last_at ? timeAgo(c.last_at) : '', c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null)))) :
        empty(requests ? 'No requests' : 'No messages yet', requests ? 'Messages from people you don\'t follow wait here.' : 'Start a conversation with someone you know.'));
    }, (e) => body.replaceChildren(errorBox(e)));
  };
  const newMsg = () => sheet('New message', (close) => {
    const input = h('input', { autocapitalize: 'none', spellcheck: 'false', placeholder: 'username', required: true });
    const err = h('p', { class: 'err', role: 'alert' });
    const f = h('form', null, h('h2', null, 'New message'), field('To (username)', input), err, h('div', { class: 'mt' }, btn('Start', { block: true, type: 'submit' })));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await post('/conversations', { handle: input.value.trim().replace(/^@/, '').toLowerCase() }); close(); nav('/inbox/' + enc(r.conversation.id)); }
      catch (x) { err.textContent = x.message; }
    });
    return f;
  });
  load(false);
  return {
    node: h('div', null, appBar({ title: 'Inbox', right: [iconBtn('pen', 'New message', newMsg)] }),
      buttonTabs([['m', 'Messages'], ['r', 'Requests']], 'm', (k) => load(k === 'r'), 'Inbox'),
      body, h('p', { class: 'lockline' }, icon('lock', 'sm'), 'Messages are end-to-end encrypted')),
    title: 'Inbox', tab: 'inbox',
  };
}

export function dm({ params }) {
  const id = params.id;
  let alive = true, timer = null;
  const top = h('div', null, appBar({ title: 'Messages', back: '/inbox' }));
  const list = h('div', { role: 'log', aria: { live: 'polite', label: 'Messages' } }, loading());
  const banner = h('div');
  const composer = h('div');
  const root = h('div', null, top, h('p', { class: 'lockline' }, icon('lock', 'sm'), 'End-to-end encrypted. Not even the people who run Community can read this.'), banner, list, composer);
  const seen = new Set();
  const shown = []; // decrypted messages kept in memory only, for reporting

  if (!state.me) { list.replaceChildren(errorBox({ status: 401 })); return { node: root, title: 'Messages', tab: 'inbox' }; }

  (async () => {
    let idn, conv;
    try {
      idn = await ensureIdentity(state.me);
      const [a, b] = await Promise.all([get('/conversations'), get('/conversations', { requests: 1 }).catch(() => ({ conversations: [] }))]);
      conv = [...(a.conversations || []), ...(b.conversations || [])].find((c) => String(c.id) === String(id));
    } catch (e) { list.replaceChildren(errorBox(e)); return; }
    if (!conv) { list.replaceChildren(empty('Conversation not found')); return; }
    const other = conv.other || {};
    document.title = (other.first_name || other.handle) + ' · Messages';
    top.replaceChildren(h('header', { class: 'abar' }, backBtn('/inbox'), avatar(other, 's'), h('h1', { class: 't', tabindex: '-1' }, personName(other)),
      iconBtn('flag', 'Report this conversation', () => reportSheet(id, other, shown))));
    if (idn.fresh) banner.append(h('div', { class: 'note' }, icon('info'), h('div', null, h('b', null, 'New secure key on this device'), h('p', null, 'Messages sent before today can only be read on the device that had your old key.'))));
    const theirKey = jwkOf(other.dm_public_key);
    let key = null;
    if (theirKey) {
      try { key = await deriveDmKey(idn.privateKey, theirKey, String(id)); } catch { key = null; }
    }
    const bubble = async (m) => {
      const mine = m.sender_id === state.me.id;
      let t = null;
      if (key) { try { t = (await open(key, m.sealed)).t; } catch { t = null; } }
      if (t !== null && !mine) shown.push({ id: m.id, text: t, created_at: m.created_at });
      return h('div', { class: ['bub', mine && 'me', t === null && 'locked'] }, t === null ? 'Can\'t read this message on this device.' : t,
        h('time', { datetime: m.created_at, title: fullTime(m.created_at) }, timeAgo(m.created_at)));
    };
    let msgs = [];
    const load = async (first) => {
      const r = await get('/conversations/' + enc(id) + '/messages', { limit: 50 });
      msgs = r.messages || [];
      const fresh = msgs.filter((m) => !seen.has(m.id)).reverse();
      if (first) list.replaceChildren();
      if (first && !fresh.length) list.append(h('p', { class: 'empty', data: { empty: '1' } }, 'No messages yet.'));
      for (const m of fresh) { seen.add(m.id); list.querySelector('[data-empty]')?.remove(); list.append(await bubble(m)); }
      if (fresh.length) window.scrollTo(0, document.body.scrollHeight);
    };
    try { await load(true); } catch (e) { list.replaceChildren(errorBox(e)); return; }
    const poll = async () => { if (!alive) return; if (document.visibilityState === 'visible') { try { await load(false); } catch { /* retry */ } } timer = setTimeout(poll, 5000); };
    timer = setTimeout(poll, 5000);

    if (conv.accepted === false) {
      const fromThem = msgs.some((m) => m.sender_id !== state.me.id), fromMe = msgs.some((m) => m.sender_id === state.me.id);
      if (fromThem && !fromMe) {
        banner.append(h('div', { class: 'note' }, icon('msg'), h('div', null, h('b', null, (other.first_name || 'This person') + ' wants to message you'),
          h('p', null, 'They can\'t see if you\'ve read this until you accept.'),
          h('div', { class: 'row mt' }, btn('Accept', { sm: true, on: async (e) => { const note = e.currentTarget.closest('.note'); try { await post('/conversations/' + enc(id) + '/accept'); note.remove(); toast('Accepted'); } catch (x) { fail(x); } } }),
            btn('Report', { sm: true, kind: 'w', on: () => reportSheet(id, other, shown) })))));
      } else {
        banner.append(h('p', { class: 'lockline' }, 'Waiting for ' + (other.first_name || 'them') + ' to accept your message request.'));
      }
    }
    if (!key) {
      composer.replaceChildren(h('div', { class: 'stick' }, icon('info'), h('span', { class: 'grow mute' }, (other.first_name || 'This person') + ' hasn\'t set up secure messages yet. You can message them after they open Community on their phone or computer.')));
      return;
    }
    const ta = h('textarea', { rows: '1', maxlength: '4000', placeholder: 'Message…', aria: { label: 'Message ' + (other.first_name || '') } });
    const send = h('button', { class: 'ib', type: 'submit', aria: { label: 'Send' } }, icon('send', 'b'));
    const f = h('form', { class: 'composer' }, ta, send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = ta.value.trim();
      if (!t) return;
      send.disabled = true;
      try {
        const sealed = await seal(key, { t });
        const r = await post('/conversations/' + enc(id) + '/messages', { sealed });
        ta.value = '';
        const m = (r && r.message) || { id: 'local-' + Date.now(), sender_id: state.me.id, sealed, created_at: new Date().toISOString() };
        if (!seen.has(m.id)) { seen.add(m.id); list.querySelector('[data-empty]')?.remove(); list.append(await bubble({ ...m, sealed: m.sealed || sealed, sender_id: m.sender_id || state.me.id })); window.scrollTo(0, document.body.scrollHeight); }
      } catch (err) { fail(err); } finally { send.disabled = false; ta.focus(); }
    });
    composer.replaceChildren(f);
  })();

  return { node: root, title: 'Messages', tab: 'inbox', cls: 'chat-page nofab', cleanup: () => { alive = false; clearTimeout(timer); } };
}

/** Report a conversation: the reporter's own device decrypts, and they choose which messages to reveal. */
function reportSheet(id, other, shown) {
  sheet('Report this conversation', (close) => {
    const reasons = [['scam', 'Scam or fake gig'], ['harassment', 'Harassment or hate'], ['private_info', 'Someone\'s private info'], ['violence', 'Violence or threats'], ['child_safety', 'Child safety'], ['other', 'Something else']];
    let reason = 'scam';
    const picks = new Set();
    const f = h('form', null, h('h2', null, 'Report ' + (other.first_name || 'this conversation')),
      h('p', { class: 'mute' }, 'Moderators can\'t read your messages. Tick the ones you want them to see; only those are sent.'),
      h('fieldset', { class: 'menu' }, h('legend', { class: 'sr' }, 'Reason'), reasons.map(([k, lab], i) => {
        const r = h('input', { type: 'radio', name: 'reason', value: k, checked: i === 0 });
        r.addEventListener('change', () => { reason = k; });
        return h('label', { class: 'li' }, h('span', { class: 'grow' }, lab), r);
      })),
      shown.length ? h('fieldset', { class: 'menu' }, h('legend', { class: 'sect' }, 'Messages to show the moderators'), shown.slice(-20).map((m) => {
        const c = h('input', { type: 'checkbox' });
        c.addEventListener('change', () => { if (c.checked) picks.add(m); else picks.delete(m); });
        return h('label', { class: 'li top' }, c, h('span', { class: 'grow pre' }, m.text));
      })) : h('p', { class: 'hint' }, 'No readable messages from them on this device.'),
      h('div', { class: 'mt' }, btn('Send report', { block: true, type: 'submit' })));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/reports', { target_kind: 'conversation', target_id: String(id), reason, revealed: [...picks].map((m) => ({ id: m.id, text: m.text, created_at: m.created_at })) });
        close(); toast(reason === 'child_safety' ? 'Sent to trained staff. Thank you.' : 'Report sent. Thank you.');
      } catch (x) { fail(x); }
    });
    return f;
  });
}
