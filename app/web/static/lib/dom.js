// A tiny DOM builder. Everything is built with createElement and textContent, never innerHTML with
// data, so posts and names can never inject markup. No inline style attributes (the CSP blocks them):
// use classes. Nothing touches `document` at import.

const SVG = 'http://www.w3.org/2000/svg';

/**
 * h('a', { href: '/p/1', class: 'x', on: { click: fn }, aria: { label: 'Open' } }, 'text', child, [more])
 * Props: class, text, on, aria, data, and any attribute or DOM property (value, checked, disabled...).
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) apply(el, props);
  append(el, kids);
  return el;
}

function apply(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'aria') for (const [a, av] of Object.entries(v)) { if (av !== undefined && av !== null) el.setAttribute('aria-' + a, String(av)); }
    else if (k === 'data') for (const [d, dv] of Object.entries(v)) { if (dv !== undefined && dv !== null) el.dataset[d] = String(dv); }
    else if (k === 'style') throw new Error('no inline styles: use a class');
    else if (/^on[a-z]/i.test(k)) throw new Error('no inline handlers: use on: {}');
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** Stroke icons (generic shapes, drawn for this app). */
const P = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5', bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  hash: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18', work: 'M3 8h18v12H3zM8 8V5h8v3M3 13h18', inbox: 'M4 4h16v16H4zM4 14h5l1 2h4l1-2h5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', pen: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', plus: 'M12 5v14M5 12h14',
  reply: 'M21 12a8 8 0 0 1-12 7l-5 1 1-4.5A8 8 0 1 1 21 12z', heart: 'M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z',
  save: 'M6 3h12v18l-6-4-6 4z', share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01', back: 'M15 6l-6 6 6 6', chev: 'M9 6l6 6-6 6', x: 'M6 6l12 12M18 6L6 18', check: 'M5 12l5 5L20 7',
  lock: 'M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7.5v.5',
  pin: 'M12 21s-7-6-7-12a7 7 0 0 1 14 0c0 6-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01',
  cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7',
  flag: 'M5 21V4h11l-2 4 2 4H5', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff: 'M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1.1',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1', download: 'M12 4v11M7 10l5 5 5-5M5 20h14', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  finger: 'M12 11v4M8 9a4 4 0 0 1 8 0v5a8 8 0 0 1-1 4M5 12a7 7 0 0 1 14-2M9 14v1a6 6 0 0 1-1 4M12 3a9 9 0 0 1 9 9', msg: 'M4 5h16v11H9l-5 4z', send: 'M4 12l16-8-6 16-2-7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
  scale: 'M12 3v18M7 21h10M4 7h16M7 7l-3 7h6zM17 7l-3 7h6z', globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  star: 'M12 3l2.7 5.6 6.3.9-4.5 4.3 1 6.2L12 17l-5.5 3 1-6.2L3 9.5l6.3-.9z', out: 'M4 13v7h16v-7M12 3v12M7 8l5-5 5 5', logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', ('ic ' + cls).trim());
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', P[name] || P.info);
  svg.append(p);
  return svg;
}

/** <svg><use href="#id"></svg> for symbols from the optional brand sprite. */
export function useSymbol(id, viewBox, cls, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', viewBox);
  if (cls) svg.setAttribute('class', cls);
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', '#' + id);
  svg.append(u);
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
