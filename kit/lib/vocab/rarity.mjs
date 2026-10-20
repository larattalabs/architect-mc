// (6c VOC) A bible's optional `rarity` member (bible format 2, additive; docs/CONTRACT.md "Phase 6c slice VOC" §4.1) and the
// BibleRequest's budget field (§4.3, S-VOC-1; a typed record on the Java side, BibleRequest.Rarity, S-VOC-5): its schema, its limits
// and its defaults. The shared interface between VOC-a and VOC-b: VOC-b's validateBible, sidecar (FIELD_LIMIT before the round trip),
// metrics and rules read these, never their own copies.
//
//   rarity?: {
//     uncommonShareMax?: 0..0.5,        // default 0.10 (N-VOC-2)
//     rareShareMax?: 0..0.25,           // default 0.02 (N-VOC-2)
//     preciousMax?: 0..64,              // precious cells per building; default 0 (N-VOC-4)
//     preciousRegionMax?: 0..256,       // precious cells per region; default 0
//     families?: {family: shareMax},    // a per-family cap, 0..1 each
//     colours?: [dye],                  // the colours this style uses; free when absent
//     coloursMax?: 1..16,               // default 3
//     rareFamiliesMax?: 1..8,           // default 2
//     allow?: [block | #tag]            // counted as the style's own
//   }

import { DYES } from '../vocab.mjs';
import { BLOCKS, qualify, tagBlocks } from '../blocks.mjs';

/** The defaults of every bounded member (a bible without `rarity` is measured at these, into metrics only: §4.2). */
export const RARITY_DEFAULTS = Object.freeze({ uncommonShareMax: 0.1, rareShareMax: 0.02, preciousMax: 0, preciousRegionMax: 0, coloursMax: 3, rareFamiliesMax: 2 });

/** Each member's kind and range. `int` members are integers. Lists: at most `max` entries. */
export const RARITY_LIMITS = Object.freeze({
  uncommonShareMax: { kind: 'number', min: 0, max: 0.5 },
  rareShareMax: { kind: 'number', min: 0, max: 0.25 },
  preciousMax: { kind: 'int', min: 0, max: 64 },
  preciousRegionMax: { kind: 'int', min: 0, max: 256 },
  families: { kind: 'map', min: 0, max: 1, maxEntries: 32 },
  colours: { kind: 'dyes', maxEntries: 16 },
  coloursMax: { kind: 'int', min: 1, max: 16 },
  rareFamiliesMax: { kind: 'int', min: 1, max: 8 },
  allow: { kind: 'blocks', maxEntries: 64 },
});
export const RARITY_KEYS = Object.freeze(Object.keys(RARITY_LIMITS));

/**
 * Validates a `rarity` value. -> {errors: string[] (each naming its path, `rarity.x ...`), rarity: the value with every bounded default
 * filled in (null when there are errors)}. Unknown members are errors (as `restraint`'s are). `path` prefixes the messages.
 */
export function validateRarity(r, path = 'rarity') {
  const errors = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { errors: [`${path} must be an object { ${RARITY_KEYS.join(', ')} }`], rarity: null };
  for (const k of Object.keys(r)) if (!RARITY_LIMITS[k]) errors.push(`${path}: unknown field '${k}' (one of ${RARITY_KEYS.join(', ')})`);
  for (const [k, lim] of Object.entries(RARITY_LIMITS)) {
    const v = r[k];
    if (v === undefined) continue;
    const p = `${path}.${k}`;
    if (lim.kind === 'number' || lim.kind === 'int') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (lim.kind === 'int' && !Number.isInteger(v)) || v < lim.min || v > lim.max) errors.push(`${p} must be ${lim.kind === 'int' ? 'an integer' : 'a number'} ${lim.min}..${lim.max}`);
    } else if (lim.kind === 'map') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p} must be an object { family: shareMax }`); continue; }
      const ks = Object.keys(v);
      if (ks.length > lim.maxEntries) errors.push(`${p} has more than ${lim.maxEntries} families`);
      for (const f of ks) {
        if (!/^[a-z0-9_]+$/.test(f)) errors.push(`${p}: '${f}' is not a family name`);
        if (typeof v[f] !== 'number' || !(v[f] >= lim.min && v[f] <= lim.max)) errors.push(`${p}.${f} must be a number ${lim.min}..${lim.max}`);
      }
    } else if (lim.kind === 'dyes') {
      if (!Array.isArray(v) || v.length > lim.maxEntries) { errors.push(`${p} must be a list of at most ${lim.maxEntries} dye colours`); continue; }
      for (const d of v) if (!DYES.includes(d)) errors.push(`${p}: '${d}' is not a dye colour (one of ${DYES.join(', ')})`);
      if (new Set(v).size !== v.length) errors.push(`${p} lists a colour twice`);
    } else if (lim.kind === 'blocks') {
      if (!Array.isArray(v) || v.length > lim.maxEntries) { errors.push(`${p} must be a list of at most ${lim.maxEntries} blocks or #tags`); continue; }
      for (const b of v) {
        if (typeof b !== 'string') { errors.push(`${p}: ${JSON.stringify(b)} is not a block or #tag`); continue; }
        if (b.startsWith('#') ? !tagBlocks(b) : !BLOCKS[qualify(b)]) errors.push(`${p}: '${b}' is not a ${b.startsWith('#') ? 'vanilla block tag' : 'vanilla 26.3 block'}`);
      }
    }
  }
  if (errors.length) return { errors, rarity: null };
  return { errors, rarity: { ...RARITY_DEFAULTS, ...r } };
}

/** The blocks `allow` names, qualified (tags expanded), sorted. */
export function allowedBlocks(r) {
  const s = new Set();
  for (const b of r?.allow ?? []) for (const x of b.startsWith('#') ? tagBlocks(b) ?? [] : [qualify(b)]) s.add(x);
  return [...s].sort();
}
