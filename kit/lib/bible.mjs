// Style bibles (docs/CONTRACT.md phase 4b, "Style bible"): the structured bible JSON, its validation, and the built-in
// bibles (the palette presets, as roles, without prose). A bible's roles generalise the kit palette: palette({ bible })
// (lib/kit.mjs) derives every palette field from a role, so a palette-driven design re-skins under any bible.
//
//   bible.json      { id, name, version, format?, prompt, scope, roles, proportions, roofLanguage, silhouette, motifs, tiers,
//                     lighting, avoid, components, restraint? (format 2), createdAt, cost }
//   Format 2 (phase 5a): `format: 2`, `restraint: { heroMotifs (<= 3 of the motifs), accentShareMax (0.04-0.20, 0.12),
//   detailDensity (sparse|moderate|rich, moderate), windowsPerFacadeMin (int, 2) }` (defaults filled in by validateBible),
//   at most 6 motifs, the 5 required components plus at most 3. Format 1 (no `format`) keeps its limits; restraintOf()
//   gives it the default restraint with its first 3 motifs as hero motifs.
//   bible.md        prose for designers
//   components.mjs  the component library (lib/components.mjs)
//   sheet.png       the rendered sample sheet (tools/components.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ROLES, MACRO_ROLES, PALETTES, PALETTE_PRESETS, ROLE_NAME, palette, rolesOfPalette } from './kit.mjs';
import { qualify } from './blocks.mjs';
import { REQUIRED_COMPONENTS, buildFrame } from './components.mjs';
import { checkBlueprint } from './check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Built-in bibles that ship a reference component library (kit/bibles/<name>/components.mjs). */
export const BIBLES_DIR = path.resolve(HERE, '../bibles');

export const BIBLE_ID = /^[a-z0-9_]+$/;
export const SCOPES = ['building', 'settlement'];
const TITLE = (s) => s.replace(/(^|_)([a-z])/g, (_m, sep, c) => `${sep ? ' ' : ''}${c.toUpperCase()}`);

/** Default proportions (a bible may set any of them). */
export const DEFAULT_PROPORTIONS = { storey: 4, roofPitch: 1, overhang: 1, windowRhythm: 3, plinth: 1 };

/** The names of the built-in bibles (the palette presets). */
export const BUILTIN_BIBLES = Object.keys(PALETTE_PRESETS);

/** The reference components of a built-in bible, if it ships one. */
export function builtinComponentsFile(name) {
  const f = path.join(BIBLES_DIR, name, 'components.mjs');
  return fs.existsSync(f) ? f : null;
}

/** A built-in bible: a palette preset as roles, version 1, no prose. */
export function builtinBible(name) {
  if (!PALETTE_PRESETS[name]) throw new Error(`no built-in bible '${name}' (one of ${BUILTIN_BIBLES.join(', ')})`);
  return {
    id: name,
    name: TITLE(name),
    version: 1,
    builtin: true,
    preset: name,
    scope: 'building',
    roles: rolesOfPalette(PALETTES[name]),
    proportions: { ...DEFAULT_PROPORTIONS },
    components: builtinComponentsFile(name) ? [...REQUIRED_COMPONENTS] : [],
  };
}

/** `--bible <arg>`: a bible.json path, or a built-in bible name. Returns the bible object (throws with the reason). */
export function readBibleArg(arg) {
  if (BUILTIN_BIBLES.includes(arg) && !fs.existsSync(arg)) return builtinBible(arg);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(arg, 'utf8'));
  } catch (e) {
    throw new Error(`--bible: '${arg}' is neither a built-in bible (${BUILTIN_BIBLES.join(', ')}) nor a readable bible.json (${e.message})`);
  }
  return j;
}

/** Read a bible.json (a design does: `const BIBLE = loadBible(new URL('../../bible/bible.json', import.meta.url))`). */
export function loadBible(file) {
  const p = file instanceof URL ? fileURLToPath(file) : String(file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---- restraint (phase 5a, bible format 2; docs/CONTRACT.md "Bible-set clutter")
/** Format 2 limits: at most 6 motifs, and the required components plus at most 3. */
export const FORMAT2_MAX_MOTIFS = 6;
export const FORMAT2_MAX_EXTRA_COMPONENTS = 3;
export const MAX_HERO_MOTIFS = 3;
export const DETAIL_DENSITIES = ['sparse', 'moderate', 'rich'];
export const ACCENT_SHARE_RANGE = [0.04, 0.2];
export const RESTRAINT_DEFAULTS = Object.freeze({ accentShareMax: 0.12, detailDensity: 'moderate', windowsPerFacadeMin: 2 });

/**
 * The effective restraint of a bible: a format 2 bible's `restraint` over the defaults; a format 1 bible (or one without
 * `restraint`) gets the defaults with its first 3 motifs as the hero motifs.
 * @returns {{ heroMotifs: string[], accentShareMax: number, detailDensity: 'sparse'|'moderate'|'rich', windowsPerFacadeMin: number }}
 */
export function restraintOf(bible) {
  const motifs = Array.isArray(bible?.motifs) ? bible.motifs.filter((m) => typeof m === 'string') : [];
  const base = { heroMotifs: motifs.slice(0, MAX_HERO_MOTIFS), ...RESTRAINT_DEFAULTS };
  const r = bible?.format === 2 && bible.restraint && typeof bible.restraint === 'object' ? bible.restraint : {};
  const out = { ...base };
  if (Array.isArray(r.heroMotifs)) out.heroMotifs = r.heroMotifs.slice(0, MAX_HERO_MOTIFS);
  if (typeof r.accentShareMax === 'number') out.accentShareMax = r.accentShareMax;
  if (DETAIL_DENSITIES.includes(r.detailDensity)) out.detailDensity = r.detailDensity;
  if (Number.isInteger(r.windowsPerFacadeMin)) out.windowsPerFacadeMin = r.windowsPerFacadeMin;
  return out;
}

const isStrList = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 200);

/**
 * Validate (and normalise) a bible JSON. Roles must be vanilla blocks (ids get their `minecraft:` prefix) and must build a
 * palette (lib/kit.mjs palette({ bible })): a roof with stairs and slab variants, and so on. A settlement-scope bible also
 * needs the macro roles. Returns { ok, errors, bible } (bible: the normalised copy).
 * @param {object} j
 * @param {{scope?: 'building'|'settlement', requireId?: boolean, frame?: boolean}} [opts] frame: false skips the test-house check
 */
export function validateBible(j, opts = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, errors: ['the bible must be a JSON object'], bible: null };
  const b = structuredClone(j);
  if (b.id !== undefined || opts.requireId) {
    if (typeof b.id !== 'string' || !BIBLE_ID.test(b.id)) err(`id '${b.id}' must match [a-z0-9_]+`);
  }
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40) err('name must be a short display name (1-40 characters)');
  if (b.version === undefined) b.version = 1;
  if (!Number.isInteger(b.version) || b.version < 1) err('version must be an integer >= 1');
  const scope = opts.scope ?? b.scope ?? 'building';
  if (!SCOPES.includes(scope)) err(`scope must be one of ${SCOPES.join(', ')}`);
  b.scope = scope;
  // roles
  if (!b.roles || typeof b.roles !== 'object' || Array.isArray(b.roles)) err('roles must be an object { role: "minecraft:block" }');
  else {
    const roles = {};
    for (const [k, v] of Object.entries(b.roles)) {
      if (!ROLE_NAME.test(k)) { err(`roles: name '${k}' must match ${ROLE_NAME}`); continue; }
      if (typeof v !== 'string' || !/^[a-z0-9_:]+$/.test(v)) { err(`roles.${k} must be a block id (got ${JSON.stringify(v)})`); continue; }
      roles[k] = qualify(v);
    }
    b.roles = roles;
    const missing = CORE_ROLES.filter((k) => !roles[k]);
    if (missing.length) err(`roles: missing ${missing.join(', ')} (every bible names ${CORE_ROLES.join(', ')})`);
    if (scope === 'settlement') {
      const m = MACRO_ROLES.filter((k) => !roles[k]);
      if (m.length) err(`roles: a settlement bible also names the macro roles; missing ${m.join(', ')}`);
    }
    if (!errors.length) {
      let p;
      try {
        p = palette({ bible: { id: BIBLE_ID.test(b.id ?? '') ? b.id : 'bible', version: Number.isInteger(b.version) ? b.version : 1, roles } });
      } catch (e) {
        err(e.message.replace(/^palette: /, 'roles: '));
      }
      // the roles must build a sound small house (the component test frame): a light role that gives light, a path to
      // walk on, a full foundation... (the component check could not fix a role)
      if (p && opts.frame !== false) {
        let r;
        try {
          r = checkBlueprint(buildFrame(p));
        } catch (e) {
          r = { ok: false, errors: [e.message] };
        }
        if (!r.ok) err(`roles: a small test house built from these roles fails the checker (fix the roles): ${r.errors.slice(0, 4).join('; ')}`);
      }
    }
  }
  // the rest of the schema (all optional, but typed)
  if (b.proportions !== undefined) {
    if (!b.proportions || typeof b.proportions !== 'object' || Array.isArray(b.proportions)) err('proportions must be an object of numbers');
    else for (const [k, v] of Object.entries(b.proportions)) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 64) err(`proportions.${k} must be a number 0..64`);
  }
  b.proportions = { ...DEFAULT_PROPORTIONS, ...(b.proportions && typeof b.proportions === 'object' ? b.proportions : {}) };
  for (const k of ['prompt', 'roofLanguage', 'silhouette', 'lighting']) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 2000)) err(`${k} must be a string`);
  // format (phase 5a): 1 (absent) or 2; format 2 adds `restraint` and tighter limits on motifs and components
  if (b.format !== undefined && b.format !== 1 && b.format !== 2) err(`format must be 1 or 2 (got ${JSON.stringify(b.format)})`);
  const f2 = b.format === 2;
  const maxMotifs = f2 ? FORMAT2_MAX_MOTIFS : 16;
  if (b.avoid !== undefined && !isStrList(b.avoid, 16)) err('avoid must be a list of at most 16 strings');
  if (b.motifs !== undefined && !isStrList(b.motifs, maxMotifs)) err(`motifs must be a list of at most ${maxMotifs} strings${f2 ? ' (format 2)' : ''}`);
  if (!f2 && b.restraint !== undefined) err('restraint needs format: 2');
  if (f2) {
    const r = b.restraint ?? {};
    if (!r || typeof r !== 'object' || Array.isArray(r)) err('restraint must be an object { heroMotifs, accentShareMax, detailDensity, windowsPerFacadeMin }');
    else {
      const motifs = Array.isArray(b.motifs) ? b.motifs : [];
      const known = new Set(['heroMotifs', 'accentShareMax', 'detailDensity', 'windowsPerFacadeMin']);
      for (const k of Object.keys(r)) if (!known.has(k)) err(`restraint: unknown field '${k}' (one of ${[...known].join(', ')})`);
      if (r.heroMotifs !== undefined) {
        if (!isStrList(r.heroMotifs, MAX_HERO_MOTIFS)) err(`restraint.heroMotifs must be a list of at most ${MAX_HERO_MOTIFS} of the motifs`);
        else for (const m of r.heroMotifs) if (!motifs.includes(m)) err(`restraint.heroMotifs: '${m}' is not one of the motifs`);
      }
      if (r.accentShareMax !== undefined && !(typeof r.accentShareMax === 'number' && r.accentShareMax >= ACCENT_SHARE_RANGE[0] && r.accentShareMax <= ACCENT_SHARE_RANGE[1])) err(`restraint.accentShareMax must be a number ${ACCENT_SHARE_RANGE[0]}-${ACCENT_SHARE_RANGE[1]}`);
      if (r.detailDensity !== undefined && !DETAIL_DENSITIES.includes(r.detailDensity)) err(`restraint.detailDensity must be one of ${DETAIL_DENSITIES.join(', ')}`);
      if (r.windowsPerFacadeMin !== undefined && !(Number.isInteger(r.windowsPerFacadeMin) && r.windowsPerFacadeMin >= 0 && r.windowsPerFacadeMin <= 16)) err('restraint.windowsPerFacadeMin must be an integer 0..16');
      b.restraint = { ...restraintOf({ ...b, restraint: undefined }), ...r };
    }
  }
  if (b.tiers !== undefined) {
    if (!b.tiers || typeof b.tiers !== 'object' || Array.isArray(b.tiers)) err('tiers must be an object { tier: [role, ...] }');
    else for (const [t, list] of Object.entries(b.tiers)) {
      if (!Array.isArray(list) || !list.every((r) => typeof r === 'string')) { err(`tiers.${t} must be a list of role names`); continue; }
      const unknown = list.filter((r) => !b.roles?.[r]);
      if (unknown.length) err(`tiers.${t}: ${unknown.join(', ')} ${unknown.length > 1 ? 'are not roles' : 'is not a role'} of this bible`);
    }
  }
  if (b.components !== undefined && !(Array.isArray(b.components) && b.components.every((c) => typeof c === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(c)))) err('components must be a list of component names ([a-z][a-z0-9_]*)');
  b.components = [...new Set([...REQUIRED_COMPONENTS, ...(Array.isArray(b.components) ? b.components.filter((c) => typeof c === 'string') : [])])];
  if (f2 && b.components.length > REQUIRED_COMPONENTS.length + FORMAT2_MAX_EXTRA_COMPONENTS) err(`components: format 2 allows the ${REQUIRED_COMPONENTS.length} required components plus at most ${FORMAT2_MAX_EXTRA_COMPONENTS} (got ${b.components.length - REQUIRED_COMPONENTS.length} more: ${b.components.filter((c) => !REQUIRED_COMPONENTS.includes(c)).join(', ')})`);
  return { ok: errors.length === 0, errors, bible: b };
}
