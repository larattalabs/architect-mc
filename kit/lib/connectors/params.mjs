// (7a K1) Lenient `params` (docs/CONTRACT.md "Phase 7a slice K1" §1, R17, Steward's S-K1-3): a K1 part's `params` (the envelope's
// free-form member, as Steward's recorded plans write it) is read where a key maps onto a first-class member the part leaves out,
// never malformed; every key that isn't read is listed by name in the part's notes. Lot-naming keys (towers, corner_lots, joins,
// anchors, gate_lot, gateLots, gate, gates as a list) are the lots the wall would join (S-K1-2: each a `join` deviation when the
// lot stands beside the wall instead of in it).

/** The keys that name lots on the wall line. */
export const JOIN_KEYS = Object.freeze(['towers', 'corner_lots', 'joins', 'anchors', 'gate_lot', 'gateLots', 'gate', 'gates']);

const isInt = Number.isInteger;

/**
 * Read a part's params. Returns `{read: {height?, closed?, gatesMin?, lamps?}, unread: [key], joins: [{key, lot}], notes: [string]}`.
 * `kind`: wall, gate, rope_bridge or auto. A key is read only when the part has no first-class member for it.
 */
export function readParams(kind, part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, unread = [], joins = [], why = new Map();
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    let ok = false;
    if (kind === 'wall') {
      if (key === 'height' && part.height === undefined && isInt(v) && v >= 3 && v <= 16) { read.height = v; ok = true; }
      else if (key === 'height' && part.height === undefined) why.set(key, 'outside 3..16');
      else if (key === 'closed' && typeof v === 'boolean' && part.where?.around?.closed === undefined) { read.closed = v; ok = true; }
      else if (key === 'gates' && isInt(v) && part.gates === undefined && v >= 0 && v <= 16) { read.gatesMin = v; ok = true; }
      else if (key === 'torches' && v === true && part.lamps === undefined) { read.lamps = 'every'; ok = true; }
    }
    if (!ok) {
      unread.push(key);
      if (kind === 'wall' && JOIN_KEYS.includes(key)) for (const lot of (Array.isArray(v) ? v : [v])) if (typeof lot === 'string') joins.push({ key, lot });
    }
  }
  const notes = unread.map((k) => `params.${k} not read${why.has(k) ? ` (${why.get(k)})` : ''}`);
  return { read, unread, joins, notes };
}
