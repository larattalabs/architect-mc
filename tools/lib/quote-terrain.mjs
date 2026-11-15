// (QL) Quote.terrain in the gate drivers: its shape against the quote's bill, and Steward's maxBill rule over it (QL's contract).

/**
 * The shape problems of a quote's terrain part (an empty list: fine): every count an integer in [0, bom[item]], at most the item's tile
 * pieces together (terrain cells are tile cells), keys sorted.
 */
export function terrainShape(q) {
  const bad = [];
  const t = q?.terrain;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['no terrain object'];
  const keys = Object.keys(t);
  if (keys.join('\n') !== [...keys].sort().join('\n')) bad.push(`keys not sorted: ${keys.join(',')}`);
  for (const [k, v] of Object.entries(t)) {
    const bom = q.bom?.[k] ?? 0;
    const tiles = Object.entries(q.bomParts ?? {}).filter(([p]) => p.startsWith('tiles:')).reduce((s, [, its]) => s + (its?.[k] ?? 0), 0);
    if (!Number.isInteger(v) || v < 0) bad.push(`${k}: ${v} is not a count`);
    else if (v > bom) bad.push(`${k}: ${v} > bom ${bom}`);
    else if (v > tiles) bad.push(`${k}: ${v} > its tile pieces ${tiles}`);
  }
  return bad;
}

/** Steward's maxBill (QL): bom[item] + max(2, ceil(2% of terrain[item])) for a terrain item, over bom's and terrain's keys; else exact. */
export function stewardCap(q) {
  const cap = { ...(q?.bom ?? {}) };
  for (const [k, v] of Object.entries(q?.terrain ?? {})) cap[k] = (cap[k] ?? 0) + Math.max(2, Math.ceil(v * 0.02));
  return Object.fromEntries(Object.entries(cap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
