// A small JSON Schema validator (the subset structured-output schemas use) and a sample builder
// for the sim backend. No dependency: the SDK already validates the model's answer against the
// schema; this is the sidecar's own second check (docs/CONTRACT.md "Jobs (R2)").
//
// Supported: type (string or list), enum, const, properties, required, additionalProperties
// (false or a schema), items (a schema), minItems, maxItems, uniqueItems, minLength, maxLength,
// pattern, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, anyOf, oneOf, allOf,
// not, $ref to "#/$defs/..." or "#/definitions/...". Unknown keywords (format, title, ...) are
// ignored, so a schema using them is checked on what is supported.

type Schema = Record<string, unknown> | boolean;

const MAX_ERRORS = 10;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && (typeof cur === 'object' || typeof cur === 'boolean') ? (cur as Schema) : undefined;
}

function check(v: unknown, s: Schema, root: Schema, at: string, errors: string[], depth: number): void {
  if (errors.length >= MAX_ERRORS) return;
  if (s === true) return;
  if (s === false) {
    errors.push(`${at || '(root)'}: not allowed`);
    return;
  }
  if (!s || typeof s !== 'object') return;
  if (depth > 64) return;
  const where = at || '(root)';
  if (typeof s.$ref === 'string') {
    const target = resolveRef(root, s.$ref);
    if (target !== undefined) check(v, target, root, at, errors, depth + 1);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(v, t))) {
      errors.push(`${where}: expected ${types.join(' or ')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) errors.push(`${where}: not one of ${JSON.stringify(s.enum).slice(0, 200)}`);
  if ('const' in s && !deepEqual(s.const, v)) errors.push(`${where}: must be ${JSON.stringify(s.const).slice(0, 100)}`);
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && [...v].length < s.minLength) errors.push(`${where}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) errors.push(`${where}: longer than ${s.maxLength}`);
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern, 'u').test(v)) errors.push(`${where}: does not match ${s.pattern}`);
      } catch {
        /* an unsupported pattern is not checked */
      }
    }
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${where}: below ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${where}: above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) errors.push(`${where}: not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) errors.push(`${where}: not below ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) errors.push(`${where}: not a multiple of ${s.multipleOf}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) errors.push(`${where}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) errors.push(`${where}: more than ${s.maxItems} items`);
    if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${where}: items are not unique`);
    if (s.items !== undefined && !Array.isArray(s.items)) v.forEach((x, i) => check(x, s.items as Schema, root, `${at}[${i}]`, errors, depth + 1));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, Schema>;
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!(k in o)) errors.push(`${at ? `${at}.` : ''}${k}: required`);
    for (const [k, val] of Object.entries(o)) {
      const path = at ? `${at}.${k}` : k;
      if (k in props) check(val, props[k]!, root, path, errors, depth + 1);
      else if (s.additionalProperties === false) errors.push(`${path}: not allowed (additionalProperties: false)`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(val, s.additionalProperties as Schema, root, path, errors, depth + 1);
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) check(v, sub, root, at, errors, depth + 1);
  if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => validate(v, sub, root, depth + 1).length === 0)) errors.push(`${where}: matches none of anyOf`);
  if (Array.isArray(s.oneOf) && (s.oneOf as Schema[]).filter((sub) => validate(v, sub, root, depth + 1).length === 0).length !== 1) errors.push(`${where}: must match exactly one of oneOf`);
  if (s.not !== undefined && validate(v, s.not as Schema, root, depth + 1).length === 0) errors.push(`${where}: matches "not"`);
}

function validate(v: unknown, s: Schema, root: Schema, depth: number): string[] {
  const errors: string[] = [];
  check(v, s, root, '', errors, depth);
  return errors;
}

/** The problems with `value` against `schema` (empty: it validates). */
export function validateJson(value: unknown, schema: Record<string, unknown>): string[] {
  return validate(value, schema, schema, 0);
}

/**
 * A value that satisfies `schema` (the sim backend's "structured answer" and tool inputs): every
 * property, the first enum / const / anyOf branch, numbers at their minimum (or 1), strings
 * "sim" padded to minLength, arrays with minItems (at least 1) items.
 */
export function sampleFromSchema(schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 16) return null;
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === 'string') {
    const t = resolveRef(root as Schema, s.$ref);
    if (t !== undefined) return sampleFromSchema(t, root, depth + 1);
  }
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(s[k]) && (s[k] as unknown[]).length) return sampleFromSchema((s[k] as unknown[])[0], root, depth + 1);
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const parts = (s.allOf as unknown[]).map((p) => sampleFromSchema(p, root, depth + 1));
    if (parts.every((p) => p && typeof p === 'object' && !Array.isArray(p))) return Object.assign({}, ...parts);
    return parts[0];
  }
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : s.properties ? ['object'] : s.items ? ['array'] : ['string'];
  const t = types.find((x) => x !== 'null') ?? 'null';
  switch (t) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>;
      for (const [k, sub] of Object.entries(props)) out[k] = sampleFromSchema(sub, root, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(1, typeof s.minItems === 'number' ? s.minItems : 1);
      const max = typeof s.maxItems === 'number' ? s.maxItems : n;
      const items = s.items && typeof s.items === 'object' && !Array.isArray(s.items) ? s.items : {};
      return Array.from({ length: Math.min(n, max) }, () => sampleFromSchema(items, root, depth + 1));
    }
    case 'integer':
    case 'number': {
      let n = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
      if (typeof s.maximum === 'number' && n > s.maximum) n = s.maximum;
      return t === 'integer' ? Math.ceil(n) : n;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default: {
      let str = 'sim';
      if (typeof s.minLength === 'number') while (str.length < s.minLength) str += '-sim';
      if (typeof s.maxLength === 'number') str = str.slice(0, s.maxLength);
      return str;
    }
  }
}
