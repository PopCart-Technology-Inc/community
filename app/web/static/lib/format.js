// Formatting helpers. Pure (Intl only), so tests can import them.

/** "now", "12m", "3h", "2d", then a short date. */
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

/** "as of 9:41" (today) or "as of 19 Oct, 9:41". The live-data label of the golden rule. */
export function asOf(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const same = new Date(now).toDateString() === d.toDateString();
  return 'as of ' + (same ? time : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + time);
}

export function fullTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const UNITS = { hour: 'an hour', day: 'a day', night: 'a night', task: 'a task', fixed: 'fixed', week: 'a week', month: 'a month', run: 'a run' };

/** "₱600" + "a night". Amount in whole currency units as the API sends it. */
export function pay(amount, currency = 'PHP', unit = '') {
  let s;
  try { s = new Intl.NumberFormat('en-PH', { style: 'currency', currency: currency || 'PHP', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Number(amount)); }
  catch { s = String(amount) + ' ' + (currency || ''); }
  return { amount: s, unit: UNITS[unit] || unit || '' };
}

export function count(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

export const plural = (n, one, many) => (Number(n) === 1 ? one : many || one + 's');

/** Username rule shared with the server: 3-30 of a-z, 0-9, dot, underscore. */
export const HANDLE_RE = /^[a-z0-9._]{3,30}$/;

export const TRADES = [
  ['rider', 'Rider'], ['fresh', 'Fresh'], ['grill', 'Grill'], ['grocery', 'Grocery'],
  ['creator', 'Creator'], ['tutor', 'Tutor'], ['coder', 'Coder'], ['other', 'Other'],
];
export const tradeLabel = (t) => (TRADES.find((x) => x[0] === t) || [t, t ? t[0].toUpperCase() + t.slice(1) : ''])[1];
