// Slice 0b (docs/CONTRACT.md "Phase 6c slice 0b" §2.2): the deterministic variation of a copy in a design group. No
// Claude: a recipe is picked from three levers, in a seeded order, by building the candidates in memory.
//
//   1. palette shift inside the bible: the copy builds with a derived bible, the group's bible with ONE shift:
//        - swap `wall` and `wall_alt`
//        - set the roof to another member of its stone family (stoneFamilyOf; one with stairs and a slab)
//        - swap `trim` and `frame`
//        - set `accent` to another role's block
//      (the contract's order; the roof shift and the trim/frame swap are both offered, the roof first, because a design
//      may not use the roof's stone at all). Shifts the kit cannot build a palette from are left out.
//   2. one declared param changes: an int -1 or +1 within its bounds, a bool flips, an enum takes its next option (skipped
//      when the design has no params)
//   3. mirror left-right across the front axis (lib/mirror.mjs): the first copy of an archetype, and every second one
//      after it (ordinal 1, 3, ...)
//
// A lever COUNTS only when it changes the build: a shift of roles the design never uses, or a mirror of a symmetric
// design, changes no cell. chooseRecipe builds every single-lever variant once to know which levers are effective, then
// walks the (shift, param) pairs in the seeded order (rotated by the ordinal, so siblings start apart) and takes the
// first whose build fits `max` and the (mirrored) massing, and differs from the archetype and from every earlier sibling
// in at least 2 effective levers and at least 10% of the cells (lib/diff.mjs's count, in design coordinates).
// `attempt` skips that many passing candidates (a retry after the sidecar's check refused one). The recipe carries the
// derived roles and the values, so it rebuilds byte-identically from its source version without this module (§2.4).
import crypto from 'node:crypto';
import { STONE_FAMILIES, paletteFromBible, stoneFamilyOf, variant } from './kit.mjs';
import { checkConformance } from './massing.mjs';
import { mirrorAxisOf, mirrorSidecar } from './mirror.mjs';

/** The variation bar (docs/CONTRACT.md §2.2, "Testable"). */
export const MIN_LEVERS = 2;
export const MIN_CHANGED = 0.1;

/** A 32-bit seed from any strings (sha256), the same on every platform. */
export function seedOf(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest().readUInt32BE(0);
}

/** mulberry32: a small deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutation(n, seed) {
  const r = rng(seed);
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const q = (b) => (String(b).includes(':') ? String(b) : `minecraft:${b}`);
const short = (b) => String(b).replace(/^minecraft:/, '');

function stoneKin(block) {
  const fam = stoneFamilyOf(block);
  if (!fam) return [];
  return STONE_FAMILIES[fam].filter((b) => b !== short(block)).map(q).filter((b) => variant(b, 'stairs') && variant(b, 'slab'));
}

/** The palette shifts a bible's roles allow, in order: [{ name, set: { role: block } }] (no-op and unbuildable ones left out). */
export function shiftOptions(roles) {
  const out = [];
  if (roles.wall && roles.wall_alt && roles.wall !== roles.wall_alt) out.push({ name: 'swap_wall', set: { wall: roles.wall_alt, wall_alt: roles.wall } });
  const kin = roles.roof ? stoneKin(roles.roof) : [];
  if (kin.length) out.push({ name: 'roof_kin', set: { roof: kin[0] } });
  if (roles.trim && roles.frame && roles.trim !== roles.frame) out.push({ name: 'swap_trim_frame', set: { trim: roles.frame, frame: roles.trim } });
  const others = ['frame', 'wall', 'floor', 'roof', 'trim', 'wall_alt'].map((k) => roles[k]).filter((b) => b && b !== roles.accent);
  if (roles.accent && others.length) out.push({ name: 'accent_role', set: { accent: others[0] } });
  return out.filter((s) => {
    try {
      paletteFromBible({ id: 'shift', version: 1, roles: { ...roles, ...s.set } });
      return true;
    } catch {
      return false;
    }
  });
}

/** The one-param changes a design allows: [{ name, value }] (ints -1 and +1 within bounds, bools flip, enums next). */
export function paramOptions(params = {}, values = {}) {
  const out = [];
  for (const [k, p] of Object.entries(params)) {
    const v = values[k] ?? p.default;
    if (p.type === 'int') {
      if (v - 1 >= p.min) out.push({ name: k, value: v - 1 });
      if (v + 1 <= p.max) out.push({ name: k, value: v + 1 });
    } else if (p.type === 'bool') out.push({ name: k, value: !v });
    else if (p.type === 'enum') out.push({ name: k, value: p.options[(p.options.indexOf(v) + 1) % p.options.length] });
  }
  return out;
}

/** A copy is mirrored when it is its archetype's 1st, 3rd, ... copy. */
export const mirroredOrdinal = (ordinal) => ordinal % 2 === 1;

/** A build's cells in design coordinates: key "x,y,z" -> value (block, sorted props, block entity). */
function cellsOf(bp) {
  const out = new Map();
  for (const e of bp.entries()) {
    const props = Object.keys(e.state.props).sort().map((k) => `${k}=${e.state.props[k]}`).join(',');
    out.set(`${e.x - bp.ox},${e.y - bp.oy},${e.z - bp.oz}`, `${e.state.name}[${props}]|${e.nbt ? JSON.stringify(e.nbt) : ''}`);
  }
  return out;
}

/** lib/diff.mjs's count of changed cells (added + removed + changed) of B against A, and its share of A's cells. */
export function changedShare(a, b) {
  let n = 0;
  for (const [k, v] of a) if (b.get(k) !== v) n++;
  for (const k of b.keys()) if (!a.has(k)) n++;
  return { changed: n, share: a.size ? n / a.size : 1 };
}

const shiftKey = (r) => (r?.shift ? r.shift.name : '');
const paramKey = (r) => (r?.param ? `${r.param.name}=${JSON.stringify(r.param.value)}` : '');

/**
 * The levers two recipes differ in (`null` = the archetype), counting only the effective ones (`eff`: the shift names,
 * param keys and 'mirror' whose single-lever build changes a cell).
 */
export function leversBetween(a, b, eff) {
  const ok = (k) => !eff || eff.has(k);
  const out = [];
  if (shiftKey(a) !== shiftKey(b) && (ok(`shift:${shiftKey(a)}`) || ok(`shift:${shiftKey(b)}`))) out.push('shift');
  if (paramKey(a) !== paramKey(b) && (ok(`param:${paramKey(a)}`) || ok(`param:${paramKey(b)}`))) out.push('param');
  if (!!a?.mirror !== !!b?.mirror && ok('mirror')) out.push('mirror');
  return out;
}

/** The recipe's derived bible (the group's, with the shift) as a palette spec for build.mjs. */
export function recipeBible(bible, recipe) {
  return { id: bible.id ?? 'bible', version: bible.version ?? 1, ...(bible.name ? { name: bible.name } : {}), roles: { ...recipe.roles } };
}

/**
 * Choose a copy's recipe. `load(roles, values, mirror)` builds the design in memory (build.mjs loadDesign) and returns
 * its Blueprint. `bible` the group's bible ({ id, version, roles }); `params`/`values` the archetype's; `seed`
 * seedOf(group, archetype key); `ordinal` 1, 2, ...; `siblings` the recipes of the archetype's earlier copies (built or
 * planned); `max` {x,y,z} the copy item's size cap; `massing` the archetype's approved massing sidecar (conformance is
 * checked against it mirrored with the copy); `attempt` 0..2.
 * Returns { shift, param, roles, values, mirror, ordinal, attempt, levers, changed, bar } (bar: the 2-lever / 10% bar is
 * met; false when no candidate meets it: the best one is taken).
 */
export async function chooseRecipe({ load, bible, params = {}, values = {}, seed, ordinal, siblings = [], max, massing, attempt = 0 }) {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('chooseRecipe: ordinal must be 1, 2, ...');
  const roles = bible.roles;
  const mirror = mirroredOrdinal(ordinal);
  const cache = new Map();
  const build = async (r) => {
    const k = JSON.stringify([r.roles, r.values, !!r.mirror]);
    if (!cache.has(k)) {
      try {
        const bp = await load(r.roles, r.values, !!r.mirror);
        cache.set(k, { bp, cells: cellsOf(bp) });
      } catch (e) {
        cache.set(k, { error: e.message });
      }
    }
    return cache.get(k);
  };
  const recipe = (shift, param) => ({ shift, param, roles: { ...roles, ...(shift?.set ?? {}) }, values: { ...values, ...(param ? { [param.name]: param.value } : {}) }, mirror, ordinal });
  const arch = await build({ roles, values, mirror: false });
  if (arch.error) throw new Error(`the archetype does not build: ${arch.error}`);
  // which single levers change the build
  const shifts = shiftOptions(roles);
  const ps = paramOptions(params, values);
  const eff = new Set();
  for (const s of shifts) {
    const b = await build({ roles: { ...roles, ...s.set }, values, mirror: false });
    if (!b.error && changedShare(arch.cells, b.cells).changed > 0) eff.add(`shift:${s.name}`);
  }
  for (const p of ps) {
    const b = await build({ roles, values: { ...values, [p.name]: p.value }, mirror: false });
    if (!b.error && changedShare(arch.cells, b.cells).changed > 0) eff.add(`param:${p.name}=${JSON.stringify(p.value)}`);
  }
  {
    const b = await build({ roles, values, mirror: true });
    if (!b.error && changedShare(arch.cells, b.cells).changed > 0) eff.add('mirror');
  }
  // the seeded order: effective options first (each in its seeded order), rotated by the ordinal
  const order = (list, s, key) => {
    const perm = permutation(list.length, s).map((i) => list[i]);
    return [...perm.filter((x) => eff.has(key(x))), ...perm.filter((x) => !eff.has(key(x)))];
  };
  const S = shifts.length ? order(shifts, seed, (x) => `shift:${x.name}`) : [null];
  const P = ps.length ? order(ps, seed ^ 0x9e3779b9, (x) => `param:${x.name}=${JSON.stringify(x.value)}`) : [null];
  const pairs = [];
  for (let t = 0; t < S.length * P.length; t++) pairs.push([S[(t + ordinal - 1) % S.length], P[(Math.floor(t / S.length) + ordinal - 1) % P.length]]);
  const sibBuilds = [];
  for (const sr of siblings) sibBuilds.push({ r: sr, b: await build(sr) });
  const fits = (bp) => {
    if (max && (bp.size.x > max.x || bp.size.y > max.y || bp.size.z > max.z)) return false;
    if (massing) {
      const m = mirror ? mirrorSidecar(massing, mirrorAxisOf(bp.front)) : massing;
      if (!checkConformance(JSON.parse(JSON.stringify(bp.sidecar())), m).ok) return false;
    }
    return true;
  };
  let skip = attempt;
  let best;
  for (const [shift, param] of pairs) {
    const r = recipe(shift, param);
    const b = await build(r);
    if (b.error || !fits(b.bp)) continue;
    const vsArch = { levers: leversBetween(null, r, eff), ...changedShare(arch.cells, b.cells) };
    const vsSibs = sibBuilds.filter((s) => !s.b.error).map((s) => ({ levers: leversBetween(s.r, r, eff), ...changedShare(s.b.cells, b.cells) }));
    const all = [vsArch, ...vsSibs];
    const minLevers = Math.min(...all.map((x) => x.levers.length));
    const minShare = Math.min(...all.map((x) => x.share));
    const out = { ...r, attempt, levers: vsArch.levers, changed: Math.round(vsArch.share * 1000) / 1000, minLevers, minShare: Math.round(minShare * 1000) / 1000, bar: minLevers >= MIN_LEVERS && minShare >= MIN_CHANGED };
    if (out.bar) {
      if (skip-- > 0) continue;
      return out;
    }
    if (!best || minLevers > best.minLevers || (minLevers === best.minLevers && minShare > best.minShare)) best = out;
  }
  if (best) return best;
  // nothing fits: the plain first candidate (the sidecar's check says why)
  const [shift, param] = pairs[attempt % pairs.length];
  return { ...recipe(shift, param), attempt, levers: [], changed: 0, minLevers: 0, minShare: 0, bar: false };
}
