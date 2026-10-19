// Places levels (decision 0005). Pure.

export const LEVELS = [
  { k: 'barangay', label: 'Barangay' },
  { k: 'city', label: 'City' },
  { k: 'region', label: 'Region' },
  { k: 'country', label: 'Country' },
  { k: 'world', label: 'World' },
];
export const DEFAULT_LEVEL = 'city';
export const levelIndex = (k) => LEVELS.findIndex((l) => l.k === k);
export const isLevel = (k) => levelIndex(k) >= 0;

/** Area levels from the place data that sit at a zoom level (provinces count as region-wide). */
const AREA_TO_ZOOM = { barangay: 'barangay', city: 'city', municipality: 'city', province: 'region', region: 'region', country: 'country', world: 'world' };
export const zoomOf = (areaLevel) => AREA_TO_ZOOM[areaLevel] || areaLevel;

/**
 * The area code to ask for at a zoom level, given the chain of a focus area (the area plus its
 * ancestors, as GET /places/:code returns). null when the level is finer than the focus area: the
 * person must pick a place inside it.
 */
export function codeAtLevel(chain, level) {
  if (level === 'world') return 'WORLD';
  const hit = (chain || []).find((a) => a.level === level) || (chain || []).find((a) => zoomOf(a.level) === level);
  return hit ? hit.code : null;
}
