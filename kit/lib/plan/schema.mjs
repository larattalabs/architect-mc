// (6c P0) The plan validator (docs/CONTRACT.md "Phase 6c slice P0" §1, kit/schemas/plan.json `plan/0`, its x-rules R1-R14).
// The schema subset (lib/specschema.mjs), then dispatch on each part's kind against the capability catalogue, then the x-rules
// the subset can't say: unique ids, references, the dependency graph (acyclic, topological order with ties by id), the
// extension envelope's bounds, ext, ranges, anchors. Pure and deterministic; no survey (the resolver, resolve.mjs, places things).
//
// validatePlan(plan, {anchors}) -> {
//   malformed: null | {code, path, message}      the whole plan (overall MALFORMED; no part answers)
//   parts: [{id, family, index, path, kind, block, required, part, ext, verdict: 'compile'|'unsupported'|'malformed', reason?,
//            refs: [{id, path, as}], lotRefs: [{lot, zone, path}], deps: [ids]}]   (plan order)
//   byId: Map, lotZone: Map lotId -> zoneId, order: [ids] (topological, ties by id), dependents: Map id -> [ids]
// }
import fs from 'node:fs';
import { validateSpec } from '../specschema.mjs';
import { canonicalJson } from '../region/pack.mjs';

export const PLAN_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../schemas/plan.json', import.meta.url), 'utf8'));
export const SCHEMA_VERSION = 'plan/0';
export const CATALOGUE_VERSION = PLAN_SCHEMA['x-catalogue'].catalogueVersion;

/** R6, R7, R9 and §7's caps. */
export const PLAN_LIMITS = Object.freeze({
  planChars: 65536, parts: 128, extPartChars: 4096, extPartDepth: 6, extParts: 32, extChars: 32768, extChars1: 4096, extKey: 200,
});

/** The part families, in plan order (R5's `<family>`). */
export const FAMILIES = Object.freeze([['zones', 'zone'], ['connectors', 'connector'], ['forms', 'form'], ['rules', 'rule']]);
/** Built-in anchors (R14). */
export const BUILTIN_ANCHORS = Object.freeze(['claim_center', 'claim_n', 'claim_e', 'claim_s', 'claim_w']);
/** Zone ports besides its lots (an endpoint `{part: zone, port}`): the plaza's bell and the street's two ends. */
export const ZONE_PORTS = Object.freeze(['bell', 'start', 'end']);

const ENTRIES = new Map(PLAN_SCHEMA['x-catalogue'].entries.map((e) => [e.id, e]));
const DEFS = PLAN_SCHEMA.$defs;

/** The catalogue entry of a block id, or null. */
export function entryOf(blockId) {
  return ENTRIES.get(blockId) ?? null;
}

/** A supported entry's strict def name ("#/$defs/zone.standard" -> "zone.standard"), or null. */
function defName(entry) {
  return entry?.def ? entry.def.replace('#/$defs/', '') : null;
}

/** `{code, path, message}` */
const reason = (code, path, message, extra = {}) => ({ code, path, message, ...extra });

/** The first "path: message" of a validator error list, split. */
function firstError(errs) {
  const e = errs[0];
  const i = e.indexOf(': ');
  return i < 0 ? { path: '$', message: e } : { path: e.slice(0, i), message: e.slice(i + 2) };
}

/** Nesting depth of a JSON value (a scalar is 0, {} or [] is 1). */
function depthOf(v) {
  if (v === null || typeof v !== 'object') return 0;
  let d = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) d = Math.max(d, depthOf(x));
  return d + 1;
}

/** R7: a caller's ext. Returns an error string or null. */
export function extError(ext) {
  if (ext === undefined) return null;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return 'must be an object';
  for (const k of Object.keys(ext)) {
    if (k.length > PLAN_LIMITS.extKey) return `key "${k.slice(0, 40)}..." is over ${PLAN_LIMITS.extKey} characters`;
    if (!/^[a-z0-9_.-]{1,64}:[A-Za-z0-9_.:/-]{1,135}$/.test(k)) return `key "${k}" is not namespace:name`;
  }
  const n = JSON.stringify(ext).length;
  if (n > PLAN_LIMITS.extChars1) return `${n} characters as JSON, at most ${PLAN_LIMITS.extChars1}`;
  return null;
}

/** R7: a caller's ext without Architect's own keys (architect_mc: dropped, as 6c X C19). */
export function callerExt(ext) {
  if (!ext || typeof ext !== 'object') return undefined;
  const out = {};
  for (const k of Object.keys(ext).sort()) if (!k.startsWith('architect_mc:')) out[k] = ext[k];
  return Object.keys(out).length ? out : undefined;
}

/** R8 over every intRange and sketch below `v` (paths relative to `where`). Returns {path, message} or null. */
function rangeError(v, where) {
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const e = rangeError(v[i], `${where}[${i}]`); if (e) return e; }
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    const p = `${where}.${k}`;
    if (['w', 'd', 'gap', 'distance', 'ring', 'height', 'buildingsPer1024'].includes(k) && Array.isArray(x) && x.length === 2 && Number.isInteger(x[0]) && Number.isInteger(x[1]) && x[0] > x[1]) return { path: p, message: `[${x[0]}, ${x[1]}]: min over max (R8)` };
    if (k === 'sketch' && x && typeof x === 'object' && Array.isArray(x.points)) {
      const lo = x.unit === 'q64' ? 0 : -512, hi = x.unit === 'q64' ? 64 : 512;
      for (let i = 0; i < x.points.length; i++) for (const c of x.points[i] ?? []) if (Number.isInteger(c) && (c < lo || c > hi)) return { path: `${p}.points[${i}]`, message: `${c} is outside ${lo}..${hi} for unit ${x.unit} (R8)` };
      if (x.shape === 'polygon' && x.points.length < 3) return { path: `${p}.points`, message: 'a polygon sketch has at least 3 points (R8)' };
      if (x.frame === 'anchor' && !x.anchor) return { path: p, message: 'a sketch with frame anchor names its anchor (R4a)' };
    }
    const e = rangeError(x, p);
    if (e) return e;
  }
  return null;
}

// ------------------------------------------------------------------ the nested blocks (R5): what a supported part names

/** The block id of a locator (`where`), a feature, a target, an endpoint, a sketch. */
export const locatorBlock = (w) => `locator.${Object.keys(w)[0]}`;
export function featureBlock(f) {
  const k = Object.keys(f)[0];
  return `feature.${k}`;
}
export function targetBlock(t) {
  if (t.region !== undefined) return 'feature.region'; // a standing region (one idea, one block id: D1's beside)
  if (t.build !== undefined) return 'feature.build'; // a player's build (6c PT: target {build} answers under feature.build)
  return null; // part, claim: inside the plan
}
export const endpointBlock = (e) => `endpoint.${Object.keys(e)[0]}`;

/** The first reserved block a supported part names (program, layout, locator, feature, target, endpoint, sketch), or null. */
function nestedUnsupported(family, part) {
  const stateOk = (id) => entryOf(id)?.state === 'supported';
  const reserved = (id, path) => {
    const e = entryOf(id);
    const block = e?.aliasOf ?? id;
    return stateOk(id) ? null : { block, path, until: entryOf(block)?.until ?? e?.until ?? null };
  };
  const featureCheck = (f, path) => (f ? reserved(featureBlock(f), path) : null);
  const whereCheck = (w, path) => {
    if (!w) return null;
    const lk = Object.keys(w)[0];
    const r0 = reserved(`locator.${lk}`, path);
    if (r0) return r0;
    const body = w[lk];
    if (lk === 'inside') return body.region !== undefined ? reserved('feature.region', `${path}.inside.region`) : body.build !== undefined ? reserved('feature.build', `${path}.inside.build`) : null;
    if (lk === 'adjacent') return body.to?.region !== undefined ? reserved('feature.region', `${path}.adjacent.to.region`) : body.to?.build !== undefined ? reserved('feature.build', `${path}.adjacent.to.build`) : null;
    if (lk === 'near') return featureCheck(body.feature, `${path}.near.feature`);
    return featureCheck(body.feature, `${path}.${lk}.feature`);
  };
  const sketchCheck = (s, path) => (s && s.outline === true ? reserved('sketch.outline', `${path}.outline`) : null);
  const endpointCheck = (e, path) => {
    if (!e) return null;
    const r0 = reserved(endpointBlock(e), path);
    if (r0) return r0;
    return e.feature ? featureCheck(e.feature, `${path}.feature`) : null;
  };
  if (family === 'zone') {
    const p = part.program;
    if (p.template !== undefined) {
      const r0 = reserved(`program.${p.template}`, '$.program.template');
      if (r0) return r0;
    } else if (p.districts !== undefined) return reserved('program.districts', '$.program.districts');
    else if (p.lots !== undefined) {
      const r0 = reserved('program.lots', '$.program');
      if (r0) return r0;
      const r1 = reserved(`layout.${p.layout ?? 'street'}`, '$.program.layout');
      if (r1) return r1;
    }
    return whereCheck(part.where, '$.where') ?? sketchCheck(part.sketch, '$.sketch');
  }
  if (family === 'connector') {
    for (const [k, e] of [['from', part.from], ...(part.via ?? []).map((v, i) => [`via[${i}]`, v]), ['to', part.to]]) {
      const r0 = endpointCheck(e, `$.${k}`);
      if (r0) return r0;
    }
    for (let i = 0; i < (part.avoid ?? []).length; i++) { const r0 = featureCheck(part.avoid[i], `$.avoid[${i}]`); if (r0) return r0; }
    return null;
  }
  if (family === 'form') return whereCheck(part.where, '$.where') ?? sketchCheck(part.sketch, '$.sketch');
  return null;
}

// ------------------------------------------------------------------ references (R2) and anchors (R14)

/** Every part id, anchor and protected id a part names: {parts: [{id, path, as}], anchors: [{name, path}]} */
function refsOf(family, part) {
  const parts = [], anchors = [];
  const feature = (f, path) => {
    if (!f || typeof f !== 'object') return;
    if (typeof f.part === 'string') parts.push({ id: f.part, path: `${path}.part`, as: 'feature' });
    for (const k of ['water', 'biome_edge', 'ridge']) if (f[k] && typeof f[k].to === 'string') anchors.push({ name: f[k].to, path: `${path}.${k}.to` });
  };
  const target = (t, path) => { if (t && typeof t.part === 'string') parts.push({ id: t.part, path: `${path}.part`, as: 'target' }); };
  const where = (w, path) => {
    if (!w || typeof w !== 'object') return;
    const lk = Object.keys(w)[0], b = w[lk] ?? {};
    if (lk === 'inside') target(b, `${path}.inside`);
    else if (lk === 'adjacent') target(b.to, `${path}.adjacent.to`);
    else if (lk === 'near') {
      if (typeof b.anchor === 'string') anchors.push({ name: b.anchor, path: `${path}.near.anchor` });
      feature(b.feature, `${path}.near.feature`);
    } else if (lk === 'along') {
      feature(b.feature, `${path}.along.feature`);
      if (typeof b.anchor === 'string') anchors.push({ name: b.anchor, path: `${path}.along.anchor` });
    } else if (lk === 'around') feature(b.feature, `${path}.around.feature`);
  };
  const sketch = (s, path) => { if (s && s.frame === 'anchor' && typeof s.anchor === 'string') anchors.push({ name: s.anchor, path: `${path}.anchor` }); };
  const endpoint = (e, path) => {
    if (!e || typeof e !== 'object') return;
    if (typeof e.part === 'string') parts.push({ id: e.part, path: `${path}.part`, as: 'endpoint', port: e.port ?? null });
    if (typeof e.anchor === 'string') anchors.push({ name: e.anchor, path: `${path}.anchor` });
    feature(e.feature, `${path}.feature`);
  };
  where(part.where, '$.where');
  sketch(part.sketch, '$.sketch');
  if (family === 'connector' || part.from || part.to) {
    endpoint(part.from, '$.from');
    (Array.isArray(part.via) ? part.via : []).forEach((v, i) => endpoint(v, `$.via[${i}]`));
    endpoint(part.to, '$.to');
    (Array.isArray(part.avoid) ? part.avoid : []).forEach((f, i) => feature(f, `$.avoid[${i}]`));
  }
  if (family === 'form' && Array.isArray(part.around)) part.around.forEach((id, i) => { if (typeof id === 'string') parts.push({ id, path: `$.around[${i}]`, as: 'around' }); });
  if (family === 'rule' && Array.isArray(part.scope)) part.scope.forEach((id, i) => { if (typeof id === 'string') parts.push({ id, path: `$.scope[${i}]`, as: 'scope' }); });
  return { parts, anchors };
}

/** The lots a zone declares (program.lots, or a template's params.lots), each `{id, path}`. */
export function zoneLots(zone) {
  const p = zone?.program;
  if (!p || typeof p !== 'object') return [];
  const lots = Array.isArray(p.lots) ? p.lots : Array.isArray(p.params?.lots) ? p.params.lots : [];
  const base = Array.isArray(p.lots) ? '$.program.lots' : '$.program.params.lots';
  return lots.map((l, i) => ({ id: l?.id, path: `${base}[${i}].id`, lot: l }));
}

// ------------------------------------------------------------------ kind-level checks of supported parts

/** Template params against the bundled program's declared params (kit's validateValues), or a {path, message}. */
const TEMPLATE_PARAMS = new Map();
export function registerTemplate(name, params, check) {
  TEMPLATE_PARAMS.set(name, { params, check });
}

function kindError(family, kind, part) {
  if (family === 'zone') {
    const p = part.program;
    if (p.template !== undefined) {
      const t = TEMPLATE_PARAMS.get(p.template);
      if (t?.check) {
        const e = t.check(p.params ?? {});
        if (e) return { path: `$.program.params${e.path ? `.${e.path}` : ''}`, message: e.message };
      }
    }
    if (part.size?.w !== undefined) for (const k of ['w', 'd']) {
      const v = part.size[k], lo = Array.isArray(v) ? v[0] : v, hi = Array.isArray(v) ? v[1] : v;
      if (lo < 8 || hi > 1024) return { path: `$.size.${k}`, message: `${JSON.stringify(v)}: a zone side is 8..1024 blocks` };
    }
  }
  if (family === 'form' && (kind === 'ice_spike' || kind === 'rock_spire')) {
    const presets = kind === 'ice_spike' ? ['classic', 'needles', 'stubby'] : ['pinnacle', 'tower', 'hoodoo'];
    if (part.preset !== undefined && !presets.includes(part.preset)) return { path: '$.preset', message: `"${part.preset}" is not a ${kind} preset (${presets.join(', ')})` };
    if (part.height !== undefined) {
      const [lo, hi] = Array.isArray(part.height) ? part.height : [part.height, part.height];
      const max = kind === 'ice_spike' ? 48 : 96;
      if (lo < 8 || hi > max) return { path: '$.height', message: `${JSON.stringify(part.height)}: a ${kind} is 8..${max} high` };
    }
  }
  return null;
}

// ------------------------------------------------------------------ the validator

/**
 * Validate a plan (§1, R1-R14). `anchors`: the names the caller supplies (PlanRequest.anchors); the built-in ones are added.
 * Never throws on a bad plan: the whole plan's failure is `malformed`, a part's is its verdict.
 */
export function validatePlan(plan, { anchors = [] } = {}) {
  const out = { malformed: null, parts: [], byId: new Map(), lotZone: new Map(), order: [], dependents: new Map() };
  const fail = (code, path, message) => { out.malformed = reason(code, path, message); return out; };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('SCHEMA', '$', 'a plan is a JSON object');
  let chars;
  try { chars = canonicalJson(plan).length; } catch (e) { return fail('SCHEMA', '$', e.message); }
  if (chars > PLAN_LIMITS.planChars) return fail('LIMIT', '$', `the plan is ${chars} characters as canonical JSON (at most ${PLAN_LIMITS.planChars}, R9)`);
  // the top level: every member known (an unknown top-level member makes the whole plan malformed), family arrays loosely
  const top = validateSpec(PLAN_SCHEMA, plan);
  // errors inside a family item are the item's (checked below), not the plan's
  const own = top.filter((e) => !/^\$\.(zones|connectors|forms|rules)\[\d+\]/.test(e));
  if (own.length) { const f = firstError(own); return fail('SCHEMA', f.path, f.message); }
  const pe = extError(plan.ext);
  if (pe) return fail('SCHEMA', '$.ext', pe);
  let n = 0;
  for (const [fam] of FAMILIES) n += (plan[fam] ?? []).length;
  if (n > PLAN_LIMITS.parts) return fail('LIMIT', '$', `${n} parts (at most ${PLAN_LIMITS.parts}, R9)`);

  // ---- every item: the loose base, an id, R1
  const seen = new Map();
  for (const [fam, family] of FAMILIES) {
    (plan[fam] ?? []).forEach((part, index) => {
      const at = `$.${fam}[${index}]`;
      if (!part || typeof part !== 'object' || Array.isArray(part)) { fail('SCHEMA', at, 'a part is an object'); return; }
      if (typeof part.id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(part.id)) { fail('SCHEMA', `${at}.id`, `a part needs an id matching ^[a-z][a-z0-9_]{0,47}$ (got ${JSON.stringify(part.id)})`); return; }
      if (seen.has(part.id)) { fail('SCHEMA', `${at}.id`, `id "${part.id}" is used twice (also ${seen.get(part.id)}; R1: ids are unique across the plan)`); return; }
      seen.set(part.id, at);
      const kind = part.kind ?? (family === 'zone' ? 'standard' : undefined);
      out.parts.push({ id: part.id, family, fam, index, path: at, kind, block: typeof kind === 'string' ? `${family}.${kind}` : null, required: part.required === true, part, ext: callerExt(part.ext), verdict: 'compile', reason: null, refs: [], lotRefs: [], deps: [] });
    });
    if (out.malformed) return out;
  }
  for (const p of out.parts) out.byId.set(p.id, p);
  // a path from the part's own `$` (made absolute), or an absolute one (`abs`: a dependencies[] entry)
  const partMalformed = (p, code, path, message, abs = false) => { if (p.verdict !== 'malformed') { p.verdict = 'malformed'; p.reason = reason(code, abs ? path : `${p.path}${path.slice(1)}`, message); } };

  // ---- per part: base, dispatch, strict or envelope (R4, R6), kind checks, nested blocks, R7, R8
  let extParts = 0, extChars = 0;
  for (const p of out.parts) {
    const base = validateSpec(DEFS.partBase, p.part, '$', PLAN_SCHEMA);
    if (base.length) { const f = firstError(base); partMalformed(p, 'SCHEMA', f.path, f.message); continue; }
    if (p.family !== 'zone' && p.kind === undefined) { partMalformed(p, 'SCHEMA', '$', `a ${p.family} has a kind (R4a)`); continue; }
    const ee = extError(p.part.ext);
    if (ee) { partMalformed(p, 'SCHEMA', '$.ext', ee); continue; }
    const entry = entryOf(p.block);
    if (entry?.state === 'supported') {
      const strict = validateSpec(DEFS[defName(entry)], p.part, '$', PLAN_SCHEMA);
      if (strict.length) { const f = firstError(strict); partMalformed(p, 'SCHEMA', f.path, f.message); continue; }
      const re = rangeError(p.part, '$');
      if (re) { partMalformed(p, 'SCHEMA', re.path, re.message); continue; }
      if (p.part.where?.near && (p.part.where.near.anchor === undefined) === (p.part.where.near.feature === undefined)) { partMalformed(p, 'SCHEMA', '$.where.near', 'a near locator names exactly one of anchor or feature (R4a)'); continue; }
      const al = p.part.where?.along;
      if (al && (al.side === 'toward_anchor' || al.side === 'away_from_anchor') && !al.anchor) { partMalformed(p, 'SCHEMA', '$.where.along', `along with side ${al.side} names its anchor (R4a)`); continue; }
      const ke = kindError(p.family, p.kind, p.part);
      if (ke) { partMalformed(p, 'SCHEMA', ke.path, ke.message); continue; }
      const nu = nestedUnsupported(p.family, p.part);
      if (nu) { p.verdict = 'unsupported'; p.block = nu.block; p.reason = reason('UNSUPPORTED', `${p.path}${nu.path.slice(1)}`, `${nu.block} is not supported yet${nu.until ? ` (until ${nu.until})` : ''}`, { block: nu.block, until: nu.until }); }
    } else {
      // reserved, retired, an alias or unknown: the bounded envelope only (R6), then unsupported {block}
      const cj = canonicalJson(p.part);
      extParts++; extChars += cj.length;
      if (cj.length > PLAN_LIMITS.extPartChars) { partMalformed(p, 'EXTENSION_BOUND', '$', `${cj.length} characters as canonical JSON (an extension part is at most ${PLAN_LIMITS.extPartChars}, R6)`); continue; }
      if (depthOf(p.part) > PLAN_LIMITS.extPartDepth) { partMalformed(p, 'EXTENSION_BOUND', '$', `nests ${depthOf(p.part)} deep (an extension part at most ${PLAN_LIMITS.extPartDepth}, R6)`); continue; }
      if (extParts > PLAN_LIMITS.extParts) { partMalformed(p, 'EXTENSION_BOUND', '$', `the plan's ${extParts}th extension part (at most ${PLAN_LIMITS.extParts}, R6)`); continue; }
      if (extChars > PLAN_LIMITS.extChars) { partMalformed(p, 'EXTENSION_BOUND', '$', `the plan's extension parts reach ${extChars} characters (at most ${PLAN_LIMITS.extChars}, R6)`); continue; }
      const env = validateSpec(DEFS.extension, p.part, '$', PLAN_SCHEMA);
      if (env.length) { const f = firstError(env); partMalformed(p, 'SCHEMA', f.path, f.message); continue; }
      const block = entry?.aliasOf ?? p.block;
      const until = entryOf(block)?.until ?? entry?.until ?? null;
      p.verdict = 'unsupported'; p.block = block;
      p.reason = reason('UNSUPPORTED', p.path, `${block} is ${entry ? (entry.state === 'retired' ? `retired${entry.replacedBy ? ` (use ${entry.replacedBy})` : ''}` : 'reserved') : 'not in the catalogue'}${until ? ` (until ${until})` : ''}`, { block, until });
    }
  }

  // ---- lots: unique across the plan (one region's lots; P0 decision 6), their zone
  for (const p of out.parts) {
    if (p.family !== 'zone' || p.verdict === 'malformed') continue;
    for (const l of zoneLots(p.part)) {
      if (typeof l.id !== 'string') continue;
      if (out.byId.has(l.id) && out.byId.get(l.id) !== p) { partMalformed(p, 'SCHEMA', l.path, `lot id "${l.id}" is also a part id (lot ids and part ids share one namespace in a plan)`); break; }
      if (out.lotZone.has(l.id) && out.lotZone.get(l.id) !== p.id) { partMalformed(p, 'SCHEMA', l.path, `lot id "${l.id}" is also a lot of zone ${out.lotZone.get(l.id)} (lot ids are unique across the plan: one region's lots)`); break; }
      if (out.lotZone.has(l.id)) { partMalformed(p, 'SCHEMA', l.path, `lot id "${l.id}" is used twice`); break; }
      out.lotZone.set(l.id, p.id);
    }
  }

  // ---- references (R2: parts, and lots where a place is named) and anchors (R14)
  const anchorSet = new Set([...BUILTIN_ANCHORS, ...anchors]);
  for (const p of out.parts) {
    if (p.verdict === 'malformed') continue;
    const r = refsOf(p.family, p.part);
    for (const a of r.anchors) if (!anchorSet.has(a.name)) { partMalformed(p, 'UNKNOWN_REF', a.path, `anchor "${a.name}" is neither built in (${BUILTIN_ANCHORS.join(', ')}) nor supplied by the request (R14)`); break; }
    if (p.verdict === 'malformed') continue;
    for (const ref of r.parts) {
      if (ref.id === p.id) { partMalformed(p, 'CYCLE', ref.path, `the part names itself (R3)`); break; }
      if (out.byId.has(ref.id)) {
        p.refs.push(ref);
        if (ref.as === 'endpoint' && ref.port !== null) {
          const z = out.byId.get(ref.id);
          if (z.family !== 'zone') { partMalformed(p, 'UNKNOWN_REF', ref.path.replace(/\.part$/, '.port'), `port "${ref.port}": only a zone has ports`); break; }
          const lots = zoneLots(z.part).map((l) => l.id);
          if (!ZONE_PORTS.includes(ref.port) && !lots.includes(ref.port)) { partMalformed(p, 'UNKNOWN_REF', ref.path.replace(/\.part$/, '.port'), `port "${ref.port}" is not a port of zone ${ref.id} (its lots, or ${ZONE_PORTS.join(', ')})`); break; }
        }
      } else if (out.lotZone.has(ref.id) && ref.as !== 'around' && ref.as !== 'scope') {
        // a lot named where a place is expected (Steward's plans name lots as endpoints): the lot, through its zone
        const zone = out.lotZone.get(ref.id);
        if (zone === p.id) { partMalformed(p, 'CYCLE', ref.path, `lot ${ref.id} is the part's own (R3)`); break; }
        p.lotRefs.push({ lot: ref.id, zone, path: ref.path, as: ref.as });
        p.refs.push({ ...ref, id: zone, lot: ref.id });
      } else { partMalformed(p, 'UNKNOWN_REF', ref.path, `"${ref.id}" names no part of this plan (R2)`); break; }
    }
  }

  // ---- the dependency graph: explicit (dependencies[]) and implicit (refs); unknown ids; cycles (R3)
  const deps = new Map(out.parts.map((p) => [p.id, new Set()]));
  for (const p of out.parts) for (const r of p.refs) deps.get(p.id).add(r.id);
  (plan.dependencies ?? []).forEach((d, i) => {
    if (!out.byId.has(d.part)) { if (!out.malformed) fail('UNKNOWN_REF', `$.dependencies[${i}].part`, `"${d.part}" names no part of this plan (R2)`); return; }
    const p = out.byId.get(d.part);
    d.after.forEach((a, k) => {
      if (!out.byId.has(a)) partMalformed(p, 'UNKNOWN_REF', `$.dependencies[${i}].after[${k}]`, `"${a}" names no part of this plan (R2)`, true);
      else if (a === d.part) partMalformed(p, 'CYCLE', `$.dependencies[${i}].after[${k}]`, 'a part after itself (R3)', true);
      else deps.get(d.part).add(a);
    });
  });
  if (out.malformed) return out;
  // strongly connected components (Tarjan, deterministic: ids in sorted order)
  const ids = [...deps.keys()].sort(cmp);
  const index = new Map(), low = new Map(), stack = [], on = new Set();
  let counter = 0;
  const sccs = [];
  const strong = (v) => {
    index.set(v, counter); low.set(v, counter); counter++; stack.push(v); on.add(v);
    for (const w of [...deps.get(v)].sort(cmp)) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      sccs.push(c);
    }
  };
  for (const v of ids) if (!index.has(v)) strong(v);
  for (const c of sccs) if (c.length > 1) {
    const ring = [...c].sort(cmp);
    for (const id of ring) partMalformed(out.byId.get(id), 'CYCLE', '$', `on a dependency cycle: ${ring.join(' -> ')} (R3)`);
  }
  // cycle members drop their edges (they are malformed), so the order below is a DAG
  for (const c of sccs) if (c.length > 1) for (const id of c) for (const w of [...deps.get(id)]) if (c.includes(w)) deps.get(id).delete(w);
  for (const p of out.parts) p.deps = [...deps.get(p.id)].sort(cmp);
  for (const p of out.parts) for (const d of p.deps) { if (!out.dependents.has(d)) out.dependents.set(d, []); out.dependents.get(d).push(p.id); }
  for (const v of out.dependents.values()) v.sort(cmp);
  // topological order, ties by id (code point)
  const indeg = new Map(out.parts.map((p) => [p.id, p.deps.length]));
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    ready.sort(cmp);
    const v = ready.shift();
    out.order.push(v);
    for (const w of out.dependents.get(v) ?? []) { indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) ready.push(w); }
  }
  return out;
}

/** Code-point order of strings (§7: ties by id). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
