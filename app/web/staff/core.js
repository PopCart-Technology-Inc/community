// Shared state for the staff panel: the staff session, scopes, navigation, and API calls that count as
// activity (each one moves the idle lock, as the server does).
import { api, qs } from '/static/lib/api.js';

export const S = {
  /** The last GET /staff/session. */
  session: null,
  /** When the idle lock comes (ms since epoch). */
  idleEnds: 0,
};

/** Does the signed-in staff member's role allow this? The server checks again on every call. */
export const has = (scope) => !!(S.session && S.session.user && S.session.user.scopes.includes(scope));

let lost = () => {};
let nav = () => {};
export const setHandlers = (h) => { lost = h.lost; nav = h.nav; };
/** Go to a panel path (History API). */
export const go = (path, opts) => nav(path, opts);

async function call(method, path, body, activity = true) {
  try {
    const r = await api(method, path, body);
    if (activity && S.session && S.session.user) S.idleEnds = Date.now() + S.session.idle_minutes * 60_000;
    return r;
  } catch (e) {
    if (e && e.status === 401 && e.code === 'staff_sign_in') lost();
    throw e;
  }
}

export const sget = (path, params) => call('GET', path + qs(params));
/** A GET the server does not count as activity (it must be on its list, app/server.ts): the idle clock keeps running. */
export const speek = (path, params) => call('GET', path + qs(params), undefined, false);
export const spost = (path, body) => call('POST', path, body === undefined ? {} : body);
export const sput = (path, body) => call('PUT', path, body);
export const spatch = (path, body) => call('PATCH', path, body);
export const sdel = (path) => call('DELETE', path);
export const enc = encodeURIComponent;
