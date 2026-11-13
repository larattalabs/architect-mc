// (7c BF, docs/CONTRACT.md "Phase 7c" §3 row 2) The big forms as plan parts: `form.hollow_mountain`, `form.crater` and
// `form.floating_island`. compile.mjs resolves each as a square of its size from its locator (resolveBig: clear of the zones and forms
// placed before it, dry but for an island) and calls emitBig in the forms stage. Every block they write is natural (the Style's rock,
// subsurface and surface roles, shroomlights, the island's strata), written by a form part, so survival builds them free (RS's terrain
// half); a crater's lake is an H pond body (lib/fluids/pond.mjs emitPond: its shell, exits and sources). Deterministic.
import { fnv64 } from '../noise.mjs';
import { compassDir } from '../region/geom.mjs';
import { analyseVolume } from '../region/affordances.mjs';
import { VC } from '../region/volume.mjs';
import { hollowMountain, LIGHT_EVERY } from './hollowMountain.mjs';
import { crater } from './crater.mjs';
import { floatingIsland, islandRule } from './floatingIsland.mjs';
import { bodyId, emitPond, leakCheck, outline, iceFor } from '../fluids/pond.mjs';
import { fluidRolesOf } from '../fluids/place.mjs';

export const BIG_KINDS = Object.freeze(['hollow_mountain', 'crater', 'floating_island']);
const PRESET = Object.freeze({ S: 32, M: 48, L: 64, XL: 96 });
/** Each kind's own members (the params members read leniently in their place are named in the notes). */
const OWN = Object.freeze({
  hollow_mountain: ['height', 'halls', 'entrance'],
  crater: ['depth', 'rim', 'lake', 'lakeDepth'],
  floating_island: ['height', 'thickness', 'pads'],
});
/** The affordance kinds a hollow mountain records (AF's CAVE, CLIFF_FACE and LEDGE). */
export const HOLLOW_AFFORDANCES = Object.freeze(['cliff_face', 'cave', 'ledge']);
/** An island's pads: 9 by 9. */
export const PAD = 9;

/** The part's square side ([w, d]): its size preset, else the larger end of each side, else M (48). */
export function bigSide(part) {
  if (part.size?.preset) return [PRESET[part.size.preset], PRESET[part.size.preset]];
  if (part.size?.w !== undefined) {
    const one = (v) => (Array.isArray(v) ? v[1] : v);
    const s = Math.max(one(part.size.w), one(part.size.d));
    return [s, s];
  }
  return [PRESET.M, PRESET.M];
}

/** Whether a resolved part writes a pond body (a crater with a lake): the plan's fluids stage. */
export function bigWantsFluids(p) {
  return p.family === 'form' && p.kind === 'crater' && lakeOf(p.part).lake;
}

/** A crater's lake: its own member, else params.lake (read leniently), with a note when read from params. */
function lakeOf(part) {
  if (typeof part.lake === 'boolean') return { lake: part.lake, fromParams: false };
  return { lake: part.params?.lake === true, fromParams: part.params?.lake === true };
}

/** The notes a big form's answer carries: the params it does not read, a lake read from params, a mountain raised on low land. */
export function bigNotes(env, part, rect) {
  const notes = [];
  const kind = part.kind;
  const keys = Object.keys(part.params ?? {}).filter((k) => !(kind === 'crater' && k === 'lake')).sort();
  if (keys.length) notes.push(`params ${keys.join(', ')}: not read (the ${kind}'s own members are ${OWN[kind].join(', ')})`);
  if (kind === 'crater' && lakeOf(part).fromParams) notes.push('params.lake read as lake: a pond in the crater\'s floor');
  if (kind === 'hollow_mountain') {
    let lo = Infinity, hi = -Infinity;
    for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) { const g = env.S.groundAt(x, z); if (g < lo) lo = g; if (g > hi) hi = g; }
    if (hi - lo < 8) notes.push(`no mountain stands here (the land rises ${hi - lo} over the rect): the form raises one and hollows it`);
  }
  return notes;
}

/** The hollow mountain's entrance side: its own, else (auto) the side facing the claim's centre (south on a tie). */
function entranceOf(env, part, rect) {
  if (part.entrance && part.entrance !== 'auto') return part.entrance;
  const c = env.claim;
  const dx = (c.minX + c.maxX) - (rect.minX + rect.maxX), dz = (c.minZ + c.maxZ) - (rect.minZ + rect.maxZ);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  if (dz < 0) return 'north';
  return 'south';
}

/** Record affordances the program found without a frozen volume (a form's own virtual land): r.affordances' store. */
function record(r, list) {
  const seen = (r._affordances ??= new Map());
  for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
}

/** The hollow mountain's own land as a decoded volume (classes only), over its bounds grown by 2. */
function virtualVolume(gen, groundAt) {
  const b = gen.bounds;
  const box = { minX: b.minX - 2, maxX: b.maxX + 2, minZ: b.minZ - 2, maxZ: b.maxZ + 2, minY: gen.base - 4, maxY: b.maxY + 3 };
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D).fill(VC.AIR);
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) {
    const x = box.minX + i, z = box.minZ + k, g = groundAt(x, z);
    for (let j = 0; j < H; j++) {
      const y = box.minY + j;
      if (gen.solid(x, y, z) || (y <= g && !gen.void(x, y, z))) classes[(i * D + k) * H + j] = VC.ROCK;
    }
  }
  return { box, width: W, height: H, depth: D, classes };
}

/**
 * Emit a resolved big form `p` (its resolution `f`: rect) as form part `id` in the forms stage. K: {env, r, ctx, stageOf}. Returns
 * `{geometry}` for the answer (throws on a generator error: the caller rolls back and refuses the part).
 */
export function emitBig(K, p, f, id) {
  const { env, r, ctx } = K;
  const part = p.part, rect = f.rect;
  const stage = K.stageOf('forms');
  const groundAt = (x, z) => env.S.groundAt(x, z);
  const seed = fnv64(ctx.seed ?? '', 'bigForm', p.id).hex;
  if (p.kind === 'hollow_mountain') {
    const gen = hollowMountain({ rect, height: part.height, halls: part.halls, entrance: entranceOf(env, part, rect), seed, groundAt });
    r.form(id, gen, { stage });
    const m = (r.meta.parts[id] ??= {});
    // M5 (6b's cavern rule): no dark spawnable floor cell over the floor's row
    (m.caverns ??= []).push({ floorY: gen.floorY, lights: gen.lights.length, every: LIGHT_EVERY, bounds: { minX: gen.bounds.minX, maxX: gen.bounds.maxX, minZ: gen.bounds.minZ, maxZ: gen.bounds.maxZ, minY: gen.floorY, maxY: gen.cavern.box.maxY } });
    const affs = analyseVolume(virtualVolume(gen, groundAt), { kinds: [...HOLLOW_AFFORDANCES] });
    record(r, affs);
    m.hollow = { floorY: gen.floorY, cavern: gen.cavern, halls: gen.halls, entrance: gen.entrance, affordances: affs.length };
    const cb = gen.cavern.box;
    return {
      geometry: {
        cavern: [cb.minX, cb.minY, cb.minZ, cb.maxX, cb.maxY, cb.maxZ], floorY: gen.floorY, entrance: gen.entrance.mouth,
        halls: gen.halls.filter((h) => !h.skipped).map((h) => [h.box.minX, h.box.minY, h.box.minZ, h.box.maxX, h.box.maxY, h.box.maxZ]),
        affordances: affs.map((a) => a.id),
      },
      notes: gen.halls.filter((h) => h.skipped).map((h) => `the ${h.side} hall: no room under the mountain's roof (left out)`),
    };
  }
  if (p.kind === 'crater') {
    const L = lakeOf(part);
    const gen = crater({ rect, depth: part.depth, rim: part.rim, lake: L.lake, lakeDepth: part.lakeDepth, seed, groundAt });
    r.form(id, gen, { stage });
    const geometry = { centre: [gen.centre[0], gen.base, gen.centre[1]], radius: gen.R, floorY: gen.bottomAt(gen.centre[0], gen.centre[1]) + 1 };
    if (L.lake) {
      // the lake: an H pond body in the floor, its surface level with the bowl's bottom at its edge (the shell its own part's)
      const surface = outline(gen.lakeRect, 'round').map((c) => [c.x, gen.lakeLevel, c.z]);
      const dec = iceFor(ctx, surface, part.ice);
      if (dec.refuse) throw new Error(`${dec.refuse.code}: ${dec.refuse.message}`);
      const rec = emitPond(r, { id: bodyId(p.id), part: p.id, kind: 'pond', rect: gen.lakeRect, shape: 'round', depth: gen.lakeDepth, edge: 'natural', fluid: 'water', stage, level: gen.lakeLevel, roles: fluidRolesOf(ctx), ice: dec.ice });
      // (the body's frozen volume, asked on the first plan: the check plans twice for it, as a wet write's (finish.mjs wetAsked))
      if (rec.volumeState === 'asked') r.meta.wetAsked = true;
      leakCheck(r, env, rec);
      geometry.lake = { rect: [gen.lakeRect.minX, gen.lakeRect.minZ, gen.lakeRect.maxX, gen.lakeRect.maxZ], level: rec.level, depth: rec.depth, body: rec.id };
    }
    return { geometry, notes: [] };
  }
  // floating_island: 6b's generator, natural only (no rail, no lamps), its anchor at the top centre
  const [w, d] = [rect.maxX - rect.minX + 1, rect.maxZ - rect.minZ + 1];
  const cx = (rect.minX + rect.maxX) >> 1, cz = (rect.minZ + rect.maxZ) >> 1;
  const R = Math.max(6, Math.floor((Math.min(w, d) - 1) / 2) - 5);
  const amp = Math.min(6, Math.max(2, Math.floor(R / 6 + 0.5)));
  const thickness = part.thickness ?? Math.max(6, Math.min(32, Math.floor((R * 4) / 5)));
  let hi = -Infinity;
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) hi = Math.max(hi, env.S.topAt(x, z));
  // the underside (the cone, its warp and its roots) clears the land by at least 6
  const least = thickness + 2 * amp + 14;
  const height = Math.max(part.height ?? 0, least);
  const notes = part.height !== undefined && part.height < least ? [`height ${part.height} raised to ${least}: the island's underside clears the land by 6`] : [];
  const y = hi + height;
  const n = part.pads ?? 0;
  const pads = [];
  if (n === 1) pads.push({ at: [cx - 4, cz - 4], size: [PAD, PAD] });
  else if (n > 1) {
    const rr = Math.floor((R * 9) / 20);
    for (let i = 0; i < n; i++) {
      const dd = compassDir((360 * i) / n);
      const at = [cx + Math.floor(dd[0] * rr + 0.5) - 4, cz + Math.floor(dd[1] * rr + 0.5) - 4];
      if (pads.some((q) => Math.abs(q.at[0] - at[0]) < PAD + 1 && Math.abs(q.at[1] - at[1]) < PAD + 1)) continue;
      pads.push({ at, size: [PAD, PAD] });
    }
    if (pads.length < n) notes.push(`${n - pads.length} pad(s) left out: no room on the island's top`);
  }
  const anchor = `isl_${p.id}`.slice(0, 32);
  // the island rule without its coal ore (not a free natural block in survival): the generator's own strata bands
  const rule = islandRule(seed, Math.floor((y - thickness - amp - 8) / 3));
  rule.rule = rule.rule.filter((c) => c.mat !== 'minecraft:coal_ore');
  // 6b's generator (r.floatingIsland's steps, without its rim: 6b reads `edge: null` as the rail, so the rim op is left out here)
  const isl = floatingIsland({ at: [cx, y, cz], r: [R, R], thickness, seed, top: { relief: 1, pads, lights: 0 }, underside: { taper: 0.7, roots: 4 }, materials: rule });
  const rim = isl.ops.filter((o) => o.op === 'columns' && o.materials?.[0] === 'rail');
  isl.ops = isl.ops.filter((o) => !rim.includes(o));
  isl.params = { ...isl.params, top: { ...isl.params.top, edge: null } };
  r.form(id, isl, { stage });
  r.anchor(anchor, isl.anchor);
  r.floating([id], { anchor });
  (r.meta.parts[id] ??= {}).island = { at: isl.params.at, r: isl.params.r, pads: isl.pads, anchor: isl.anchor };
  return { geometry: { top: y, anchor: isl.anchor, pads: isl.pads.map((q) => [q.at[0], q.y, q.at[1], q.size[0], q.size[1]]) }, notes };
}
