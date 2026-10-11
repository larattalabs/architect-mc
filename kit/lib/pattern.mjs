// (6c MP) Patterns (docs/CONTRACT.md 6c slice MP §3): a per-cell material wherever a single one is accepted (an op's material,
// a columns op's materials, a material rule's clause or default; a bible role through `patterns`):
//   {mix: [{w, mat}, ...], seedLabel}       a per-cell choice by an integer hash of (seed, label, x, y, z) over the weights;
//                                           the shares converge to the weights
//   {gradient: {by, stops: [{at, mat}]}, dither}   the stop interval by `y`, `depth` (below the frozen ground) or {field};
//                                           blended across each interval with the ordered 4x4 Bayer dither (no hard lines)
// In an IR every mat is a block state or null (air); a program or a bible names roles, resolved at plan time. The spec is
// checked by kit/schemas/pattern.json (lib/specschema.mjs) plus the rules below; the mod's api.Pattern runs the same checks.
// Under the realise lint.
import fs from 'node:fs';
import { validateSpec } from './specschema.mjs';
import { fnv64, hash3, mix64 } from './noise.mjs';
import { sampleField } from './material.mjs';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../schemas/pattern.json', import.meta.url), 'utf8'));
export const PATTERN_SCHEMA = SCHEMA;
export const PATTERN_KINDS = Object.freeze(['mix', 'gradient']);
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Is `v` a pattern spec (an object with `mix` or `gradient`)? */
export const isPattern = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && (v.mix !== undefined || v.gradient !== undefined);

/** The rules the schema can't say (x-rules): a gradient's stops strictly increasing. Returns the first error or null. */
export function patternRuleError(spec, where = 'pattern') {
  if (spec.gradient) {
    const s = spec.gradient.stops;
    for (let i = 1; i < s.length; i++) if (!(s[i].at > s[i - 1].at)) return `${where}.gradient.stops[${i}].at must be over the stop before it`;
  }
  return null;
}

/** Validate a pattern spec: the schema, then the rules; `fields` (a Set) also checks a field gradient's name. */
export function patternError(spec, where = 'pattern', { fields = null } = {}) {
  const errs = validateSpec(SCHEMA, spec, where);
  if (errs.length) return errs[0];
  const e = patternRuleError(spec, where);
  if (e) return e;
  const f = spec.gradient?.by?.field;
  if (fields && f !== undefined && !fields.has(f)) return `${where}: field '${f}' is not one of the IR's fields`;
  return null;
}

/** Every mat a pattern names (in order). */
export const patternMats = (spec) => (spec.mix ? spec.mix.map((e) => e.mat) : spec.gradient.stops.map((s) => s.mat));

/** A pattern with every mat mapped by `f` (roles to block states at plan time). */
export function mapPatternMats(spec, f) {
  if (spec.mix) return { ...spec, mix: spec.mix.map((e) => ({ w: e.w, mat: f(e.mat) })) };
  return { ...spec, gradient: { ...spec.gradient, stops: spec.gradient.stops.map((s) => ({ at: s.at, mat: f(s.mat) })) } };
}

/** The mix's 32-bit keys for a seed (the IR's u64 decimal string) and label. */
export function mixKey(seed, label) {
  const h = fnv64(String(seed), 'pattern', label);
  return mix64(h.hi, h.lo);
}

/** The mix's per-cell draw in [0, total): the cell's hash scaled to the weights (multiply-shift: exact, no modulo bias). */
export function mixDraw(k, total, x, y, z) {
  return Math.floor((hash3(k[0], k[1], x, y, z) * total) / 4294967296);
}

/**
 * Compile a validated pattern to `pick(x, y, z, g) -> material index`, where `g` is the column's frozen ground y. Options:
 * `mat(state)` maps a block state (or null) to the evaluator's material index; `fields(name)` a decoded field; `seed` the IR's
 * seed (u64 decimal string).
 */
export function compilePattern(spec, { mat, fields = null, seed = '0' }) {
  if (spec.mix) {
    const ms = spec.mix.map((e) => mat(e.mat ?? null));
    const cum = [];
    let total = 0;
    for (const e of spec.mix) { total += e.w; cum.push(total); }
    const n = ms.length;
    const k = mixKey(seed, spec.seedLabel ?? 'mix');
    if (n === 1) return () => ms[0];
    return (x, y, z) => {
      const d = mixDraw(k, total, x, y, z);
      for (let i = 0; i < n; i++) if (d < cum[i]) return ms[i];
      return ms[n - 1];
    };
  }
  const g = spec.gradient;
  const at = g.stops.map((s) => s.at), ms = g.stops.map((s) => mat(s.mat ?? null));
  const n = at.length;
  const dither = (spec.dither ?? 'ordered4') === 'ordered4';
  let val;
  if (g.by === 'y') val = (x, y) => y;
  else if (g.by === 'depth') val = (x, y, z, gy) => gy - y;
  else {
    if (!fields) throw new Error(`pattern: field '${g.by.field}' needs the IR's fields`);
    const f = fields(g.by.field);
    val = (x, y, z) => sampleField(f, x, z);
  }
  return (x, y, z, gy) => {
    const v = val(x, y, z, gy);
    if (v <= at[0]) return ms[0];
    if (v >= at[n - 1]) return ms[n - 1];
    let i = 0;
    while (v >= at[i + 1]) i++;
    const t = (v - at[i]) / (at[i + 1] - at[i]);
    const th = dither ? (BAYER4[(x & 3) + 4 * (z & 3)] + 0.5) / 16 : 0.5;
    return t >= th ? ms[i + 1] : ms[i];
  };
}
