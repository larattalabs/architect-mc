// The `coral` generator, version 1 (docs/CONTRACT.md 6c F3 §2, §3.4; SETTLEMENTS §9.2). Plan time only.
//
// Coral grows on the bed of a plan body (form.pond, the basin of a form.fountain, channel.moat): it is the body's own cells (the op's
// `decor` set, kit/lib/fluids/body.mjs), never a form of its own in the world. Skeleton (F1's rules: one bounded op per patch, at most 32
// primitives, absolute y, seeded fnv64(seed, generator, label)): each patch is a union of 2-4 branching `capsuleChain`s lying on the bed
// from the patch's centre; the columns the skeleton covers (its cells projected) that hold room are the patch. Per patch column:
//   - a live coral block in the bed cell (a shell floor cell: solid to solid, the cell over it the body's water),
//   - a live coral plant or fan, or a sea pickle (1-4; 1 under an ice cap: light 6, M17), standing on the bed in the column's lowest water
//     cell, when that cell is at least 2 under the surface (its top face 1 or more under the water's surface plane: y <= level - 1),
//   - a live coral wall fan on a side wall (a shell cell beside a water cell at least 2 under the surface), facing away from it.
// Every plant, fan, wall fan and pickle is waterlogged (it carries its own water: a body cell, a source for the census); every coral is
// live (never a dead variant); every one stands on a sturdy face (the bed, a coral block, a side wall). Integer maths only (no trig, no
// exponent, no Math.random); the patch rng is splitmix64 over fnv64(seed, 'coral', label).
// Presets: tube, brain, bubble, fire, horn (one species), mixed (the default: a species a patch, one column in four another).
import { fnv64, splitmix64 } from '../noise.mjs';
import { formCells } from './rules.mjs';

export const GENERATOR = 'coral';
export const VERSION = 1;
export const SPECIES = Object.freeze(['tube', 'brain', 'bubble', 'fire', 'horn']);
export const PRESETS = Object.freeze({ mixed: SPECIES, tube: ['tube'], brain: ['brain'], bubble: ['bubble'], fire: ['fire'], horn: ['horn'] });
/** The limits (catalogue 11 `form.coral.limits`): count 1..8 patches, cover 0..1 of the bed (default 0.3); a patch holds at most 64 columns. */
export const LIMITS = Object.freeze({ count: [1, 8], cover: [0, 1], patch: 64, spacing: 3 });
export const DEFAULTS = Object.freeze({ preset: 'mixed', cover: 0.3, count: 3 });
const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** A wall fan's facing by the side its wall is on (the fan points away from the block it hangs on). */
const WALLS = [[1, 0, 'west'], [-1, 0, 'east'], [0, 1, 'north'], [0, -1, 'south']];
const k3 = (x, y, z) => `${x},${y},${z}`;
const k2 = (x, z) => `${x},${z}`;
const isInt = Number.isInteger;

/** The block states coral writes (every property given, alphabetical, as a dump prints them). */
export const coralBlock = (sp) => `minecraft:${sp}_coral_block`;
export const coralPlant = (sp) => `minecraft:${sp}_coral[waterlogged=true]`;
export const coralFan = (sp) => `minecraft:${sp}_coral_fan[waterlogged=true]`;
export const coralWallFan = (sp, facing) => `minecraft:${sp}_coral_wall_fan[facing=${facing},waterlogged=true]`;
export const seaPickle = (n) => `minecraft:sea_pickle[pickles=${n},waterlogged=true]`;

function rng(seed, label) {
  const h = fnv64(seed, GENERATOR, label);
  const g = splitmix64(h.hi, h.lo);
  return { int: (a, b) => a + Math.floor(g.float() * (b - a + 1)) };
}

/** Validate the params; returns them filled ({preset, cover, count, seed, label}). */
export function coralParams(p = {}) {
  const preset = p.preset ?? DEFAULTS.preset;
  if (!PRESETS[preset]) throw new Error(`coral: unknown preset '${preset}' (${Object.keys(PRESETS).join(', ')})`);
  const cover = p.cover ?? DEFAULTS.cover;
  if (typeof cover !== 'number' || !(cover >= LIMITS.cover[0] && cover <= LIMITS.cover[1])) throw new Error('coral: cover must be a number in 0..1');
  const count = p.count ?? DEFAULTS.count;
  if (!isInt(count) || count < LIMITS.count[0] || count > LIMITS.count[1]) throw new Error('coral: count must be an integer in 1..8');
  return { preset, cover, count, seed: String(p.seed ?? '1'), label: String(p.label ?? 'coral') };
}

/**
 * The bed's room for coral over a body `{cells, shell, level, ice}` (cells [[x, y, z]]): per column whose lowest body cell stands on a
 * shell cell (the bed) and is water (no ice cap cell), {x, z, yb (that lowest cell's y), plant: whether it is at least 2 under the
 * surface}. Sorted (x, z). Cells in `taken` (another coral's) are left out.
 */
export function bedRoom(body, taken = new Set()) {
  const shell = new Set(body.shell.map((c) => k3(...c)));
  const ice = new Set((body.ice ?? []).map((c) => k3(...c)));
  const low = new Map();
  for (const [x, y, z] of body.cells) { const k = k2(x, z); if (!low.has(k) || y < low.get(k)) low.set(k, y); }
  const out = [];
  for (const [k, yb] of low) {
    const [x, z] = k.split(',').map(Number);
    if (!shell.has(k3(x, yb - 1, z)) || ice.has(k3(x, yb, z))) continue;
    if (taken.has(k3(x, yb - 1, z)) || taken.has(k3(x, yb, z))) continue;
    out.push({ x, z, yb, plant: yb <= body.level - 1 });
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z);
}

/**
 * Grow coral on a body's bed. `body`: {cells, shell, level, ice} (r.fluidBody's, before the op is written). `taken`: cells another coral
 * of the same body holds. `_unsafe.liveCoralDry`: one live coral block written on a dry rim cell too (the broken variant: M19);
 * `_unsafe.fullPickles`: pickles 4 to a cluster under an ice cap too (M17's control, tests only). Returns {generator, version, seed,
 * params, ops (the skeleton, one per patch), decor: [[x, y, z, state]] sorted (y, x, z), sites: [[x, y, z]] (patch centres), room
 * (columns with room), stats}.
 */
export function coral(params, body, { taken = new Set(), _unsafe = null } = {}) {
  const p = coralParams(params);
  const species = PRESETS[p.preset];
  const capped = (body.ice ?? []).length > 0;
  const room = bedRoom(body, taken);
  const roomAt = new Map(room.map((c) => [k2(c.x, c.z), c]));
  const own = new Set(body.cells.map((c) => k3(...c)));
  const shell = new Set(body.shell.map((c) => k3(...c)));
  const ice = new Set((body.ice ?? []).map((c) => k3(...c)));
  const ops = [], sites = [], decor = new Map();
  const stats = { patches: 0, columns: 0, blocks: 0, plants: 0, fans: 0, wallFans: 0, pickles: 0, cells: 0, room: room.length, capped };
  if (room.length) {
    // the patch centres: seeded picks among the columns with room, at least LIMITS.spacing apart (Chebyshev)
    const want = Math.min(p.count, room.length);
    const R = rng(p.seed, `${p.label}:centres`);
    const centres = [];
    for (let k = 0; k < want; k++) {
      for (let t = 0; t < 24; t++) {
        const c = room[R.int(0, room.length - 1)];
        if (centres.some((q) => Math.max(Math.abs(q.x - c.x), Math.abs(q.z - c.z)) < LIMITS.spacing)) continue;
        centres.push(c);
        break;
      }
    }
    // the bed share: cover x the columns with room, at least one column a patch, at most LIMITS.patch a patch
    const total = Math.max(centres.length, Math.round(p.cover * room.length));
    const quota = Math.min(LIMITS.patch, Math.ceil(total / Math.max(1, centres.length)));
    const used = new Set();
    centres.forEach((c, i) => {
      const r = rng(p.seed, `${p.label}:patch${i + 1}`);
      const sp = species[r.int(0, species.length - 1)];
      // the skeleton: 2-4 branches lying on the bed from the centre, each a capsuleChain of 3 points (one primitive each)
      const L = 1 + Math.floor(Math.sqrt(quota));
      const half = (L + 1) >> 1;
      const branches = [];
      const nb = r.int(2, 4);
      for (let b = 0; b < nb; b++) {
        const [dx, dz] = D8[r.int(0, 7)];
        const jx = r.int(-1, 1), jz = r.int(-1, 1);
        branches.push({ kind: 'capsuleChain', points: [[c.x, c.yb, c.z], [c.x + dx * half, c.yb, c.z + dz * half], [c.x + dx * L + jx, c.yb, c.z + dz * L + jz]], radii: [1.5, 1.25, 1] });
      }
      const op = { op: 'shape', shape: { kind: 'union', of: branches }, material: coralBlock(sp), cond: 0, walk: false };
      ops.push(op);
      // the patch: the skeleton's columns with room, nearest the centre first (ties x, z), up to the quota
      const cols = new Set();
      for (const key of formCells([op]).cells.keys()) { const [x, , z] = key.split(',').map(Number); cols.add(k2(x, z)); }
      cols.add(k2(c.x, c.z));
      const pick = [...cols].map((k) => roomAt.get(k)).filter((q) => q && !used.has(k2(q.x, q.z)))
        .sort((a, b) => ((a.x - c.x) * (a.x - c.x) + (a.z - c.z) * (a.z - c.z)) - ((b.x - c.x) * (b.x - c.x) + (b.z - c.z) * (b.z - c.z)) || a.x - b.x || a.z - b.z)
        .slice(0, quota);
      if (!pick.length) return;
      stats.patches++;
      sites.push([c.x, c.yb, c.z]);
      for (const q of pick) {
        used.add(k2(q.x, q.z));
        stats.columns++;
        const s = species.length > 1 && r.int(0, 3) === 0 ? species[r.int(0, species.length - 1)] : sp;
        const near = Math.max(Math.abs(q.x - c.x), Math.abs(q.z - c.z)) <= 1;
        // the bed's coral block (always near the centre)
        let block = false;
        if (near || r.int(0, 99) < 55) { decor.set(k3(q.x, q.yb - 1, q.z), coralBlock(s)); stats.blocks++; block = true; }
        // a wall fan on a side wall at the plant's row, or a plant, fan or pickle on the bed
        if (!q.plant) continue;
        let wall = null;
        for (const [dx, dz, facing] of WALLS) if (shell.has(k3(q.x + dx, q.yb, q.z + dz))) { wall = facing; break; }
        const roll = r.int(0, 99);
        let st = null;
        if (wall && roll < 35) { st = coralWallFan(s, wall); stats.wallFans++; }
        else if (roll < 30 + (block ? 10 : 0)) { st = coralPlant(s); stats.plants++; }
        else if (roll < 65) { st = coralFan(s); stats.fans++; }
        else if (roll < 80) { const n = capped && !_unsafe?.fullPickles ? 1 : _unsafe?.fullPickles ? 4 : r.int(1, 4); st = seaPickle(n); stats.pickles += n; }
        if (st) decor.set(k3(q.x, q.yb, q.z), st);
        // a wall fan higher up the side wall too, where the column is deeper (still 2 under the surface)
        for (let y = q.yb + 1; y <= body.level - 1; y++) {
          const kk = k3(q.x, y, q.z);
          if (!own.has(kk) || ice.has(kk) || decor.has(kk)) continue;
          const w = WALLS.find(([dx, dz]) => shell.has(k3(q.x + dx, y, q.z + dz)));
          if (w && r.int(0, 99) < 30) { decor.set(kk, coralWallFan(s, w[2])); stats.wallFans++; }
        }
      }
    });
  }
  if (_unsafe?.liveCoralDry) {
    // (the broken variant) a live coral block on the first rim cell: a shell cell with no body cell beside it (dry: M19)
    const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const rim = [...body.shell].sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2]).find(([x, y, z]) => !N6.some(([dx, dy, dz]) => own.has(k3(x + dx, y + dy, z + dz))));
    if (rim) { decor.set(k3(...rim), coralBlock(species[0])); stats.blocks++; }
  }
  const out = [...decor].map(([k, s]) => [...k.split(',').map(Number), s]).sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  stats.cells = out.length;
  return { generator: GENERATOR, version: VERSION, seed: p.seed, params: { preset: p.preset, cover: p.cover, count: p.count }, ops, decor: out, sites, room: room.length, stats };
}

/** The ext key of the broken variants (H's, KC's, F3's). */
const UNSAFE = 'architect_mc:unsafe';

/**
 * (§3.4) The coral asked into body part `partId` at its emit (compile step 3): every `form.coral` part of the plan whose
 * `where.inside.part` names it and that still fits, in plan order, as r.fluidBody's `decor` requests [{id, preset, cover, count,
 * _unsafe}] (the lenient params read as F1's: first-class members, else `params`). Empty when there is none (the body is as before).
 */
export function coralRequests(K, partId) {
  const out = [];
  for (const q of K?.order ?? []) {
    if (q.family !== 'form' || q.kind !== 'coral' || q.part?.where?.inside?.part !== partId) continue;
    if (K.okClass && !K.okClass(q.id)) continue;
    const pr = q.part.params ?? {};
    const pick = (k, ok) => (q.part[k] !== undefined ? q.part[k] : ok(pr[k]) ? pr[k] : undefined);
    const preset = pick('preset', (v) => typeof v === 'string' && PRESETS[v] !== undefined);
    const cover = pick('cover', (v) => typeof v === 'number' && v >= 0 && v <= 1);
    const count = pick('count', (v) => isInt(v) && v >= 1 && v <= 8);
    const u = q.part.ext?.[UNSAFE] ?? null;
    out.push({ id: q.id, ...(preset !== undefined ? { preset } : {}), ...(cover !== undefined ? { cover } : {}), ...(count !== undefined ? { count } : {}),
      ...(u && (u.coralOtherPart || u.liveCoralDry || u.fullPickles) ? { _unsafe: { coralOtherPart: !!u.coralOtherPart, liveCoralDry: !!u.liveCoralDry, fullPickles: !!u.fullPickles } } : {}) });
  }
  return out;
}
