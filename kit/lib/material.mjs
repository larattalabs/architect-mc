// Material rules (docs/SETTLEMENTS.md §3.3, kit/REGIONS.md "Material rules"): a `shape` or `columns` op's material may be
// `{rule: {rule: [{when, mat}], default, dither}}`, which picks a block per cell from pointwise quantities. Under the
// realise lint: only + - * / and Math.floor/sqrt/abs/min/max/imul.
import { makeNoise, noiseSpecError } from './noise.mjs';
import { isPattern, patternError } from './pattern.mjs';

export const RULE_CONDITIONS = ['depth', 'slopeLt', 'slopeGte', 'field', 'band', 'noise', 'yAbs', 'facing', 'gte', 'lt', 'age'];
export const FACINGS = ['up', 'down', 'side'];
export const DITHERS = ['ordered4', 'none'];
/** An op whose rule uses `facing` may hold at most this many primitive shapes (each facing test is up to 6 lookups). */
export const FACING_MAX_PRIMITIVES = 32;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (v) => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1];

/**
 * Validate a material rule `{rule: [...], default, dither}` (the value of `material.rule`). `fields`: the IR's field
 * names. Returns the first error or null. An unknown condition is `IR: unknown rule '<key>' (supported: ...)`.
 */
export function ruleError(r, where = 'rule', fields = null) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.rule)) return `${where}: a material rule is {rule: [{when, mat}], default, dither}`;
  if (r.dither !== undefined && !DITHERS.includes(r.dither)) return `${where}.dither must be ${DITHERS.join(' or ')}`;
  // (6c MP) a clause's mat (or the default) may be a pattern: {pattern: spec}
  const matErr = (m, w) => {
    if (m === null || typeof m === 'string') return null;
    if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length === 1 && isPattern(m.pattern)) return patternError(m.pattern, `${w}.pattern`, { fields });
    return `${w} must be a block state, null or {pattern}`;
  };
  const e0 = matErr(r.default ?? null, `${where}.default`);
  if (e0) return e0;
  if (r.rule.length > 64) return `${where}: at most 64 clauses`;
  for (let i = 0; i < r.rule.length; i++) {
    const c = r.rule[i], w = `${where}.rule[${i}]`;
    if (!c || typeof c !== 'object') return `${w} must be {when, mat}`;
    const e = matErr(c.mat ?? null, `${w}.mat`);
    if (e) return e;
    const when = c.when ?? {};
    if (typeof when !== 'object' || Array.isArray(when)) return `${w}.when must be an object`;
    for (const k of Object.keys(when)) if (!RULE_CONDITIONS.includes(k)) return `IR: unknown rule '${k}' (supported: ${RULE_CONDITIONS.slice(0, 8).join(', ')})`;
    if (when.depth !== undefined && !range(when.depth)) return `${w}.when.depth must be [a, b]`;
    if (when.band !== undefined && !range(when.band)) return `${w}.when.band must be [a, b]`;
    if (when.yAbs !== undefined && !range(when.yAbs)) return `${w}.when.yAbs must be [a, b]`;
    if (when.slopeLt !== undefined && !isNum(when.slopeLt)) return `${w}.when.slopeLt must be a number`;
    if (when.slopeGte !== undefined && !isNum(when.slopeGte)) return `${w}.when.slopeGte must be a number`;
    if (when.facing !== undefined && !FACINGS.includes(when.facing)) return `${w}.when.facing must be ${FACINGS.join(', ')}`;
    if (when.field !== undefined && when.noise !== undefined) return `${w}: one clause takes field or noise, not both`;
    if ((when.gte !== undefined || when.lt !== undefined) && when.field === undefined && when.noise === undefined) return `${w}: gte/lt need field or noise`;
    if (when.gte !== undefined && !isNum(when.gte)) return `${w}.when.gte must be a number`;
    if (when.lt !== undefined && !isNum(when.lt)) return `${w}.when.lt must be a number`;
    if (when.age !== undefined && (!isNum(when.age) || when.noise === undefined)) return `${w}.when.age is a number with noise`;
    if (when.field !== undefined && (typeof when.field !== 'string' || (fields && !fields.has(when.field)))) return `${w}.when.field '${when.field}' is not one of the IR's fields`;
    if (when.noise !== undefined) { const ne = noiseSpecError(when.noise); if (ne) return `${w}.when.noise: ${ne}`; }
  }
  return null;
}

/** Does a rule use `facing` (then its op is limited to FACING_MAX_PRIMITIVES primitive shapes)? */
export const ruleUsesFacing = (r) => r.rule.some((c) => c.when?.facing !== undefined);

/**
 * Compile a validated rule. `mat(state)` maps a block state (or null) to the evaluator's material index; `fields(name)`
 * gives a decoded field `{type, minX, minZ, width, depth, res, values}`; `bands` is the op shape's strata spec (or null).
 * Returns `pick(x, y, z, sd, env) -> material index`, where `env` = `{up(), down(), side(), slope(), g()}` (lazy: called only
 * by the clauses that need them; `g()` is the column's frozen ground, for a pattern mat). `paint(m, where)` compiles a
 * `{pattern}` mat (6c MP).
 */
export function compileRule(r, { mat, fields, bands, paint = null }) {
  const dither = r.dither === 'ordered4';
  // (6c MP) a pattern mat compiles (through `paint(m, where)`) to pick(x, y, z, g); a plain one to its index
  const M = (m, w) => (m && typeof m === 'object' ? paint(m, w) : mat(m ?? null));
  const def0 = M(r.default ?? null, 'rule default');
  const def = typeof def0 === 'number' ? def0 : -1;
  const strataNoise = bands?.noise ? makeNoise(bands.noise) : null;
  const sEvery = bands?.every ?? 1, sOff = bands?.offset ?? 0, sAmp = bands?.amp ?? 0;
  const clauses = r.rule.map((c) => {
    const w = c.when ?? {};
    return {
      m: M(c.mat ?? null, 'rule clause'),
      depth: w.depth ?? null, band: w.band ?? null, yAbs: w.yAbs ?? null,
      slopeLt: w.slopeLt ?? null, slopeGte: w.slopeGte ?? null, facing: w.facing ?? null,
      field: w.field !== undefined ? fields(w.field) : null,
      noise: w.noise !== undefined ? makeNoise(w.noise) : null, age: w.age ?? 0,
      gte: w.gte ?? null, lt: w.lt ?? null,
    };
  });
  const n = clauses.length;
  return (x, y, z, sd, env) => {
    const dz = dither ? BAYER4[(x & 3) + 4 * (z & 3)] / 16 - 0.5 : 0;
    let band = null;
    for (let i = 0; i < n; i++) {
      const c = clauses[i];
      if (c.yAbs !== null && (y < c.yAbs[0] || y > c.yAbs[1])) continue;
      if (c.depth !== null) {
        const d0 = Math.floor(-sd + dz), d = d0 < 0 ? 0 : d0; // an inside cell is never shallower than its skin
        if (d < c.depth[0] || d > c.depth[1]) continue;
      }
      if (c.band !== null) {
        if (band === null) band = Math.floor((y + sOff + (strataNoise ? sAmp * strataNoise(x, y, z) : 0)) / sEvery);
        if (band < c.band[0] || band > c.band[1]) continue;
      }
      if (c.field !== null) {
        const v = sampleField(c.field, x, z) + dz * 16;
        if (c.gte !== null && v < c.gte) continue;
        if (c.lt !== null && v >= c.lt) continue;
      }
      if (c.noise !== null) {
        const v = c.noise(x, y, z) + c.age + dz * 0.25;
        if (c.gte !== null && v < c.gte) continue;
        if (c.lt !== null && v >= c.lt) continue;
      }
      if (c.slopeLt !== null || c.slopeGte !== null) {
        const s = env.slope();
        if (c.slopeLt !== null && !(s < c.slopeLt)) continue;
        if (c.slopeGte !== null && !(s >= c.slopeGte)) continue;
      }
      if (c.facing !== null) {
        const ok = c.facing === 'up' ? env.up() : c.facing === 'down' ? env.down() : env.side();
        if (!ok) continue;
      }
      return typeof c.m === 'number' ? c.m : c.m(x, y, z, env.g());
    }
    return def >= 0 ? def : def0(x, y, z, env.g());
  };
}

/** A field's sample at (x, z): nearest at res 1, the covering sample at res 4; 0 outside. */
export function sampleField(f, x, z) {
  const i = Math.floor((x - f.minX) / f.res), j = Math.floor((z - f.minZ) / f.res);
  if (i < 0 || j < 0 || i >= f.width || j >= f.depth) return 0;
  return f.values[i + j * f.width];
}

/** Decode a field blob (`u8` or `i16` LE, row-major) with its `fields` entry. */
export function decodeField(entry, bytes) {
  const n = entry.width * entry.depth;
  const need = entry.type === 'u8' ? n : n * 2;
  if (bytes.length < need) throw new Error(`field: ${bytes.length} bytes, ${entry.type} ${entry.width}x${entry.depth} needs ${need}`);
  let values;
  if (entry.type === 'u8') values = Uint8Array.from(bytes.subarray(0, n));
  else {
    values = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = bytes[2 * i] | (bytes[2 * i + 1] << 8); values[i] = v >= 32768 ? v - 65536 : v; }
  }
  return { type: entry.type, minX: entry.minX, minZ: entry.minZ, width: entry.width, depth: entry.depth, res: entry.res, values };
}
