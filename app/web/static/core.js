// App-wide state and navigation, shared by every screen without import cycles.

export const state = {
  /** The signed-in person (GET /me), or null. */
  me: null,
};

let navigator_ = () => {};
export const setNavigator = (fn) => { navigator_ = fn; };
/** Go to a path inside the app (History API). */
export const nav = (path, opts) => navigator_(path, opts);

export const isMe = (id) => !!state.me && state.me.id === id;

/** localStorage that never throws (private mode, blocked storage). Used for small per-device choices only. */
export const local = {
  get(k, fallback = null) { try { const v = localStorage.getItem('cm.' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('cm.' + k, JSON.stringify(v)); } catch { /* not kept */ } },
};
