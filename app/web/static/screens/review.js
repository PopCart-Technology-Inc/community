// Live site review roulette. /review: anyone sends their website for the PopCart Community live, one
// entry per live, after agreeing to every consent point and typing their name as a signature. Staff run
// the round from the staff panel (app/web/staff/review.js).
import { h, icon } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { fullTime } from '../lib/format.js';
import { brandName } from '../lib/brand.js';
import { btn, errorBox, field, loading } from '../ui.js';

const CONTACT = 'support.popcart@gmail.com';
const HANDLE = '@go_popcart';

/**
 * The version of the consent text on this page (TERMS, dataTerms, CONSENTS). An entry sends this,
 * never the server's, so it records the text the person actually read. Raise it with the server's
 * CONSENT_VERSION (app/modules/review/routes.ts) whenever the text changes.
 */
export const CONSENT_VERSION = '2026-10-22.2';
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
