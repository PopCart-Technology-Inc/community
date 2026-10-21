// Every module registers its routes here. The full API contract is docs/api.md.
import type { Router } from '../http/router.ts';
import { register as accounts } from './accounts/routes.ts';
import { register as people } from './people/routes.ts';
import { register as places } from './places/routes.ts';
import { register as posts } from './posts/routes.ts';
import { register as spaces } from './spaces/routes.ts';
import { register as work } from './work/routes.ts';
import { register as safety } from './safety/routes.ts';
import { register as media } from './media/routes.ts';
import { register as books } from './books/routes.ts';

export function registerAll(r: Router): void {
  r.get('/health', async (ctx) => {
    await ctx.db.query('SELECT 1');
    return { status: 200, body: { ok: true } };
  });
  for (const reg of [accounts, people, places, posts, spaces, work, safety, media, books]) reg(r);
}
