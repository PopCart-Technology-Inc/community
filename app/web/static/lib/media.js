// Photos: re-encode through a canvas before upload. Drawing to a canvas and exporting drops every
// metadata block (EXIF GPS location, camera serials); we also downscale to 1600 px and use JPEG 0.85.
import { api } from './api.js';

export const MAX_SIDE = 1600;
export const QUALITY = 0.85;

/** Target size keeping the aspect ratio, longest side at most `max`. Pure. */
export function fitWithin(w, h, max = MAX_SIDE) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/** A clean JPEG Blob with no metadata. */
export async function reencode(file) {
  if (!/^image\//.test(file.type)) throw new Error('Choose a photo (JPEG, PNG or WebP)');
  const img = await decode(file);
  const { w, h } = fitWithin(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  if (typeof img.close === 'function') img.close();
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('This photo could not be prepared');
  return blob;
}

/** Re-encode then POST /media with the raw bytes. Returns the media row. */
export async function uploadPhoto(file) {
  const blob = await reencode(file);
  if (blob.size > 4_000_000) throw new Error('This photo is still over 4 MB after shrinking');
  const r = await api('POST', '/media', blob, { contentType: 'image/jpeg' });
  return r.media;
}
