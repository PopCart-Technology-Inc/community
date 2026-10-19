// The published Places ranking (decisions 0003 and 0005). Everything that decides the order of a
// ranked feed lives in this file as pure functions, so anyone can read, test and change it in a pull
// request. The API returns these weights and rules with every ranked feed.
//
// Signals used: how near the post is to you, whether the author shares your trade, thanks (salamat)
// from different people, and how recent the post is. Never: paid boosts, outrage or engagement-bait
// signals, or anything about a person's private data.
import type { Level } from '../shared.ts';

export interface Weights { near: number; trade: number; salamat: number; fresh: number }

/** Per-level weights. Barangay is newest first only, so it has none. */
export const WEIGHTS: Record<Level, Weights | null> = {
  barangay: null,
  city: { near: 3, trade: 1, salamat: 1, fresh: 2 },
  region: { near: 1, trade: 1, salamat: 2, fresh: 2 },
  country: { near: 0.5, trade: 1, salamat: 2, fresh: 2 },
  world: { near: 0, trade: 1, salamat: 2, fresh: 2 },
};

/** Fair traffic: at most `authorMax` posts per author in every `authorWindow`; at Country and World, at
 *  most `mixMax` posts from any one city (Country) or country (World) in every `mixWindow`. */
export const FAIR = { authorMax: 2, authorWindow: 20, mixMax: 1, mixWindow: 4 } as const;

/** Fewer than this many posts in the last 24 hours makes a level "quiet". */
export const QUIET_BELOW = 5;

/** Hours over which freshness halves: fresh = 1 / (1 + hours / FRESH_HALF_HOURS). */
export const FRESH_HALF_HOURS = 12;

const FORMULA = 'score = near×w.near + trade×w.trade + log2(1 + thanks from different people)×w.salamat + fresh×w.fresh, fresh = 1/(1 + hours/12)';
const FAIRNESS = 'At most 2 posts per person in every 20.';

/** The one-line rule shown above each feed, with the formula behind "How?". */
export const RULES: Record<Level, string> = {
  barangay: `Newest first: small enough to see everything. ${FAIRNESS}`,
  city: `Ranked by nearness, trade, thanks from different people, and recency. ${FORMULA}. ${FAIRNESS}`,
  region: `Same signals as City; thanks from different people weigh more. ${FORMULA}. ${FAIRNESS}`,
  country: `Same signals, plus a mix rule: no single city gets more than 1 in 4 posts while other cities have posts to show. ${FORMULA}. ${FAIRNESS}`,
  world: `Ranked across countries and mixed by country: no single country gets more than 1 in 4 posts while other countries have posts to show. ${FORMULA}. ${FAIRNESS}`,
};

export const TRADE_RULE = `Ranked like City, filtered to one trade. ${FORMULA}. ${FAIRNESS}`;

/** The fields of a post the ranking reads. */
export interface Candidate {
  id: string;
  author_id: string;
  author_trade: string;
  created_at: string | Date;
  barangay_code: string | null;
  city_code: string | null;
  country_code: string | null;
  salamats_distinct: number;
}

/** Where the viewer is (their home area, or the area they are looking at) and their trade. */
export interface Viewer { barangay_code: string | null; city_code: string | null; trade: string | null }

export interface Signals { near: number; trade: number; salamats_distinct: number; fresh_hours: number }

export const freshness = (hours: number): number => 1 / (1 + Math.max(0, hours) / FRESH_HALF_HOURS);

/** 1 same barangay, 0.5 same city, 0 otherwise. */
export function nearness(post: Pick<Candidate, 'barangay_code' | 'city_code'>, viewer: Viewer): number {
  if (post.barangay_code && post.barangay_code === viewer.barangay_code) return 1;
  if (post.city_code && post.city_code === viewer.city_code) return 0.5;
  return 0;
}

const hoursSince = (t: string | Date, now: Date): number => Math.max(0, (now.getTime() - new Date(t).getTime()) / 3600_000);

export function signalsFor(post: Candidate, viewer: Viewer, now: Date): Signals {
  return {
    near: nearness(post, viewer),
    trade: viewer.trade && post.author_trade === viewer.trade ? 1 : 0,
    salamats_distinct: post.salamats_distinct,
    fresh_hours: Math.round(hoursSince(post.created_at, now) * 10) / 10,
  };
}

export function score(w: Weights, s: Signals): number {
  return w.near * s.near + w.trade * s.trade + w.salamat * Math.log2(1 + s.salamats_distinct) + w.fresh * freshness(s.fresh_hours);
}

const newestFirst = (a: Candidate, b: Candidate): number => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

/** Order candidates for a level: Barangay by time only, others by score (ties: newer first). */
export function rank<T extends Candidate>(level: Level, posts: readonly T[], viewer: Viewer, now: Date): T[] {
  const w = WEIGHTS[level];
  if (!w) return [...posts].sort(newestFirst);
  const scored = posts.map((p) => ({ p, s: score(w, signalsFor(p, viewer, now)) }));
  scored.sort((a, b) => b.s - a.s || newestFirst(a.p, b.p));
  return scored.map((x) => x.p);
}

/** Which grouping the mix rule uses at a level: city at Country, country at World, none below. */
export function mixGroup(level: Level): 'city_code' | 'country_code' | null {
  return level === 'country' ? 'city_code' : level === 'world' ? 'country_code' : null;
}

/**
 * Apply fair traffic to an ordered list, keeping the order as far as the caps allow.
 * - Author cap (hard): no author appears more than FAIR.authorMax times in any FAIR.authorWindow
 *   consecutive posts. Posts that cannot fit are held back.
 * - Mix rule (when `groupOf` is given): no group (city or country) appears more than FAIR.mixMax times
 *   in any FAIR.mixWindow consecutive posts. When every remaining post comes from a group that is
 *   already full, the post whose group appeared longest ago is placed anyway: the rule spaces places
 *   out, it never hides posts when only one or two places have anything left to show. Posts with no
 *   group are never limited.
 */
export function fairMix<T>(ordered: readonly T[], authorOf: (p: T) => string, groupOf?: (p: T) => string | null): T[] {
  const out: T[] = [];
  const left = [...ordered];
  const countIn = (window: number, key: (p: T) => string | null, value: string): number => {
    let n = 0;
    for (let i = Math.max(0, out.length - (window - 1)); i < out.length; i++) if (key(out[i] as T) === value) n++;
    return n;
  };
  const authorOk = (p: T) => countIn(FAIR.authorWindow, authorOf, authorOf(p)) < FAIR.authorMax;
  const groupOk = (p: T) => {
    if (!groupOf) return true;
    const g = groupOf(p);
    return g === null || countIn(FAIR.mixWindow, groupOf, g) < FAIR.mixMax;
  };
  /**
   * The best-scored post that fits now AND leaves the rest arrangeable under the mix rule. The rest
   * can still be spread out when (most posts any one group has left - 1) × window + (groups with that
   * many) ≤ posts left (the classic spacing bound). Without this look-ahead, a group with low scores
   * would bunch up at the end.
   */
  const keepsMixPossible = (): number => {
    if (!groupOf) return -1;
    const remaining = new Map<string, number>();
    for (const p of left) { const g = groupOf(p); if (g !== null) remaining.set(g, (remaining.get(g) || 0) + 1); }
    const possibleAfter = new Map<string | null, boolean>();
    const check = (g: string | null): boolean => {
      let max = 0, atMax = 0;
      for (const [k, v] of remaining) {
        const n = k === g ? v - 1 : v;
        if (n > max) { max = n; atMax = 1; } else if (n === max && n > 0) atMax++;
      }
      return max === 0 || (max - 1) * FAIR.mixWindow + atMax <= left.length - 1;
    };
    return left.findIndex((p) => {
      if (!authorOk(p) || !groupOk(p)) return false;
      const g = groupOf(p);
      if (!possibleAfter.has(g)) possibleAfter.set(g, check(g));
      return possibleAfter.get(g) as boolean;
    });
  };
  while (left.length) {
    let i = keepsMixPossible();
    if (i < 0) i = left.findIndex((p) => authorOk(p) && groupOk(p));
    if (i < 0 && groupOf) {
      // The mix rule yields only when no remaining post can satisfy it: take the post whose place was
      // seen longest ago (best score first on ties), so the places stay as spread out as they can.
      let best = -1, bestGap = -1;
      left.forEach((p, j) => {
        if (!authorOk(p)) return;
        const g = groupOf(p);
        let last = out.length - 1;
        while (last >= 0 && groupOf(out[last] as T) !== g) last--;
        const gap = out.length - last;
        if (gap > bestGap) { best = j; bestGap = gap; }
      });
      i = best;
    }
    if (i < 0) break; // everything left is over the author cap: held back
    out.push(left.splice(i, 1)[0] as T);
  }
  return out;
}

/** The next level out when a level is quiet (fewer than QUIET_BELOW posts in 24 hours); null at World. */
export function quietNext(level: Level, postsLast24h: number): Level | null {
  return postsLast24h >= QUIET_BELOW ? null : nextLevel(level);
}

/** One level out: barangay → city → region → country → world → null. */
export function nextLevel(level: Level): Level | null {
  const next: Record<Level, Level | null> = { barangay: 'city', city: 'region', region: 'country', country: 'world', world: null };
  return next[level];
}

export interface PlaceNames {
  barangay_code: string | null; barangay_name: string | null;
  city_code: string | null; city_name: string | null;
  country_name: string | null;
}

/**
 * Where a post is from, at the level's precision. Never coordinates or distances worked out from them.
 * Barangay and City: "same barangay" or the barangay's name (falling back to the city's).
 * Region and Country (and lists outside Places): the city. World: "City, Country".
 */
export function distanceHint(level: Level, post: PlaceNames, viewer: Viewer): string | null {
  if (level === 'barangay' || level === 'city') {
    if (post.barangay_code && post.barangay_code === viewer.barangay_code) return 'same barangay';
    return post.barangay_name || post.city_name || null;
  }
  if (level === 'world') {
    const parts = [post.city_name, post.country_name].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return post.city_name || post.country_name || null;
}
