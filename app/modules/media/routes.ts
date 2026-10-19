// Media: image uploads. The type is decided by the file's own bytes (magic numbers), never by the
// name or the Content-Type header, and the size is read from the image header without decoding it.
// Files live in config.mediaDir/<id> and are served by app/server.ts at /media/:id.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, isUuid, json, noContent, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';

export const MAX_MEDIA_BYTES = 4_000_000;
/** Larger than any real photo; refuses headers that claim absurd sizes. */
const MAX_SIDE = 20_000;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export interface ImageInfo { mime: ImageMime; width: number; height: number }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Buffer, at: number, len: number): string => (b.length >= at + len ? b.toString('latin1', at, at + len) : '');

/** The image type by magic bytes: JPEG, PNG or WebP only. Anything else: null. */
export function sniff(b: Buffer): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'image/png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(b: Buffer): [number, number] | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1] as number;
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers without a length
    if (m === 0xd9 || m === 0xda) return null; // end of image or start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): [number, number] | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') {
    if (b.length < 30) return null;
    return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  }
  return null;
}

/** Type and size of an image from its bytes, or null when it is not a readable JPEG, PNG or WebP. */
export function inspectImage(b: Buffer): ImageInfo | null {
  const mime = sniff(b);
  if (!mime) return null;
  const size = mime === 'image/png' ? pngSize(b) : mime === 'image/jpeg' ? jpegSize(b) : webpSize(b);
  if (!size) return null;
  const [width, height] = size;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
  return { mime, width, height };
}

export function register(r: Router): void {
  r.post('/media', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.upload, me.id);
    // Refuse an oversized upload from its declared length, before reading any of it.
    if (Number(ctx.req.headers['content-length'] || 0) > MAX_MEDIA_BYTES) {
      return { status: 413, body:{ error: { code: 'too_large', message: 'Images can be at most 4 MB' } } };
    }
    const bytes = await ctx.raw(MAX_MEDIA_BYTES);
    if (!bytes.length) return fail(400, 'empty', 'No image was sent');
    const info = inspectImage(bytes);
    if (!info) return fail(400, 'not_an_image', 'Only JPEG, PNG and WebP images can be uploaded');
    const id = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(ctx.config.mediaDir, { recursive: true });
    const file = join(ctx.config.mediaDir, id);
    await writeFile(file, bytes, { flag: 'wx' });
    try {
      await ctx.db.query(
        `INSERT INTO media (id, owner_id, mime, bytes, width, height, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, me.id, info.mime, bytes.length, info.width, info.height, sha256]);
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    return json({ media: { id, mime: info.mime, bytes: bytes.length, width: info.width, height: info.height } }, 201);
  });

  r.delete('/media/:id', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const id = ctx.params.id;
    if (!isUuid(id)) return fail(404, 'not_found', 'No such file');
    const row = await ctx.db.one<{ owner_id: string }>('SELECT owner_id FROM media WHERE id = $1', [id]);
    if (!row) return fail(404, 'not_found', 'No such file');
    if (row.owner_id !== me.id) return fail(403, 'not_yours', 'Only the person who uploaded it can delete it');
    await ctx.db.tx(async (t) => {
      await t.query('DELETE FROM media WHERE id = $1', [id]);
      await t.query('UPDATE users SET avatar_media_id = NULL WHERE id = $1 AND avatar_media_id = $2', [me.id, id]);
      await t.query('UPDATE users SET cover_media_id = NULL WHERE id = $1 AND cover_media_id = $2', [me.id, id]);
      await t.query('UPDATE posts SET media_ids = array_remove(media_ids, $2::uuid) WHERE author_id = $1 AND $2::uuid = ANY (media_ids)', [me.id, id]);
    });
    await rm(join(ctx.config.mediaDir, id), { force: true });
    return noContent();
  });
}
