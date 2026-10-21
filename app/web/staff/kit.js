// The staff panel's own controls (decision 0009, point 15): never the browser's select, checkbox or
// confirm box. Each works from the keyboard and tells screen readers what it is.
import { h, icon } from '/static/lib/dom.js';
import { btn, field, sheet } from '/static/ui.js';

let uid = 0;
const nextId = (p) => p + (++uid);

/**
 * A dropdown: a button that opens a listbox. options: [[value, label, hint?]]. onPick(value).
 * Keys: Enter/Space/Down opens; arrows move; Home/End; a letter jumps; Enter picks; Esc closes.
 */
export function dropdown(options, value, onPick, label) {
  const id = nextId('dd');
  let cur = value, open = false, active = 0;
  const text = h('span', { class: 'dd-v' });
  const button = h('button', { class: 'dd', type: 'button', aria: { haspopup: 'listbox', expanded: 'false', controls: id + '-l', label: label + ': ' } }, text, icon('chev', 'sm dd-c'));
  const list = h('ul', { class: 'dd-l', role: 'listbox', id: id + '-l', tabindex: '-1', aria: { label }, hidden: true });
  const wrap = h('div', { class: 'dd-w' }, button, list);
  const items = options.map(([v, l, hint], i) => {
    const li = h('li', { role: 'option', id: id + '-' + i, data: { v } }, h('span', null, l), hint ? h('small', null, hint) : null, icon('check', 'sm dd-k'));
    li.addEventListener('click', () => pick(i));
    li.addEventListener('mousemove', () => move(i));
    return li;
  });
  list.append(...items);
  const paint = () => {
    const i = Math.max(0, options.findIndex(([v]) => v === cur));
    text.textContent = options[i] ? options[i][1] : '';
    button.setAttribute('aria-label', label + ': ' + text.textContent);
    items.forEach((li, j) => li.setAttribute('aria-selected', String(options[j][0] === cur)));
  };
  const move = (i) => { active = (i + items.length) % items.length; items.forEach((li, j) => li.classList.toggle('on', j === active)); list.setAttribute('aria-activedescendant', items[active].id); items[active].scrollIntoView({ block: 'nearest' }); };
  const show = () => { if (open) return; open = true; list.hidden = false; button.setAttribute('aria-expanded', 'true'); move(Math.max(0, options.findIndex(([v]) => v === cur))); list.focus(); document.addEventListener('pointerdown', outside, true); };
  const hide = (focus = true) => { if (!open) return; open = false; list.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); if (focus) button.focus(); };
  const outside = (e) => { if (!wrap.contains(e.target)) hide(false); };
  const pick = (i) => { const v = options[i][0]; hide(); if (v !== cur) { cur = v; paint(); onPick(v); } };
  button.addEventListener('click', () => (open ? hide() : show()));
  button.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); } });
  list.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown') move(active + 1); else if (k === 'ArrowUp') move(active - 1);
    else if (k === 'Home') move(0); else if (k === 'End') move(items.length - 1);
    else if (k === 'Enter' || k === ' ') pick(active);
    else if (k === 'Escape' || k === 'Tab') { hide(k === 'Escape'); if (k === 'Tab') return; }
    else if (k.length === 1) { const i = options.findIndex(([, l], j) => j > active && l.toLowerCase().startsWith(k.toLowerCase())); const f = i >= 0 ? i : options.findIndex(([, l]) => l.toLowerCase().startsWith(k.toLowerCase())); if (f >= 0) move(f); return; }
    else return;
    e.preventDefault();
  });
  paint();
  wrap.value = () => cur;
  return wrap;
}

/** A checkbox: a button with role=checkbox. desc is a second line; risk a small tag. */
export function checkbox(checked, label, onChange, desc, risk) {
  const b = h('button', { class: 'cb', type: 'button', role: 'checkbox', aria: { checked: String(!!checked) } },
    h('span', { class: 'cb-box' }, icon('check', 'sm b')),
    h('span', { class: 'cb-t' }, h('b', null, label), desc ? h('small', null, desc) : null),
    risk ? h('span', { class: 'tag risk-' + risk.toLowerCase() }, risk) : null);
  b.addEventListener('click', () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  return b;
}

/**
 * Ask before doing something. Resolves with the reason typed (or '' when none is asked), or null when
 * cancelled. opts: { title, text, confirm, danger, reason: 'label' | undefined, minReason }
 */
export function confirmBox(opts) {
  return new Promise((done) => {
    let answered = false;
    const s = sheet(opts.title, (close) => {
      const ta = opts.reason ? h('textarea', { class: 'area', maxlength: '500', rows: '3' }) : null;
      const err = h('p', { class: 'err', role: 'alert' });
      const f = h('form', { novalidate: true }, h('h2', null, opts.title), opts.text ? h('p', { class: 'mute' }, opts.text) : null,
        ta ? h('div', { class: 'mt' }, field(opts.reason, ta)) : null, err,
        h('div', { class: 'row mt' }, btn('Cancel', { kind: 'w', on: () => close() }), h('span', { class: 'grow' }),
          btn(opts.confirm || 'Confirm', { kind: opts.danger ? 'e' : '', type: 'submit' })));
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = ta ? ta.value.trim() : '';
        if (ta && v.length < (opts.minReason ?? 3)) { err.textContent = 'Say why in a few words.'; ta.focus(); return; }
        answered = true; close(); done(v);
      });
      return f;
    });
    s.el.addEventListener('close', () => { if (!answered) done(null); });
  });
}

/** A toast with Undo. Resolves true when the time runs out (go ahead), false when Undo was pressed. */
export function undoToast(message, ms = 5000) {
  return new Promise((done) => {
    const root = document.getElementById('toast');
    if (!root) { done(true); return; }
    const undo = h('button', { class: 'undo', type: 'button' }, 'Undo');
    const el = h('div', { class: 'with-undo' }, h('span', null, message), undo);
    root.append(el);
    const t = setTimeout(() => { el.remove(); done(true); }, ms);
    undo.addEventListener('click', () => { clearTimeout(t); el.remove(); done(false); });
    undo.focus({ preventScroll: true });
  });
}

/** A side drawer (a modal dialog from the right; from below on phones). build(close) returns its content. */
export function drawer(label, build) {
  const d = h('dialog', { class: 'drawer', aria: { label } });
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  document.body.append(d);
  d.append(h('div', { class: 'dr-top' }, h('b', null, label), h('button', { class: 'ib', type: 'button', aria: { label: 'Close' }, on: { click: close } }, icon('x', 'b'))),
    ...[build(close)].flat().filter(Boolean));
  d.showModal();
  return { el: d, close };
}

/** Time left in a window as a ring (SVG drawn here, no images). `part` is 0..1 of the window left. */
export function ring(part, label) {
  const SVG = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 36 36'); s.setAttribute('class', 'ring' + (part < 0.1 ? ' low' : '')); s.setAttribute('role', 'img'); s.setAttribute('aria-label', label);
  const c = (cls, dash) => { const e = document.createElementNS(SVG, 'circle'); e.setAttribute('cx', '18'); e.setAttribute('cy', '18'); e.setAttribute('r', '15.9'); e.setAttribute('class', cls); if (dash !== undefined) e.setAttribute('stroke-dasharray', `${dash} 100`); return e; };
  s.append(c('ring-bg'), c('ring-fg', Math.max(0, Math.min(100, part * 100)).toFixed(1)));
  return s;
}

/** "3 d", "5 h", "12:30" (minutes:seconds) or "ended". */
export function leftText(iso, now = Date.now()) {
  const s = Date.parse(iso) - now;
  if (s <= 0) return 'ended';
  if (s < 3600e3) return `${Math.floor(s / 60e3)}:${String(Math.floor((s % 60e3) / 1000)).padStart(2, '0')}`;
  if (s < 2 * 86400e3) return `${Math.ceil(s / 3600e3)} h`;
  return `${Math.ceil(s / 86400e3)} d`;
}

/** A tiny bar or line chart as SVG (no library). kind: 'bars' | 'line'. */
export function spark(values, kind, label) {
  const SVG = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(SVG, 'svg');
  const w = 120, hgt = 36, max = Math.max(1, ...values);
  s.setAttribute('viewBox', `0 0 ${w} ${hgt}`); s.setAttribute('class', 'spark'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', label);
  if (kind === 'bars') {
    const bw = w / values.length;
    values.forEach((v, i) => { const r = document.createElementNS(SVG, 'rect'); const bh = Math.max(2, (v / max) * (hgt - 2)); r.setAttribute('x', String(i * bw + 2)); r.setAttribute('y', String(hgt - bh)); r.setAttribute('width', String(bw - 4)); r.setAttribute('height', String(bh)); r.setAttribute('rx', '2'); s.append(r); });
  } else {
    const min = Math.min(...values), span = Math.max(1, max - min);
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 4) + 2},${hgt - 3 - ((v - min) / span) * (hgt - 6)}`).join(' ');
    const p = document.createElementNS(SVG, 'polyline'); p.setAttribute('points', pts); s.append(p);
  }
  return s;
}
