// (6c MP) A small JSON Schema validator for the toolbox specs (kit/schemas/mask.json, pattern.json; docs/CONTRACT.md 6c slice
// MP §1). The mod's api.SpecSchema implements the same subset the same way, and a drift test holds them equal on generated
// specs (kit/test/fixtures/mp/specs.json): $ref (#/$defs/...), oneOf, anyOf, type (one or a list), enum, const, pattern,
// minimum, maximum, exclusiveMinimum, minItems, maxItems, items, required, properties, additionalProperties: false.
// Errors are "path: message" strings; the first one is what a caller reports. Pure; under the realise lint.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/** Validate `v` against `schema` (with `root` holding `$defs`). Returns a list of "path: message" errors (empty: valid). */
export function validateSpec(schema, v, where = '$', root = schema) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const d = root.$defs?.[name];
    if (!d) throw new Error(`schema: no $defs/${name}`);
    return validateSpec(d, v, where, root);
  }
  const t = typeOf(v);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${where}: expected ${types.join(' or ')}, got ${t}`];
  }
  const errs = [];
  if (schema.const !== undefined && v !== schema.const) errs.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${where}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (t === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) errs.push(`${where}: does not match ${schema.pattern}`);
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${where}: under ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${where}: over ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && !(v > schema.exclusiveMinimum)) errs.push(`${where}: must be over ${schema.exclusiveMinimum}`);
  }
  if (t === 'object') {
    for (const k of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(v, k)) errs.push(`${where}: missing ${k}`);
    for (const k of Object.keys(v).sort()) {
      if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, k)) errs.push(...validateSpec(schema.properties[k], v[k], `${where}.${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${where}: unexpected ${k}`);
    }
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) for (let i = 0; i < v.length; i++) errs.push(...validateSpec(schema.items, v[i], `${where}[${i}]`, root));
  }
  // oneOf / anyOf apply together with the keywords beside them
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validateSpec(s, v, where, root));
    const ok = results.filter((r) => r.length === 0).length;
    if (ok > 1) errs.push(`${where}: matches more than one form`);
    else if (ok === 0) {
      // the branch that got furthest (its first error deepest; then the fewest errors; then the first) explains the failure
      let best = 0;
      for (let i = 1; i < results.length; i++) if (depthOf(results[i]) > depthOf(results[best]) || (depthOf(results[i]) === depthOf(results[best]) && results[i].length < results[best].length)) best = i;
      errs.push(...(depthOf(results[best]) > depthOf([`${where}: x`]) ? results[best] : [`${where}: ${schema.oneOfMessage ?? 'matches none of the forms'}`]));
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validateSpec(s, v, where, root).length === 0)) errs.push(`${where}: ${schema.anyOfMessage ?? 'matches none of the alternatives'}`);
  return errs;
}

/** How deep the first error's path goes (a branch that failed below its top level explains the failure best). */
function depthOf(errs) {
  if (!errs.length) return -1;
  const p = errs[0].slice(0, errs[0].indexOf(': '));
  let n = 0;
  for (const c of p) if (c === '.' || c === '[') n++;
  return n;
}
