// Design parameters (docs/CONTRACT.md "Parametric designs"). A design declares them as
//   export const params = { floors: { type: 'int', min: 1, max: 3, default: 1, label: 'Floors' },
//                           porch: { type: 'bool', default: true, label: 'Porch' },
//                           roof: { type: 'enum', options: ['gable', 'hip'], default: 'gable', label: 'Roof' } };
// and its default export takes `{ palette, ...values }`. build.mjs validates the values against the declaration.

const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const OPTION = /^[a-z0-9_]{1,32}$/;

/** Throws when a design's `params` export is malformed (the design is broken, not the request). */
export function validateParams(params) {
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
    } else if (p.type === 'enum') {
      if (!Array.isArray(p.options) || p.options.length < 2 || !p.options.every((o) => typeof o === 'string' && OPTION.test(o))) throw new Error(`${where}.options must be 2+ strings matching ${OPTION}`);
      if (new Set(p.options).size !== p.options.length) throw new Error(`${where}.options has duplicates`);
      if (!p.options.includes(p.default)) throw new Error(`${where}: default '${p.default}' is not one of its options`);
    } else throw new Error(`${where}.type must be int, bool or enum (got '${p.type}')`);
  }
}

/** The defaults of every param. */
export function defaultValues(params = {}) {
  return Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.default]));
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
    out[k] = v;
  }
  return out;
}

/** Every combination of the domain corners (int min/max, both bools, every enum option): the sweep the tests run. */
export function cornerValues(params = {}) {
  let combos = [{}];
  for (const [k, p] of Object.entries(params)) {
    const vals = p.type === 'int' ? [...new Set([p.min, p.max])] : p.type === 'bool' ? [false, true] : [...p.options];
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  return combos;
}
