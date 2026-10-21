// Branded form controls, so no screen falls back to the browser's own: a dropdown (listbox), a date
// picker (calendar), a file drop that hashes files on this device, and a peso amount field.
// Each keeps the keyboard and screen-reader behaviour of the control it replaces.
import { h, icon } from './lib/dom.js';
import { peso, toCentavos } from './lib/ledger.js';

let uid = 0;
const nextId = (p) => p + '-' + (++uid);

/** Close an open popover when a press lands outside it. Returns the remover. */
function outside(root, close) {
  const fn = (e) => { if (!root.contains(e.target)) close(); };
  document.addEventListener('pointerdown', fn, true);
  return () => document.removeEventListener('pointerdown', fn, true);
}

/** Open a popover below its button, or above when there is no room below (inside a sheet too). */
function place(wrap, pop) {
  wrap.classList.remove('up');
  const b = wrap.getBoundingClientRect();
  const sc = wrap.closest('dialog, .sheet');
  const bottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;
  const top = sc ? sc.getBoundingClientRect().top : 0;
  const need = Math.min(pop.scrollHeight || 280, 300);
  if (bottom - b.bottom < need + 8 && b.top - top > bottom - b.bottom) wrap.classList.add('up');
}

/** A label above a custom control; the control's button is named by it. */
export function control(label, ctl, hint) {
  const id = nextId('lbl');
  const btn = ctl.querySelector('.dd-btn') || ctl.querySelector('.drop') || ctl.querySelector('input');
  if (btn) btn.setAttribute('aria-labelledby', [id, btn.id].filter(Boolean).join(' '));
  return h('div', { class: 'ctl' }, h('span', { class: 'lbl', id }, label), ctl, hint ? h('p', { class: 'hint' }, hint) : null);
}

/**
 * A dropdown. options: [[value, label, detail?]]. The popup is a listbox: arrows, Home/End, typing a
 * letter, Enter to pick, Esc to close. Returns the element; read `.value`, listen for 'change'.
 */
export function dropdown(options, { value = null, placeholder = 'Choose', onChange } = {}) {
  const wrap = h('div', { class: 'dd' });
  const vid = nextId('ddv');
  const val = h('span', { class: 'v', id: vid });
  const btn = h('button', { type: 'button', class: 'dd-btn', id: vid + 'b', aria: { haspopup: 'listbox', expanded: 'false' } }, val, icon('chev', 'sm dd-chev'));
  const list = h('ul', { class: 'dd-list', role: 'listbox', tabindex: '-1', hidden: true });
  let current = value, active = 0, stop = null, typed = '', typedAt = 0;
  const items = options.map(([v, label, detail], i) => h('li', { role: 'option', id: vid + '-' + i, data: { v, i }, aria: { selected: 'false' } },
    h('span', { class: 'o' }, h('b', null, label), detail ? h('small', null, detail) : null), icon('check', 'sm tick-ic')));
  list.append(...items);
  const show = () => {
    const o = options.find((x) => x[0] === current);
    val.textContent = o ? o[1] : placeholder;
    val.classList.toggle('ph', !o);
    items.forEach((li) => li.setAttribute('aria-selected', String(li.dataset.v === String(current))));
  };
  const mark = (i) => {
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((li, j) => li.classList.toggle('act', j === active));
    list.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  };
  const close = (focus = true) => {
    if (list.hidden) return;
    list.hidden = true; btn.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open');
    if (stop) { stop(); stop = null; }
    if (focus) btn.focus();
  };
  const open = () => {
    list.hidden = false; btn.setAttribute('aria-expanded', 'true'); wrap.classList.add('open');
    place(wrap, list);
    mark(Math.max(0, options.findIndex((x) => x[0] === current)));
    list.focus({ preventScroll: true });
    stop = outside(wrap, () => close(false));
  };
  const pick = (i) => {
    const v = options[i][0];
    const changed = v !== current;
    current = v; show(); close();
    if (changed) { if (onChange) onChange(v); wrap.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) pick(Number(li.dataset.i)); });
  list.addEventListener('pointermove', (e) => { const li = e.target.closest('li'); if (li) mark(Number(li.dataset.i)); });
  list.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown') mark(active + 1);
    else if (k === 'ArrowUp') mark(active - 1);
    else if (k === 'Home') mark(0);
    else if (k === 'End') mark(items.length - 1);
    else if (k === 'Enter' || k === ' ') pick(active);
    else if (k === 'Escape') { e.stopPropagation(); close(); }
    else if (k === 'Tab') { close(false); return; }
    else if (k.length === 1 && /\S/.test(k)) {
      typed = (Date.now() - typedAt < 700 ? typed : '') + k.toLowerCase(); typedAt = Date.now();
      const i = options.findIndex((o) => o[1].toLowerCase().startsWith(typed));
      if (i >= 0) mark(i);
    } else return;
    e.preventDefault();
  });
  // a dialog's own Esc would close the whole sheet: keep it for the list while the list is open
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } });
  Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v; show(); } });
  wrap.append(btn, list);
  show();
  return wrap;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(s + 'T00:00:00Z');
export const niceDate = (s) => { const d = utc(s); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear(); };

/**
 * A date picker: a button that opens a calendar. Arrows move a day or a week, PageUp/PageDown a month,
 * Home/End the week, Enter picks, Esc closes. Dates are 'YYYY-MM-DD'; min and max are kept.
 */
export function datePicker({ value, min = '2000-01-01', max = '2100-12-31', onChange } = {}) {
  const wrap = h('div', { class: 'dd dp' });
  const vid = nextId('dpv');
  const val = h('span', { class: 'v', id: vid });
  const btn = h('button', { type: 'button', class: 'dd-btn', id: vid + 'b', aria: { haspopup: 'dialog', expanded: 'false' } }, icon('cal', 'sm'), val, icon('chev', 'sm dd-chev'));
  const title = h('b', { class: 'dp-t', aria: { live: 'polite' } });
  const grid = h('div', { class: 'dp-grid', role: 'grid' });
  const prev = h('button', { type: 'button', class: 'ib', aria: { label: 'Previous month' } }, icon('back', 'b'));
  const next = h('button', { type: 'button', class: 'ib', aria: { label: 'Next month' } }, icon('chev', 'b'));
  const pop = h('div', { class: 'dd-list dp-pop', role: 'dialog', aria: { label: 'Choose a date' }, hidden: true },
    h('div', { class: 'dp-head' }, prev, title, next),
    h('div', { class: 'dp-wk', aria: { hidden: 'true' } }, ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => h('span', null, d))), grid);
  let current = value, focus = value || max, stop = null;
  const show = () => { val.textContent = current ? niceDate(current) : 'Choose a date'; val.classList.toggle('ph', !current); };
  const clamp = (s) => (s < min ? min : s > max ? max : s);
  function draw() {
    const f = utc(focus);
    title.textContent = MONTHS[f.getUTCMonth()] + ' ' + f.getUTCFullYear();
    const first = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1));
    const start = new Date(first); start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
      const s = ymd(d);
      const out = d.getUTCMonth() !== f.getUTCMonth();
      const off = s < min || s > max;
      cells.push(h('button', { type: 'button', role: 'gridcell', class: ['dp-d', out && 'out', s === current && 'sel', s === ymd(new Date(Date.now() + 8 * 3600_000)) && 'today'],
        data: { d: s }, disabled: off, tabindex: s === focus ? '0' : '-1', aria: { selected: String(s === current), label: niceDate(s) } }, String(d.getUTCDate())));
    }
    grid.replaceChildren(...cells);
    prev.disabled = ymd(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0))) < min;
    next.disabled = ymd(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1))) > max;
  }
  const move = (s) => { focus = clamp(s); draw(); const b = grid.querySelector(`[data-d="${focus}"]`); if (b) b.focus(); };
  const shift = (days) => { const d = utc(focus); d.setUTCDate(d.getUTCDate() + days); move(ymd(d)); };
  const month = (n) => { const d = utc(focus); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); t.setUTCDate(Math.min(d.getUTCDate(), new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate())); move(ymd(t)); };
  const close = (back = true) => {
    if (pop.hidden) return;
    pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open');
    if (stop) { stop(); stop = null; }
    if (back) btn.focus();
  };
  const open = () => {
    focus = clamp(current || max);
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); wrap.classList.add('open');
    draw(); place(wrap, pop); move(focus);
    stop = outside(wrap, () => close(false));
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  prev.addEventListener('click', () => month(-1));
  next.addEventListener('click', () => month(1));
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.dp-d');
    if (!b || b.disabled) return;
    const changed = b.dataset.d !== current;
    current = b.dataset.d; show(); close();
    if (changed) { if (onChange) onChange(current); wrap.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  grid.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') shift(-1); else if (k === 'ArrowRight') shift(1);
    else if (k === 'ArrowUp') shift(-7); else if (k === 'ArrowDown') shift(7);
    else if (k === 'PageUp') month(-1); else if (k === 'PageDown') month(1);
    else if (k === 'Home') shift(-((utc(focus).getUTCDay() + 6) % 7));
    else if (k === 'End') shift(6 - ((utc(focus).getUTCDay() + 6) % 7));
    else return;
    e.preventDefault();
  });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); e.stopPropagation(); close(); } });
  Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v; show(); } });
  wrap.append(btn, pop);
  show();
  return wrap;
}

/**
 * A drop zone for files. The file never leaves this device: `hash(file)` runs here and only the
 * result is kept. onFiles gets [{ name, sha256 }]. A hidden input does the choosing; the zone is the control.
 */
export function fileDrop({ hash, max = 5, accept = '', label = 'Add a receipt or invoice', sub = 'It stays on this device. Only its fingerprint (SHA-256) is saved.', onFiles } = {}) {
  const id = nextId('fd');
  const input = h('input', { type: 'file', class: 'sr', id, multiple: max > 1, accept, tabindex: '-1', aria: { hidden: 'true' } });
  const zone = h('button', { type: 'button', class: 'drop', id: id + 'b' }, h('span', { class: 'drop-ic' }, icon('out')), h('span', { class: 'grow' }, h('b', null, label), h('small', null, sub)));
  const list = h('ul', { class: 'drop-list', aria: { live: 'polite' } });
  const wrap = h('div', { class: 'dropwrap' }, input, zone, list);
  let files = [];
  const emit = () => { if (onFiles) onFiles(files.slice()); };
  const draw = () => list.replaceChildren(...files.map((f, i) => h('li', null, icon('check', 'sm'), h('span', { class: 'grow' }, h('b', null, f.name), h('code', null, f.sha256.slice(0, 16) + '…')),
    h('button', { type: 'button', class: 'ib', aria: { label: 'Remove ' + f.name }, on: { click: () => { files.splice(i, 1); draw(); emit(); } } }, icon('x', 'b')))));
  async function take(fl) {
    for (const f of [...fl].slice(0, Math.max(0, max - files.length))) {
      zone.classList.add('busy');
      try { files.push({ name: f.name.slice(0, 80), sha256: await hash(f) }); } finally { zone.classList.remove('busy'); }
    }
    draw(); emit();
  }
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { take(input.files || []); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer) take(e.dataTransfer.files); });
  Object.defineProperty(wrap, 'value', { get: () => files.slice() });
  return wrap;
}

/** A peso amount: digits only, formatted with commas when you leave it. `.value` is centavos or null. */
export function pesoField({ value = null, onChange } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', class: 'money-in', id: nextId('peso') });
  if (value) input.value = peso(value, true).slice(1);
  input.addEventListener('input', () => {
    const clean = input.value.replace(/[^\d.,]/g, '');
    if (clean !== input.value) input.value = clean;
    if (onChange) onChange(toCentavos(input.value));
  });
  input.addEventListener('blur', () => { const c = toCentavos(input.value); if (c) input.value = peso(c, true).slice(1); });
  const wrap = h('div', { class: 'field money' }, h('span', { class: 'cur', aria: { hidden: 'true' } }, '₱'), input);
  Object.defineProperty(wrap, 'value', { get: () => toCentavos(input.value) });
  return wrap;
}
