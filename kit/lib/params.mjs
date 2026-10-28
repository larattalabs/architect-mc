// Design parameters (docs/CONTRACT.md "Parametric designs"). A design declares them as
//   export const params = { floors: { type: 'int', min: 1, max: 3, default: 1, label: 'Floors' },
//                           porch: { type: 'bool', default: true, label: 'Porch' },
//                           roof: { type: 'enum', options: ['gable', 'hip'], default: 'gable', label: 'Roof' } };
// and its default export takes `{ palette, ...values }`. build.mjs validates the values against the declaration.

const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const OPTION = /^[a-z0-9_]{1,32}$/;

/** (6c V) At most this many lots in a `lots` param (a region program's lot list). */
export const LOTS_MAX = 40;
const LOT_ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
const LOT_PLACEMENTS = ['central', 'edge', 'near_water', 'high_ground'];
export const LOT_VILLAGER = ['dwelling', 'job', 'trading_hall', 'farm', 'none'];
/** (6c X, C19) A lot's `ext`: at most this many characters as compact JSON (the mod's FIELD_LIMIT measures the same), keys `namespace:name`. */
export const LOT_EXT_MAX = 4096;
const EXT_KEY_RE = /^[a-z0-9_.-]+:\S+$/;
const EXT_KEY_MAX = 200;

/**
 * (6c V) Validate a `lots` value: at most LOTS_MAX lots, each `{id, type, role?, size: [alongStreet, deep], landmark?, placement?,
 * villager?, brief?, ext?}` (Steward's VillageLayout.LotSpec plus `villager`; 6c X adds `ext`: an object of `namespace:name` keys, at most
 * LOT_EXT_MAX characters as JSON, copied onto the lot's LotSpec.ext and by the realise onto the lot's site; a key under `architect_mc:`
 * is Architect's, so a caller's value for it is dropped). Returns the normalised list (role defaults to type; villager, when absent,
 * inferred from type; `ext` only when the caller's has a key left). Throws with the path on a bad value.
 */
export function validateLots(v, where = 'lots') {
  if (!Array.isArray(v)) throw new Error(`${where} must be an array of lots`);
  if (v.length > LOTS_MAX) throw new Error(`${where}: ${v.length} lots (at most ${LOTS_MAX})`);
  const seen = new Set();
  return v.map((l, i) => {
    const w = `${where}[${i}]`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error(`${w} must be an object`);
    // (6c H, S-H-2) farmPond is the compiler's (a farm lot's pond, read from the plan part): accepted here, never in the layout's lot;
    // ((6c IRR) irrigate likewise: the compiler's, a farm lot's sources)
    for (const k of Object.keys(l)) if (!['id', 'type', 'role', 'size', 'landmark', 'placement', 'villager', 'brief', 'ext', 'farmPond', 'irrigate', 'refill'].includes(k)) throw new Error(`${w}: unknown member '${k}'`);
    if (l.farmPond !== undefined && typeof l.farmPond !== 'boolean') throw new Error(`${w}.farmPond must be true or false`);
    if (l.irrigate !== undefined && typeof l.irrigate !== 'boolean') throw new Error(`${w}.irrigate must be true or false`);
    if (typeof l.id !== 'string' || !LOT_ID_RE.test(l.id)) throw new Error(`${w}.id must match ${LOT_ID_RE}`);
    if (seen.has(l.id)) throw new Error(`${w}.id '${l.id}' is used twice`);
    seen.add(l.id);
    if (typeof l.type !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(l.type)) throw new Error(`${w}.type must match [a-z][a-z0-9_]{0,31}`);
    if (l.role !== undefined && l.role !== null && (typeof l.role !== 'string' || l.role.length > 60)) throw new Error(`${w}.role must be a string (<= 60)`);
    if (!Array.isArray(l.size) || l.size.length !== 2 || !l.size.every((n) => Number.isInteger(n) && n >= 5 && n <= 96)) throw new Error(`${w}.size must be [alongStreet, deep], integers 5..96`);
    if (l.landmark !== undefined && typeof l.landmark !== 'boolean') throw new Error(`${w}.landmark must be true or false`);
    if (l.placement !== undefined && l.placement !== null && !LOT_PLACEMENTS.includes(l.placement)) throw new Error(`${w}.placement must be one of ${LOT_PLACEMENTS.join(', ')} or null`);
    if (l.villager !== undefined && l.villager !== null && !LOT_VILLAGER.includes(l.villager)) throw new Error(`${w}.villager must be one of ${LOT_VILLAGER.join(', ')}`);
    if (l.brief !== undefined && l.brief !== null && (typeof l.brief !== 'string' || l.brief.length > 500)) throw new Error(`${w}.brief must be a string (<= 500)`);
    const ext = l.ext === undefined || l.ext === null ? undefined : validateLotExt(l.ext, `${w}.ext`);
    return { id: l.id, type: l.type, role: l.role ?? l.type, size: [...l.size], landmark: !!l.landmark, placement: l.placement ?? null,
      villager: l.villager ?? inferVillager(l.type), ...(l.brief ? { brief: l.brief } : {}), ...(ext && Object.keys(ext).length ? { ext } : {}) };
  });
}

/** (6c X, C19) A lot's caller ext: a plain object, at most LOT_EXT_MAX characters as JSON, `namespace:name` keys (<= 200 characters); the
 * `architect_mc:` namespace is Architect's and a caller's keys under it are dropped. Returns a copy. */
export function validateLotExt(e, where = 'ext') {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where} must be an object`);
  const n = JSON.stringify(e).length;
  if (n > LOT_EXT_MAX) throw new Error(`${where}: ${n} characters as JSON, at most ${LOT_EXT_MAX}`);
  const out = {};
  for (const k of Object.keys(e)) {
    if (k.length > EXT_KEY_MAX || !EXT_KEY_RE.test(k)) throw new Error(`${where}: key '${k.length > 40 ? `${k.slice(0, 40)}...` : k}' is not namespace:name (at most ${EXT_KEY_MAX} characters)`);
    if (k.startsWith('architect_mc:')) continue;
    out[k] = JSON.parse(JSON.stringify(e[k]));
  }
  return out;
}

/** (6c B) The longest `json` param value (characters of its JSON). */
export const JSON_MAX = 8192;

/** (6c V) The villager use a lot's type implies when the caller sends none (S-V-1: the caller's own value wins). */
export function inferVillager(type) {
  const t = String(type);
  if (/(^|_)(trading|market|hall_of_trade|trade)/.test(t)) return 'trading_hall';
  if (/(farm|field|barn|orchard|pasture|garden)/.test(t)) return 'farm';
  if (/(cottage|house|home|cabin|hut|dwelling|lodge)/.test(t)) return 'dwelling';
  if (/(smith|forge|bakery|baker|mill|workshop|shop|mason|tannery|brewery|fletcher|library|chapel|church|temple|inn|tavern|stable|cartographer|fisher|butcher|weaver|smithy)/.test(t)) return 'job';
  return 'none';
}

/** Throws when a design's `params` export is malformed (the design is broken, not the request). `region`: a region program's
 * params, which may also declare the `lots` type (6c V; refused in design params). */
export function validateParams(params, { region = false } = {}) {
  if (params === undefined) return;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object { name: { type, ... } }');
  for (const [name, p] of Object.entries(params)) {
    const where = `params.${name}`;
    if (!NAME.test(name)) throw new Error(`${where}: a param name must match ${NAME}`);
    if (name === 'palette') throw new Error(`${where}: 'palette' is reserved`);
    if (!p || typeof p !== 'object') throw new Error(`${where} must be an object`);
    if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > 40)) throw new Error(`${where}.label must be a string (<= 40)`);
    if (p.type === 'int') {
      for (const k of ['min', 'max', 'default']) if (!Number.isInteger(p[k])) throw new Error(`${where}.${k} must be an integer`);
      if (p.min > p.max) throw new Error(`${where}: min > max`);
      if (p.default < p.min || p.default > p.max) throw new Error(`${where}: default ${p.default} is outside ${p.min}..${p.max}`);
    } else if (p.type === 'bool') {
      if (typeof p.default !== 'boolean') throw new Error(`${where}.default must be true or false`);
      if (p.omitDefault !== undefined && typeof p.omitDefault !== 'boolean') throw new Error(`${where}.omitDefault must be true or false`);
    } else if (p.type === 'enum') {
      if (!Array.isArray(p.options) || p.options.length < 2 || !p.options.every((o) => typeof o === 'string' && OPTION.test(o))) throw new Error(`${where}.options must be 2+ strings matching ${OPTION}`);
      if (new Set(p.options).size !== p.options.length) throw new Error(`${where}.options has duplicates`);
      if (!p.options.includes(p.default)) throw new Error(`${where}: default '${p.default}' is not one of its options`);
      if (p.omitDefault !== undefined && typeof p.omitDefault !== 'boolean') throw new Error(`${where}.omitDefault must be true or false`);
    } else if (p.type === 'lots') {
      if (!region) throw new Error(`${where}: the 'lots' type is allowed in region programs only`);
      validateLots(p.default ?? [], `${where}.default`);
    } else if (p.type === 'json') {
      // (6c B) a JSON object or null (a brush's mask and pattern specs: the program validates them), region programs only
      if (!region) throw new Error(`${where}: the 'json' type is allowed in region programs only`);
      if (p.default !== null) throw new Error(`${where}.default must be null`);
      // (6c P0) `maxChars`: a longer limit than JSON_MAX (plan_v0's plan, at most 64 KB); absent: JSON_MAX
      if (p.maxChars !== undefined && !(Number.isInteger(p.maxChars) && p.maxChars >= 1 && p.maxChars <= 262144)) throw new Error(`${where}.maxChars must be 1..262144`);
    } else throw new Error(`${where}.type must be int, bool or enum${region ? ' (or lots, json)' : ''} (got '${p.type}')`);
  }
}

/** The defaults of every param. */
export function defaultValues(params = {}) {
  return Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.type === 'lots' ? validateLots(p.default ?? [], `params.${k}`) : p.default]));
}

/**
 * The full values for a build: the defaults with `given` over them. Throws (bad usage) on an unknown name or a value
 * outside its domain.
 */
export function resolveValues(params = {}, given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error('values must be a JSON object { name: value }');
  const out = defaultValues(params);
  for (const [k, v] of Object.entries(given)) {
    const p = params[k];
    if (!p) throw new Error(`values: unknown param '${k}'${Object.keys(params).length ? ` (this design has: ${Object.keys(params).join(', ')})` : ' (this design has no params)'}`);
    if (p.type === 'int' && !(Number.isInteger(v) && v >= p.min && v <= p.max)) throw new Error(`values: ${k} must be an integer ${p.min}..${p.max} (got ${JSON.stringify(v)})`);
    if (p.type === 'bool' && typeof v !== 'boolean') throw new Error(`values: ${k} must be true or false (got ${JSON.stringify(v)})`);
    if (p.type === 'enum' && !p.options.includes(v)) throw new Error(`values: ${k} must be one of ${p.options.join(', ')} (got ${JSON.stringify(v)})`);
    if (p.type === 'json' && v !== null && (typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > (p.maxChars ?? JSON_MAX))) throw new Error(`values: ${k} must be a JSON object of at most ${p.maxChars ?? JSON_MAX} characters, or null`);
    out[k] = p.type === 'lots' ? validateLots(v, `values: ${k}`) : p.type === 'json' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  }
  // (6c MP) a bool param with `omitDefault: true` (an opt-in demo switch) is left out at its default, so a program that gains
  // one keeps its default seed, IR and tiles
  // (C37) an enum param may do the same (flat_village's orientation: 'auto' is left out, so no seed or IR changes)
  for (const [k, p] of Object.entries(params)) if ((p.type === 'bool' || p.type === 'enum') && p.omitDefault === true && out[k] === p.default) delete out[k];
  return out;
}

/** Every combination of the domain corners (int min/max, both bools, every enum option): the sweep the tests run. */
export function cornerValues(params = {}) {
  let combos = [{}];
  for (const [k, p] of Object.entries(params)) {
    if (p.type === 'lots' || p.type === 'json') continue; // (6c V) a lot list is the caller's data, never a variant axis (6c B: json too)
    const vals = p.type === 'int' ? [...new Set([p.min, p.max])] : p.type === 'bool' ? [false, true] : [...p.options];
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  return combos;
}
