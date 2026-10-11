// (6c MP) Masks (docs/CONTRACT.md 6c slice MP §2): a pointwise cell selector on an op (`shape` and `columns`; later `relief`,
// scatter and brushes). A cell the mask rejects is skipped: not written, not part of the entry. Terms read the cell, its
// column or the frozen columns beside it (K2):
//   {block: [ids | #tags]}  the cell's frozen block (needs a frozen block volume: see compileMask)
//   {height: [a, b]}        absolute y, a <= y <= b
//   {slope: [a, b]}         the frozen ground's slope at the column (as material rules: the largest 4-neighbour step)
//   {depth: [a, b]}         cells below the frozen ground (0 = the ground cell, negative above it)
//   {field: name, gte, lt}  a 2D field's sample at the column
//   {noise: spec, gte, lt}  a seeded noise field at the cell, in [-1, 1]
//   {class: [names]}        the cell's voxel class in the IR's frozen volumes (MISSING outside them)
// and the combinators {all: [...]}, {any: [...]}, {not: m}. The spec is checked by kit/schemas/mask.json (lib/specschema.mjs)
// plus the rules below; the mod's api.Mask runs the same checks. Under the realise lint.
import { validateSpec } from './specschema.mjs';
import { makeNoise } from './noise.mjs';
import { sampleField } from './material.mjs';
import fs from 'node:fs';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../schemas/mask.json', import.meta.url), 'utf8'));
export const MASK_SCHEMA = SCHEMA;
export const MASK_TERMS = Object.freeze(['block', 'height', 'slope', 'depth', 'field', 'noise', 'class']);
export const MASK_COMBINATORS = Object.freeze(['all', 'any', 'not']);
export const MASK_MAX_DEPTH = 8;
export const MASK_MAX_NODES = 64;
export const VOXEL_CLASS_NAMES = Object.freeze(['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING']);

const keyOf = (m) => Object.keys(m).find((k) => MASK_TERMS.includes(k) || MASK_COMBINATORS.includes(k));

/**
 * The rules the schema can't say (x-rules): ranges ordered, gte < lt, at most MASK_MAX_DEPTH deep and MASK_MAX_NODES nodes.
 * `spec` already passed the schema. Returns the first error or null.
 */
export function maskRuleError(spec, where = 'mask') {
  let nodes = 0;
  const walk = (m, w, depth) => {
    nodes++;
    if (nodes > MASK_MAX_NODES) return `${where}: more than ${MASK_MAX_NODES} nodes`;
    if (depth > MASK_MAX_DEPTH) return `${w}: nested more than ${MASK_MAX_DEPTH} deep`;
    const k = keyOf(m);
    if (k === 'all' || k === 'any') {
      for (let i = 0; i < m[k].length; i++) { const e = walk(m[k][i], `${w}.${k}[${i}]`, depth + 1); if (e) return e; }
      return null;
    }
    if (k === 'not') return walk(m.not, `${w}.not`, depth + 1);
    if ((k === 'height' || k === 'slope' || k === 'depth') && m[k][0] > m[k][1]) return `${w}.${k}: [a, b] needs a <= b`;
    if ((k === 'field' || k === 'noise') && m.gte !== undefined && m.lt !== undefined && !(m.gte < m.lt)) return `${w}: gte must be under lt`;
    return null;
  };
  return walk(spec, where, 1);
}

/**
 * Validate a mask spec: the schema, then the rules. `fields` (a Set of the IR's field names, optional) also checks that every
 * field term names one. Returns the first error ("<where>...: message") or null.
 */
export function maskError(spec, where = 'mask', { fields = null } = {}) {
  const errs = validateSpec(SCHEMA, spec, where);
  if (errs.length) return errs[0];
  const e = maskRuleError(spec, where);
  if (e) return e;
  if (fields) {
    const missing = [...maskTerms(spec, 'field')].find((f) => !fields.has(f));
    if (missing !== undefined) return `${where}: field '${missing}' is not one of the IR's fields`;
  }
  return null;
}

/** The values of every `kind` term in a mask (`field`: the field names; `block`: ids and tags; ...), as a Set. */
export function maskTerms(spec, kind) {
  const out = new Set();
  const walk = (m) => {
    const k = keyOf(m);
    if (k === 'all' || k === 'any') m[k].forEach(walk);
    else if (k === 'not') walk(m.not);
    else if (k === kind) {
      if (Array.isArray(m[k]) && (k === 'block' || k === 'class')) m[k].forEach((v) => out.add(v));
      else out.add(k === 'field' ? m.field : m[k]);
    }
  };
  walk(spec);
  return out;
}

/** Does the mask use term `kind`? */
export const maskUses = (spec, kind) => maskTerms(spec, kind).size > 0;

/**
 * Compile a validated mask to `test(x, y, z, col) -> boolean`, where `col` = `{g, slope()}` (the column's frozen ground y and
 * its lazily computed slope). Options:
 *   fields(name)        a decoded field (lib/material.mjs decodeField)
 *   classAt(x, y, z)    the cell's voxel class name ('MISSING' where nothing is frozen); needed by class terms
 *   blockAt(x, y, z)    the cell's frozen block id (no properties); needed by block terms
 *   tagBlocks(tag)      a tag's block ids (lib/blocks.mjs tagBlocks); needed by block terms with #tags
 * A term whose source is missing throws `MASK_NEEDS_VOLUME: ...`.
 */
export function compileMask(spec, { fields = null, classAt = null, blockAt = null, tagBlocks = null } = {}) {
  const build = (m) => {
    const k = keyOf(m);
    switch (k) {
      case 'all': {
        const kids = m.all.map(build), n = kids.length;
        return (x, y, z, c) => { for (let i = 0; i < n; i++) if (!kids[i](x, y, z, c)) return false; return true; };
      }
      case 'any': {
        const kids = m.any.map(build), n = kids.length;
        return (x, y, z, c) => { for (let i = 0; i < n; i++) if (kids[i](x, y, z, c)) return true; return false; };
      }
      case 'not': { const kid = build(m.not); return (x, y, z, c) => !kid(x, y, z, c); }
      case 'height': { const a = m.height[0], b = m.height[1]; return (x, y) => y >= a && y <= b; }
      case 'depth': { const a = m.depth[0], b = m.depth[1]; return (x, y, z, c) => { const d = c.g - y; return d >= a && d <= b; }; }
      case 'slope': { const a = m.slope[0], b = m.slope[1]; return (x, y, z, c) => { const s = c.slope(); return s >= a && s <= b; }; }
      case 'field': {
        if (!fields) throw new Error(`mask: field '${m.field}' needs the IR's fields`);
        const f = fields(m.field), gte = m.gte ?? null, lt = m.lt ?? null;
        return (x, y, z) => { const v = sampleField(f, x, z); return (gte === null || v >= gte) && (lt === null || v < lt); };
      }
      case 'noise': {
        const nf = makeNoise(m.noise), gte = m.gte ?? null, lt = m.lt ?? null;
        return (x, y, z) => { const v = nf(x, y, z); return (gte === null || v >= gte) && (lt === null || v < lt); };
      }
      case 'class': {
        if (!classAt) throw new Error('MASK_NEEDS_VOLUME: a mask\'s class term reads the frozen volumes, and the IR has none (r.needVolume(box) over the masked ops)');
        const want = new Set(m.class);
        return (x, y, z) => want.has(classAt(x, y, z));
      }
      case 'block': {
        if (!blockAt) throw new Error('MASK_NEEDS_VOLUME: a mask\'s block term needs a frozen block volume, which this game does not sample yet (the frozen volumes hold voxel classes: use a class term)');
        const want = new Set();
        for (const b of m.block) {
          if (b.startsWith('#')) {
            const ids = tagBlocks ? tagBlocks(b) : null;
            if (!ids) throw new Error(`mask: unknown block tag '${b}'`);
            for (const id of ids) want.add(id);
          } else want.add(b.includes(':') ? b : `minecraft:${b}`);
        }
        return (x, y, z) => want.has(blockAt(x, y, z));
      }
      default: throw new Error('mask: not a mask');
    }
  };
  return build(spec);
}
