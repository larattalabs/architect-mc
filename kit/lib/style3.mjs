// (7c SF) Style format 3 (docs/CONTRACT.md "Phase 7c: composition" §3 row 4, S-7c-3; SETTLEMENTS §10.3): format 2 plus
//   connectors   format 2's slots (role names, K1 and after, unchanged) plus `prefer` (a list of connector kinds: connector.auto biases
//                its moves to them) and per-type look parameters beside the slots (LOOK_PARAMS: never roles' blocks, never new roles)
//   forms        per generator (FORM_GENERATORS): species, heightBand [lo, hi], strata (roles of the Style or vanilla blocks)
//   scatter      ground and wall plants (vanilla blocks) and a density
//   settlement   verticality, density, lightEvery, edges, roleShares ({role: [lo, hi]}: the theme-fit bands, tools/scenarios.mjs)
//   references   image blobs [{blob, label?}] (the Style job's references; Noah's at SF's merge, N-7c-4)
//   relatedTo    {id, version}: the settlement Style a zone Style derives from (BibleRequest ext architect_mc:relatedTo). A zone Style
//                shares the settlement Style's core roles (CORE_ROLES: each the same block) and is checked against them (relatedErrors)
// Roles stay where U0 put them (`roles`). Format 2 is unchanged: none of these members is allowed below format 3, and validateBible
// leaves a format 1 or 2 Style byte for byte as before. format3Of() reads ANY Style as format 3 (Steward's change 1): a format 1 or 2
// Style is a settlement Style with no zone Styles, every new member at its default.
import { info } from './blocks.mjs';
import { CORE_ROLES, ROLE_NAME } from './kit.mjs';

export const FORMAT3 = 3;

/** The connector kinds a `prefer` list may name (the catalogue's connector kinds but auto; kit/test/sf-format3.test.mjs holds it equal). */
export const PREFER_KINDS = Object.freeze(['street', 'road', 'path', 'bridge', 'tunnel', 'channel', 'tube', 'drawbridge', 'wall', 'gate', 'ladder', 'stair', 'rail',
  'rope_bridge', 'catwalk', 'rock_stair', 'switchback', 'lift', 'branch_walk', 'span_bridge', 'stairs_around']);
/** The kinds connector.auto can choose among (its span rows: route.mjs 'rope', 'bridge', 'tunnel'): a `prefer` entry's effect. */
export const AUTO_ROWS = Object.freeze({ rope_bridge: 'rope', bridge: 'bridge', tunnel: 'tunnel' });
/** The extra cost (T2's units: a straight walk cell is 10) of an auto span row the Style does not prefer, when it prefers one at all. */
export const PREFER_PENALTY = 600;

/**
 * The look parameters per connector type and their ranges (each tightens the generator's own limits, never widens them):
 *   rope_bridge.maxSpan     8..40   the longest rope span (deck cells; ROPE.spanMin..spanMax): a part's `span.max` when it sets none
 *   rope_bridge.sagRatio    12..64  the sag d = floor(n / sagRatio) (12 = today's; a larger ratio sags less). Carried, not read yet
 *   rope_bridge.light       a role of the Style, or 'none': the rope bridge's lamps (default the light role)
 *   ladder.landingEvery     8..24   rungs between rest landings (CLIMB.restMin..restMax): a ladder part's `rest` when it sets none
 */
export const LOOK_PARAMS = Object.freeze({
  rope_bridge: Object.freeze({ maxSpan: [8, 40], sagRatio: [12, 64], light: 'role' }),
  ladder: Object.freeze({ landingEvery: [8, 24] }),
});
/** Every look parameter name (a per-type member that is not a slot). */
export const LOOK_NAMES = Object.freeze([...new Set(Object.values(LOOK_PARAMS).flatMap((o) => Object.keys(o)))].sort());

/** The form generators a `forms` member may name (kit/lib/forms/*). */
export const FORM_GENERATORS = Object.freeze(['cave', 'coral', 'floatingIsland', 'forest', 'giantMushroom', 'giantTree', 'iceSpike', 'rockSpire']);
const FORM_KEYS = Object.freeze(['species', 'heightBand', 'strata']);
export const SCATTER_DENSITIES = Object.freeze(['sparse', 'moderate', 'rich']);
export const LEVELS = Object.freeze(['low', 'medium', 'high']);
export const EDGES = Object.freeze(['railed', 'open']);
/** The settlement member's defaults (a format 1 or 2 Style reads with these; a format 3 settlement Style gets them filled in). */
export const SETTLEMENT_DEFAULTS = Object.freeze({ verticality: 'medium', density: 'medium', lightEvery: 12, edges: 'railed', roleShares: Object.freeze({}) });
export const MAX_REFERENCES = 8;
const BLOB = /^[A-Za-z0-9_-]{1,64}$/;
const BIBLE_ID = /^[a-z0-9_]+$/; // (bible.mjs BIBLE_ID; not imported: bible.mjs imports this module)

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const isBlock = (s) => {
  if (typeof s !== 'string' || !/^[a-z0-9_:]+$/.test(s)) return false;
  try { info(s); return true; } catch { return false; }
};

/** Is `k` a look parameter of connector type `type`? */
export const isLook = (type, k) => !!LOOK_PARAMS[type]?.[k];

/**
 * The format 3 connector members' errors (prefer, and each type's look parameters); the slots stay connectorsError's. `roles`: the
 * Style's roles (a `light` names one of them). Returns a list of messages.
 */
export function connectors3Errors(c, roles = null) {
  const errors = [];
  if (!isObj(c)) return errors;
  if (c.prefer !== undefined) {
    if (!Array.isArray(c.prefer) || c.prefer.length > PREFER_KINDS.length || !c.prefer.every((k) => typeof k === 'string')) errors.push('connectors.prefer must be a list of connector kinds');
    else {
      const bad = c.prefer.filter((k) => !PREFER_KINDS.includes(k));
      if (bad.length) errors.push(`connectors.prefer: ${bad.join(', ')} ${bad.length > 1 ? 'are not connector kinds' : 'is not a connector kind'} (one of ${PREFER_KINDS.join(', ')})`);
      if (new Set(c.prefer).size !== c.prefer.length) errors.push('connectors.prefer: a kind is listed twice');
    }
  }
  for (const [type, v] of Object.entries(c)) {
    if (type === 'prefer' || !isObj(v)) continue;
    for (const [k, x] of Object.entries(v)) {
      const spec = LOOK_PARAMS[type]?.[k];
      if (!spec) continue;
      if (spec === 'role') {
        if (x === 'none') continue;
        if (typeof x !== 'string' || !ROLE_NAME.test(x)) errors.push(`connectors.${type}.${k} must be a role name or 'none'`);
        else if (roles && !roles[x]) errors.push(`connectors.${type}.${k}: '${x}' is not a role of this Style`);
      } else if (!(isInt(x) && x >= spec[0] && x <= spec[1])) errors.push(`connectors.${type}.${k} must be an integer ${spec[0]}..${spec[1]}`);
    }
  }
  return errors;
}

/** `connectors` split: `{slots, prefer, look}` (slots: format 2's role members; prefer: a list or null; look: {type: {param: v}}). */
export function splitConnectors(c) {
  if (!isObj(c)) return { slots: c, prefer: null, look: {} };
  const slots = {}, look = {};
  for (const [type, v] of Object.entries(c)) {
    if (type === 'prefer') continue;
    if (!isObj(v)) { slots[type] = v; continue; }
    const s = {};
    for (const [k, x] of Object.entries(v)) {
      if (isLook(type, k)) (look[type] ??= {})[k] = x;
      else s[k] = x;
    }
    slots[type] = s;
  }
  return { slots, prefer: Array.isArray(c.prefer) ? [...c.prefer] : null, look };
}

/** Does a connectors member carry anything of format 3 (prefer or a look parameter)? */
export function hasConnectors3(c) {
  if (!isObj(c)) return false;
  const s = splitConnectors(c);
  return s.prefer !== null || Object.keys(s.look).length > 0;
}

function formsErrors(f, roles) {
  const errors = [];
  if (!isObj(f)) return ['forms must be an object { generator: {species?, heightBand?, strata?} }'];
  for (const [g, v] of Object.entries(f)) {
    if (!FORM_GENERATORS.includes(g)) { errors.push(`forms: unknown generator '${g}' (one of ${FORM_GENERATORS.join(', ')})`); continue; }
    if (!isObj(v)) { errors.push(`forms.${g} must be an object { ${FORM_KEYS.join('?, ')}? }`); continue; }
    for (const k of Object.keys(v)) if (!FORM_KEYS.includes(k)) errors.push(`forms.${g}: unknown field '${k}' (one of ${FORM_KEYS.join(', ')})`);
    if (v.species !== undefined && !(typeof v.species === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(v.species))) errors.push(`forms.${g}.species must be a short lower-case name`);
    if (v.heightBand !== undefined && !(Array.isArray(v.heightBand) && v.heightBand.length === 2 && v.heightBand.every((n) => isInt(n) && n >= 1 && n <= 384) && v.heightBand[0] <= v.heightBand[1])) errors.push(`forms.${g}.heightBand must be [lo, hi], integers 1..384, lo <= hi`);
    if (v.strata !== undefined) {
      if (!(Array.isArray(v.strata) && v.strata.length >= 1 && v.strata.length <= 8)) errors.push(`forms.${g}.strata must be a list of 1..8 roles or blocks`);
      else for (const s of v.strata) if (!(typeof s === 'string' && ((roles && roles[s]) || isBlock(s)))) errors.push(`forms.${g}.strata: '${s}' is neither a role of this Style nor a block`);
    }
  }
  return errors;
}

function scatterErrors(s) {
  const errors = [];
  if (!isObj(s)) return ['scatter must be an object { ground?, wall?, density? }'];
  for (const k of Object.keys(s)) if (!['ground', 'wall', 'density'].includes(k)) errors.push(`scatter: unknown field '${k}' (one of ground, wall, density)`);
  for (const k of ['ground', 'wall']) {
    if (s[k] === undefined) continue;
    if (!(Array.isArray(s[k]) && s[k].length <= 12)) { errors.push(`scatter.${k} must be a list of at most 12 blocks`); continue; }
    for (const b of s[k]) if (!isBlock(b)) errors.push(`scatter.${k}: '${b}' is not a block`);
  }
  if (s.density !== undefined && !SCATTER_DENSITIES.includes(s.density)) errors.push(`scatter.density must be one of ${SCATTER_DENSITIES.join(', ')}`);
  return errors;
}

function settlementErrors(s, roles) {
  const errors = [];
  if (!isObj(s)) return ['settlement must be an object { verticality?, density?, lightEvery?, edges?, roleShares? }'];
  for (const k of Object.keys(s)) if (!(k in SETTLEMENT_DEFAULTS)) errors.push(`settlement: unknown field '${k}' (one of ${Object.keys(SETTLEMENT_DEFAULTS).join(', ')})`);
  for (const k of ['verticality', 'density']) if (s[k] !== undefined && !LEVELS.includes(s[k])) errors.push(`settlement.${k} must be one of ${LEVELS.join(', ')}`);
  if (s.lightEvery !== undefined && !(isInt(s.lightEvery) && s.lightEvery >= 4 && s.lightEvery <= 32)) errors.push('settlement.lightEvery must be an integer 4..32');
  if (s.edges !== undefined && !EDGES.includes(s.edges)) errors.push(`settlement.edges must be one of ${EDGES.join(', ')}`);
  if (s.roleShares !== undefined) {
    if (!isObj(s.roleShares)) errors.push('settlement.roleShares must be an object { role: [lo, hi] }');
    else for (const [r, band] of Object.entries(s.roleShares)) {
      if (roles && !roles[r]) errors.push(`settlement.roleShares: '${r}' is not a role of this Style`);
      if (!(Array.isArray(band) && band.length === 2 && band.every((x) => typeof x === 'number' && x >= 0 && x <= 1) && band[0] <= band[1])) errors.push(`settlement.roleShares.${r} must be [lo, hi], shares 0..1, lo <= hi`);
    }
  }
  return errors;
}

function referencesErrors(r) {
  if (!(Array.isArray(r) && r.length <= MAX_REFERENCES)) return [`references must be a list of at most ${MAX_REFERENCES} { blob, label? }`];
  const errors = [];
  r.forEach((x, i) => {
    if (!isObj(x) || !BLOB.test(x.blob ?? '')) errors.push(`references[${i}].blob must be a blob id ([A-Za-z0-9_-]{1,64})`);
    else {
      for (const k of Object.keys(x)) if (k !== 'blob' && k !== 'label') errors.push(`references[${i}]: unknown field '${k}' (blob, label)`);
      if (x.label !== undefined && !(typeof x.label === 'string' && x.label.length >= 1 && x.label.length <= 60)) errors.push(`references[${i}].label must be 1-60 characters`);
    }
  });
  return errors;
}

/** The format 3 members of a bible (forms, scatter, settlement, references, relatedTo; connectors' prefer and look): their errors. */
export function format3Errors(b) {
  const roles = isObj(b.roles) ? b.roles : null;
  const errors = [];
  if (b.connectors !== undefined) errors.push(...connectors3Errors(b.connectors, roles));
  if (b.forms !== undefined) errors.push(...formsErrors(b.forms, roles));
  if (b.scatter !== undefined) errors.push(...scatterErrors(b.scatter));
  if (b.settlement !== undefined) errors.push(...settlementErrors(b.settlement, roles));
  if (b.references !== undefined) errors.push(...referencesErrors(b.references));
  if (b.relatedTo !== undefined && !(isObj(b.relatedTo) && typeof b.relatedTo.id === 'string' && BIBLE_ID.test(b.relatedTo.id) && isInt(b.relatedTo.version) && b.relatedTo.version >= 1 && Object.keys(b.relatedTo).every((k) => k === 'id' || k === 'version'))) {
    errors.push('relatedTo must be { id, version } (the settlement Style this zone Style derives from)');
  }
  if (isObj(b.relatedTo) && b.relatedTo.id === b.id) errors.push('relatedTo: a Style cannot derive from itself');
  return errors;
}

/** The format 3 members named below format 3 (each an error there: format 2 stays as it was). */
export function format3Only(b) {
  const out = ['forms', 'scatter', 'settlement', 'references', 'relatedTo'].filter((k) => b[k] !== undefined);
  if (hasConnectors3(b.connectors)) out.push('connectors.prefer / look parameters');
  return out;
}

/** A settlement member with its defaults filled in (roleShares copied). */
export function settlementOf(s) {
  const g = isObj(s) ? s : {};
  return { ...SETTLEMENT_DEFAULTS, ...g, roleShares: isObj(g.roleShares) ? structuredClone(g.roleShares) : {} };
}

/**
 * ANY Style read as format 3 (Steward's change 1): `{format, scope, settlementStyle, zone, relatedTo, prefer, look, forms, scatter,
 * settlement, references}`. A format 1 or 2 Style is a settlement Style with no zone Styles (relatedTo null, every member its default).
 * A Style is a zone Style when it is format 3 and relates to another; every other Style can be a settlement Style.
 */
export function format3Of(b) {
  const f = b?.format === 3 ? 3 : b?.format === 2 ? 2 : 1;
  const three = f === 3;
  const c = three ? splitConnectors(b.connectors) : { prefer: null, look: {} };
  const relatedTo = three && isObj(b.relatedTo) ? { id: b.relatedTo.id, version: b.relatedTo.version } : null;
  return {
    format: f,
    scope: b?.scope === 'settlement' ? 'settlement' : 'building',
    zone: relatedTo !== null,
    settlementStyle: relatedTo === null,
    relatedTo,
    prefer: c.prefer ?? [],
    look: structuredClone(c.look),
    forms: three && isObj(b.forms) ? structuredClone(b.forms) : {},
    scatter: three && isObj(b.scatter) ? structuredClone(b.scatter) : {},
    settlement: settlementOf(three ? b.settlement : undefined),
    references: three && Array.isArray(b.references) ? structuredClone(b.references) : [],
  };
}

/**
 * A zone Style checked against its settlement Style (S-7c-3): the target must be a settlement Style (any format 1 or 2 Style reads as
 * one; a zone Style is not), and the zone shares its core roles (CORE_ROLES: the same block each, as the kit qualifies them). Returns a
 * list of messages (empty: related).
 */
export function relatedErrors(zone, target) {
  if (!isObj(target)) return ['relatedTo: the settlement Style is not there'];
  const t = format3Of(target);
  if (!t.settlementStyle) return [`relatedTo: ${target.id ?? 'that Style'} is itself a zone Style (it relates to ${t.relatedTo.id}): a zone relates to the settlement Style`];
  const errors = [];
  const zr = isObj(zone?.roles) ? zone.roles : {}, tr = isObj(target.roles) ? target.roles : {};
  const q = (s) => (typeof s === 'string' && !s.includes(':') ? `minecraft:${s}` : s);
  const off = CORE_ROLES.filter((r) => tr[r] !== undefined && q(zr[r]) !== q(tr[r]));
  if (off.length) errors.push(`relatedTo ${target.id ?? ''} v${target.version ?? '?'}: a zone Style shares the settlement Style's core roles; ${off.map((r) => `${r} is ${zr[r] ?? 'missing'}, not ${tr[r]}`).join('; ')}`);
  return errors;
}

/** The core roles a zone Style takes from its settlement Style (the bible job copies them in by code). */
export function sharedCoreRoles(target) {
  const tr = isObj(target?.roles) ? target.roles : {};
  return Object.fromEntries(CORE_ROLES.filter((r) => typeof tr[r] === 'string').map((r) => [r, tr[r]]));
}
