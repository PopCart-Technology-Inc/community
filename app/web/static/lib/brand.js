// The optional brand pack. Brand art is never in this repository (TRADEMARKS.md): when the server has
// a pack, <body data-brand="1"> and /brand/* serves the sprite and fonts. Without it, the app uses
// system fonts and the plain text name.
import { h, useSymbol } from './dom.js';

export const hasBrand = () => document.body.dataset.brand === '1';

/** Load fonts and the sprite. Safe to call once at boot; failures leave the plain look. */
export async function loadBrand() {
  if (!hasBrand()) return;
  document.documentElement.classList.add('brand');
  try {
    if (typeof FontFace === 'function') {
      const fonts = [
        new FontFace('CommunitySans', 'url(/brand/fonts/archivo.ttf)', { weight: '100 900', stretch: '62.5% 125%', display: 'swap' }),
        new FontFace('CommunityMono', 'url(/brand/fonts/plex-mono-500.ttf)', { weight: '500', display: 'swap' }),
      ];
      for (const f of fonts) { document.fonts.add(f); f.load().catch(() => {}); }
    }
  } catch { /* fonts are optional */ }
  try {
    const r = await fetch('/brand/sprite.svg', { credentials: 'same-origin' });
    if (!r.ok) return;
    // The CSP blocks style attributes, even while DOMParser reads them, so the pack's (fill colours) are
    // renamed before parsing; each becomes a class, with its rule in a constructed stylesheet (allowed).
    const text = (await r.text()).replace(/(\s)style=(["'])/g, '$1data-bs=$2');
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return;
    svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    const classes = new Map();
    for (const el of svg.querySelectorAll('[data-bs]')) {
      const s = el.getAttribute('data-bs');
      el.removeAttribute('data-bs');
      if (!/^[\w\s:;,.()%#-]*$/.test(s)) continue; // declarations only, never a way out of the rule
      if (!classes.has(s)) classes.set(s, 'bs' + classes.size);
      el.classList.add(classes.get(s));
    }
    if (classes.size && 'adoptedStyleSheets' in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync([...classes].map(([s, c]) => `.sprite .${c}, .${c} { ${s} }`).join('\n'));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    const node = document.importNode(svg, true);
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('class', 'sprite');
    document.body.prepend(node);
    document.documentElement.classList.add('brand-art');
  } catch { /* the plain name stays */ }
}

/** The product name for headers: the pack's wordmark plus "community", or plain text. */
export function brandName(size = 'm') {
  if (document.documentElement.classList.contains('brand-art')) {
    return h('span', { class: 'lockup lockup-' + size, aria: { label: 'PopCart Community' } },
      useSymbol('wm', '0 0 1012 256', 'wm'), h('span', { class: 'xe', aria: { hidden: 'true' } }, 'community'));
  }
  return h('span', { class: 'plainname plainname-' + size }, 'Community');
}

/** The pack's Pop Mark, untouched, or nothing without the pack. */
export function popMark(cls) {
  if (!document.documentElement.classList.contains('brand-art')) return null;
  return useSymbol('mark', '0 0 120 120', cls);
}

const ILL = { rider: '0 0 440 400', fish: '0 0 420 400', grill: '0 0 400 400' };
/** A brand illustration when the pack has one, otherwise nothing. */
export function illustration(name, cls) {
  if (!document.documentElement.classList.contains('brand-art') || !ILL[name]) return null;
  return useSymbol('ill-' + name, ILL[name], cls);
}
