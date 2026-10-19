// The "For you" gig ranking, published. Pure functions only: the same inputs always give the same score,
// and GET /gigs returns `rule` and `weights` so anyone can check why a gig sits where it does.
// No paid boosts, no private data, nothing from the sealed vault, no engagement signals.

export const GIG_WEIGHTS = { near: 3, trade: 2, trust: 1.5, fresh: 1 } as const;
export type GigWeights = { near: number; trade: number; trust: number; fresh: number };

/** Ratings a poster needs before their average counts fully: trust = avg share × n / (n + TRUST_PRIOR). */
export const TRUST_PRIOR = 3;
/** Hours after which freshness halves. */
export const FRESH_HALF_HOURS = 24;

export const GIG_RULE =
  `For you: score = ${GIG_WEIGHTS.near}*near + ${GIG_WEIGHTS.trade}*trade + ${GIG_WEIGHTS.trust}*trust + ${GIG_WEIGHTS.fresh}*fresh. ` +
  'near = 1 same barangay, 0.5 same city, 0.25 same region, 0 otherwise (from your home area, never your location). ' +
  'trade = 1 when the gig lists your trade as a skill. ' +
  `trust = the poster's average rating (1-5 mapped to 0-1) times n/(n+${TRUST_PRIOR}) for n ratings received. ` +
  `fresh = 1/(1 + hours/${FRESH_HALF_HOURS}). Only open gigs. Ties: newest first. No paid boosts.`;

export const NEWEST_RULE = 'Newest: open gigs, newest first. Nothing else.';

export interface PlaceCodes { barangay_code: string | null; city_code: string | null; region_code: string | null }

/** 1 same barangay, 0.5 same city, 0.25 same region, else 0. */
export function nearSignal(viewer: PlaceCodes | null, gig: PlaceCodes): number {
  if (!viewer) return 0;
  if (viewer.barangay_code && viewer.barangay_code === gig.barangay_code) return 1;
  if (viewer.city_code && viewer.city_code === gig.city_code) return 0.5;
  if (viewer.region_code && viewer.region_code === gig.region_code) return 0.25;
  return 0;
}

export function tradeSignal(viewerTrade: string | null, skills: readonly string[]): number {
  return viewerTrade && skills.includes(viewerTrade) ? 1 : 0;
}

/** avg is the mean of all four criteria over every rating the poster received (1-5), or null for none. */
export function trustSignal(ratingsCount: number, avg: number | null): number {
  if (!ratingsCount || avg === null) return 0;
  const share = Math.min(1, Math.max(0, (avg - 1) / 4));
  return share * (ratingsCount / (ratingsCount + TRUST_PRIOR));
}

export function freshSignal(createdAt: Date, now: Date): number {
  const hours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3600_000);
  return 1 / (1 + hours / FRESH_HALF_HOURS);
}

export interface GigSignals { near: number; trade: number; trust: number; fresh: number }

export function gigScore(s: GigSignals, w: GigWeights = GIG_WEIGHTS): number {
  return w.near * s.near + w.trade * s.trade + w.trust * s.trust + w.fresh * s.fresh;
}

/** A plain-words hint of how close a gig is, from area codes only. Never a distance in metres. */
export function distanceHint(viewer: (PlaceCodes & { country_code: string | null }) | null, gig: PlaceCodes & { country_code: string | null }): string | null {
  if (!viewer) return null;
  if (viewer.barangay_code && viewer.barangay_code === gig.barangay_code) return 'In your barangay';
  if (viewer.city_code && viewer.city_code === gig.city_code) return 'In your city';
  if (viewer.region_code && viewer.region_code === gig.region_code) return 'In your region';
  if (viewer.country_code && viewer.country_code === gig.country_code) return 'In your country';
  return null;
}
