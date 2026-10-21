// The API client: JSON in and out, same-origin cookies, errors as ApiError with the server's message.

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Build a query string from an object, skipping empty values. */
export function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

export async function api(method, path, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    init.body = body;
    init.headers['Content-Type'] = opts.contentType || (body instanceof Blob && body.type) || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let r;
  try { r = await fetch('/api' + path, init); }
  catch { throw new ApiError(0, 'offline', 'Could not reach Community. Check your connection.'); }
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(r.status, e.code || 'error', e.message || (r.status === 404 ? 'Not found' : 'Something went wrong (' + r.status + ')'));
  }
  return data;
}

export const get = (path, params) => api('GET', path + qs(params));
export const post = (path, body) => api('POST', path, body === undefined ? {} : body);
export const patch = (path, body) => api('PATCH', path, body);
export const put = (path, body) => api('PUT', path, body);
export const del = (path, body) => api('DELETE', path, body);
