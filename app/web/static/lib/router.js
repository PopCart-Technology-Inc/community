// Path matching for the client-side router. Pure: no DOM, so tests can import it.
// A pattern is a path with :named segments, for example "/s/:slug/c/:channel".

/** @typedef {{ name: string, path: string, re: RegExp, keys: string[] }} Route */

/** Compile a list of [name, pattern] pairs. */
export function compile(table) {
  return table.map(([name, path]) => {
    const keys = [];
    const src = path === '/' ? '' : path.replace(/\/+$/, '').split('/').slice(1).map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '/([^/]+)'; }
      return '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { name, path, keys, re: new RegExp('^' + src + '/?$') };
  });
}

/** Match a pathname against compiled routes: { name, params } or null. Params are URI-decoded. */
export function match(routes, pathname) {
  const p = (pathname || '/').split(/[?#]/)[0] || '/';
  for (const r of routes) {
    const m = r.re.exec(p);
    if (!m) continue;
    const params = {};
    try {
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    } catch { return null; }
    return { name: r.name, params };
  }
  return null;
}

/** Build a path from a pattern and params, encoding each value. */
export function build(pattern, params = {}) {
  return pattern.replace(/:([A-Za-z_]+)/g, (_, k) => {
    if (params[k] === undefined || params[k] === null) throw new Error('missing param ' + k);
    return encodeURIComponent(String(params[k]));
  });
}

/** Every screen of the web app. Order matters only where patterns could overlap. */
export const ROUTES = [
  ['home', '/'],
  ['places', '/places'],
  ['placesAt', '/places/:level/:code'],
  ['trade', '/trade'],
  ['picks', '/picks'],
  ['join', '/join'],
  ['login', '/login'],
  ['post', '/p/:id'],
  ['compose', '/compose'],
  ['explore', '/explore'],
  ['activity', '/activity'],
  ['spaces', '/spaces'],
  ['space', '/s/:slug'],
  ['channel', '/s/:slug/c/:channel'],
  ['inbox', '/inbox'],
  ['dm', '/inbox/:id'],
  ['work', '/work'],
  ['gigNew', '/gigs/new'],
  ['gig', '/gigs/:id'],
  ['apply', '/gigs/:id/apply'],
  ['applicants', '/gigs/:id/applicants'],
  ['rate', '/gigs/:id/rate'],
  ['profile', '/u/:handle'],
  ['me', '/me'],
  ['settings', '/me/settings'],
  ['invite', '/me/invite'],
  ['data', '/me/data'],
  ['proof', '/me/proof'],
  ['records', '/me/records'],
  ['actions', '/me/actions'],
  ['socials', '/me/socials'],
  ['report', '/report'],
  ['transparency', '/transparency'],
  ['mod', '/mod'],
];
