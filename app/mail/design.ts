// The email design: Stage mode from docs/design, rebuilt for email clients. Tables and inline styles
// only (most clients drop <style> and ignore flexbox), no web fonts (fetching them would tell a font
// server who opened the email), no images except the optional brand wordmark, no tracking pixels and
// no per-person parameters in links.
//
// Every email is a stack of blocks inside one shell:
//   Cream page · Yellow header with the name · White card with a 3px Ink edge · a plain footer.
// The blocks are the same few the app uses: kicker, headline, lead, button, code chip, numbered
// steps, a note sticker, sections (for announcements), and a fine-print line.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';

/** Stage mode colours (app/web/static/app.css). */
export const C = {
  yellow: '#FFE500', blue: '#1B34FF', ink: '#14110F', cream: '#FFF6E3', white: '#FFFFFF',
  kiwi: '#6EDC5F', sky: '#7CC8FF', gum: '#FF8AD8', ink500: '#6E665C', cream200: '#F3EAD6',
} as const;

const SANS = "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";
const EDGE = `3px solid ${C.ink}`;

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
/** Only http(s) links, escaped for an attribute. */
const href = (url: string): string => (/^https?:\/\/[^\s"'<>]+$/.test(url) ? esc(url) : '#');

/** A block renders twice: HTML for the email body and plain text for the text part. */
export interface Block { html: string; text: string }

export const kicker = (label: string): Block => ({
  html: `<p style="margin:0 0 14px;"><span style="display:inline-block;background:${C.ink};color:${C.yellow};border-radius:999px;padding:5px 12px;font-family:${MONO};font-size:11px;line-height:14px;font-weight:500;letter-spacing:1px;text-transform:uppercase;">${esc(label)}</span></p>`,
  text: label.toUpperCase(),
});

export const headline = (s: string): Block => ({
  html: `<h1 style="margin:0 0 14px;font-family:${SANS};font-size:30px;line-height:34px;font-weight:900;color:${C.ink};">${esc(s)}</h1>`,
  text: s,
});

export const lead = (s: string): Block => ({
  html: `<p style="margin:0 0 20px;font-family:${SANS};font-size:17px;line-height:26px;color:${C.ink};">${esc(s)}</p>`,
  text: s,
});

export const para = (s: string): Block => ({
  html: `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:23px;color:${C.ink};">${esc(s)}</p>`,
  text: s,
});

/** The main action: a Cart Blue pill with Pop Yellow words, a 3px Ink edge and a hard Ink shadow, as in the app. */
export const button = (label: string, url: string): Block => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:4px 0 24px;"><tr>
<td bgcolor="${C.blue}" style="background:${C.blue};border:${EDGE};border-radius:999px;box-shadow:0 5px 0 0 ${C.ink};padding:15px 26px;"><a href="${href(url)}" style="font-family:${SANS};font-size:17px;line-height:20px;font-weight:800;color:${C.yellow};text-decoration:none;display:inline-block;">${esc(label)}</a></td>
</tr></table>`,
  text: `${label}: ${url}`,
});

/** A one-time code on a Cream chip, big enough to read across a room. */
export const codeChip = (code: string): Block => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:4px 0 22px;"><tr>
<td bgcolor="${C.cream}" style="background:${C.cream};border:${EDGE};border-radius:18px;padding:14px 24px;font-family:${MONO};font-size:40px;line-height:44px;font-weight:600;letter-spacing:10px;color:${C.ink};">${esc(code)}</td>
</tr></table>`,
  text: code,
});

/** Numbered steps: Pop Yellow number stickers with an Ink edge. */
export const steps = (items: string[]): Block => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${items.map((s, i) => `<tr>
<td width="44" valign="top" style="padding:0 12px 12px 0;"><div style="width:32px;height:32px;line-height:28px;text-align:center;background:${C.yellow};border:${EDGE};border-radius:999px;font-family:${MONO};font-size:14px;font-weight:600;color:${C.ink};box-sizing:border-box;">${i + 1}</div></td>
<td valign="top" style="padding:5px 0 12px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.ink};">${esc(s)}</td>
</tr>`).join('')}</table>`,
  text: items.map((s, i) => `${i + 1}. ${s}`).join('\n'),
});

/** A coloured sticker for one point that matters (safety, a deadline). Sky = info, Kiwi = good, Gum = people. */
export const note = (s: string, tone: 'sky' | 'kiwi' | 'gum' | 'cream' = 'sky'): Block => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 20px;"><tr>
<td bgcolor="${C[tone]}" style="background:${C[tone]};border:${EDGE};border-radius:16px;padding:14px 16px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.ink};">${esc(s)}</td>
</tr></table>`,
  text: s,
});

/** Announcement sections: a short title and a line or two each, split by hairlines. */
export const sections = (items: { title: string; text: string }[]): Block => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${items.map((s, i) => `<tr><td style="padding:${i ? 16 : 0}px 0 16px;${i ? `border-top:1px solid ${C.cream200};` : ''}font-family:${SANS};color:${C.ink};">
<p style="margin:0 0 4px;font-size:17px;line-height:22px;font-weight:900;">${esc(s.title)}</p>
<p style="margin:0;font-size:15px;line-height:23px;">${esc(s.text)}</p>
</td></tr>`).join('')}</table>`,
  text: items.map((s) => `${s.title}\n${s.text}`).join('\n\n'),
});

/** An image that is already hosted on https (email clients cannot use local files or SVG). */
export const picture = (src: string, alt: string, width: number, height: number): Block => ({
  html: `<p style="margin:0 0 20px;"><img src="${href(src)}" width="${width}" height="${height}" alt="${esc(alt)}" style="display:block;width:100%;max-width:${width}px;height:auto;border:${EDGE};border-radius:18px;"></p>`,
  text: '',
});

export const fine = (s: string): Block => ({
  html: `<p style="margin:8px 0 0;font-family:${SANS};font-size:13px;line-height:19px;color:${C.ink500};">${esc(s)}</p>`,
  text: s,
});

/**
 * The name in the yellow header. With the brand pack (BRAND_DIR/email/wordmark.png, outside this
 * repository: TRADEMARKS.md) it is the drawn wordmark image, served from /brand/; the image's alt
 * text is the fallback. Without it, the plain product name in bold, as the app shows it.
 */
function masthead(config: Config): string {
  const label = `<span style="font-family:${MONO};font-size:11px;line-height:14px;font-weight:500;letter-spacing:1px;text-transform:uppercase;color:${C.ink};">Community</span>`;
  const brand = config.brandDir && existsSync(join(config.brandDir, 'email', 'wordmark.png'));
  const name = brand
    ? `<img src="${href(config.origin + '/brand/email/wordmark.png')}" width="136" height="34" alt="PopCart" style="display:block;border:0;width:136px;height:34px;font-family:${SANS};font-size:22px;font-weight:900;color:${C.blue};">`
    : `<span style="font-family:${SANS};font-size:22px;line-height:28px;font-weight:900;color:${C.ink};">${esc(config.rpName)}</span>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle">${name}</td>${brand ? `<td valign="middle" align="right">${label}</td>` : ''}
</tr></table>`;
}

export interface Email { subject: string; text: string; html: string }

/**
 * Put blocks in the shell. `preheader` is the grey line inbox lists show after the subject. `why`
 * says in the footer why this person got the email; every email has one.
 */
export function shell(config: Config, m: { subject: string; preheader: string; blocks: Block[]; why: string }): Email {
  const host = new URL(config.origin).host;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(m.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.cream};color:${C.ink};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(m.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.cream}" style="background:${C.cream};">
<tr><td align="center" style="padding:24px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;border-collapse:separate;">
<tr><td bgcolor="${C.yellow}" style="background:${C.yellow};border:${EDGE};border-bottom:0;border-radius:24px 24px 0 0;padding:20px 24px;">${masthead(config)}</td></tr>
<tr><td bgcolor="${C.white}" style="background:${C.white};border:${EDGE};border-radius:0 0 24px 24px;padding:28px 24px 28px;">
${m.blocks.map((b) => b.html).join('\n')}
</td></tr>
<tr><td style="padding:16px 8px 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.ink500};">${esc(m.why)}<br>${esc(config.rpName)} &middot; <a href="${href(config.origin)}" style="color:${C.blue};">${esc(host)}</a> &middot; open source</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [...m.blocks.map((b) => b.text).filter(Boolean), '--', m.why, `${config.rpName} · ${host}`].join('\n\n');
  return { subject: m.subject, html, text };
}
