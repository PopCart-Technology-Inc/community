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

async function call(method, path, body) {
  try {
    const r = await api(method, path, body);
    if (S.session && S.session.user) S.idleEnds = Date.now() + S.session.idle_minutes * 60_000;
    return r;
  } catch (e) {
    if (e && e.status === 401 && e.code === 'staff_sign_in') lost();
    throw e;
  }
}

export const sget = (path, params) => call('GET', path + qs(params));
export const spost = (path, body) => call('POST', path, body === undefined ? {} : body);
export const sput = (path, body) => call('PUT', path, body);
export const sdel = (path) => call('DELETE', path);
export const enc = encodeURIComponent;
