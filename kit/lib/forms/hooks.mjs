// (6c F3) The compiler's hooks for the grown forms (docs/CONTRACT.md "Phase 6c slice F3" §3, §5, §11): resolve (step 2) and emit
// (step 3, after the zones' layouts and F1's forms, before the walls, the farm ponds, the H parts and the routes). Called by
// kit/lib/plan/compile.mjs with its context `C` (this module never imports compile.mjs).
//
// - giant_tree, giant_mushroom: resolve checks the locator and answers `fits` provisionally (`placedAtEmit`); emit picks the sites
//   (forms/place.mjs) on the real layout, grows each form on the real ground and writes it baked (r.form), its column mask in the IR's
//   forms[]; the answer becomes fits, adjusted (moved past the locator, fewer than count) or refused (NO_ROOM, OVERLAP).
// - coral, roots, stalactites: F3-b and F3-c (stubs answer refused NO_ROOM {until} until each lands).
import { fnv64 } from '../noise.mjs';
import { opBounds } from '../region/plan.mjs';
import { DEPTH, ceilingsOf, facesOf, lintGrows, roots, stalactites } from './cave.mjs';
import { PRESETS as MUSHROOM_PRESETS, giantMushroom } from './giantMushroom.mjs';
import { PRESETS as TREE_PRESETS, giantTree } from './giantTree.mjs';
import { forbidden, pickSites } from './place.mjs';
import { columnRuns, runsRect } from './states.mjs';

/** The grown kinds F3 places on open land (trees and mushrooms), their generators and limits. */
export const GROWN = Object.freeze({
  giant_tree: { generator: 'giantTree', grow: giantTree, preset: 'oak', presets: TREE_PRESETS },
  giant_mushroom: { generator: 'giantMushroom', grow: giantMushroom, preset: 'brown', presets: MUSHROOM_PRESETS },
});
/** The F3 kinds still waiting for their sub-slice (stubs). */
export const PENDING = Object.freeze({ coral: 'F3c' });
/** (§3.3) The cave forms: they read a frozen volume over their search box (the two-plan flow). */
export const CAVE = Object.freeze({ stalactites: { generator: 'stalactites', grow: stalactites, preset: 'small' }, roots: { generator: 'roots', grow: roots, preset: 'dirt' } });
/** A cave form's volume past this many cells answers incomplete VOLUME with its cap, as a tunnel's corridor does (T3b's caps). */
export const CAVE_CAP = Object.freeze({ boxCells: 4_000_000 });
export const isF3 = (p) => p.family === 'form' && (p.kind in GROWN || p.kind in CAVE || p.kind in PENDING);

const rectArr = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];

/**
 * Step 2: a grown form's locator is checked; its sites wait for the emit. Returns {klass, reasons, notes, placedAtEmit}.
 */
export function f3Resolve(C, p) {
  if (p.kind in PENDING) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `${p.block} is built by slice ${PENDING[p.kind]} (not in this build yet)`, evidence: { until: PENDING[p.kind] } }] };
  const loc = C.locatorOf(C.env, p.part.where, C.geomOf, { within0: 24 });
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(p.part.where ?? {})[0] ?? null, ...(loc.error.evidence ?? {}) } }] };
  return { klass: 'fits', reasons: [], notes: [], placedAtEmit: true };
}

/** The zone a part stands inside (where.inside.part naming a zone), or null. */
function insideZone(C, p) {
  const id = p.part.where?.inside?.part;
  return id && C.byId.get(id)?.family === 'zone' ? id : null;
}

/** A zone's open land (§3.1): its rect, and the footprints of every op its layout wrote plus its lot boxes + 1 (each grown by 2 in place.mjs). */
function zoneOpen(C, zid) {
  const g = C.geom.get(zid);
  if (!g?.rect) return null;
  const r = C.r;
  const obstacles = [];
  const bytesOf = (name) => r.sideBlobs?.[name]?.bytes ?? null;
  for (const part of r.parts) {
    if (C.partOf[part.id] !== zid) continue;
    for (const op of part.ops) {
      let b = null;
      try { b = opBounds(op, {}, bytesOf); } catch { b = null; }
      if (b && Number.isFinite(b.minX)) obstacles.push({ minX: Math.floor(b.minX), minZ: Math.floor(b.minZ), maxX: Math.ceil(b.maxX), maxZ: Math.ceil(b.maxZ) });
    }
  }
  for (const l of r.lots) if (C.partOf[`lot:${l.id}`] === zid) obstacles.push({ minX: l.box.minX - 1, minZ: l.box.minZ - 1, maxX: l.box.maxX + 1, maxZ: l.box.maxZ + 1 });
  return { rect: g.rect, obstacles };
}

/**
 * Step 3: place and write a grown form. `C`: {env, r, ctx, geom, geomOf, byId, res, partOf, zones (accepted zone rects with ids),
 * keep, stageOf, checkpoint, rollback, addedSince, mark, ans, tolOf, judge, locatorOf, rectStats}. Returns the answer it gave.
 */
export function f3Emit(C, p) {
  const { env, r } = C;
  const G = GROWN[p.kind];
  const part = p.part;
  const id = `f_${p.id}`.slice(0, 44);
  const cp = C.checkpoint();
  try {
    const loc = C.locatorOf(env, part.where, C.geomOf, { within0: 24 });
    if (loc.error) { const a = { class: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message }] }; C.ans(p, a); return a; }
    const zid = insideZone(C, p);
    const open = zid ? zoneOpen(C, zid) : null;
    const zones = C.zones.filter((z) => z.id !== zid).map((z) => z.rect);
    // (broken variants, ext architect_mc:unsafe: `treeInPond` places the form as if no body were there, M25:clear's backstop catches it;
    // `leafNotPersistent` writes vanilla's own leaves, M18's)
    const unsafe = p.part.ext?.['architect_mc:unsafe'] ?? {};
    const F = forbidden({ env, r, keep: unsafe.treeInPond ? [] : C.keep, zoneOpen: open, zones, noBodies: !!unsafe.treeInPond });
    const want = part.count ?? 1;
    const tMove = C.tolOf(part, 'move'), tCount = C.tolOf(part, 'count');
    const preset = part.preset ?? G.preset;
    const height = part.height === undefined ? undefined : Array.isArray(part.height) ? part.height : [part.height, part.height];
    // (retry a: another seed of the site's species when its own shape fits nowhere; a = 0 is the site's own seed)
    // (from the second retry on, the lower half of the preset's heights: a smaller crown, when the part names no height)
    const lower = (() => { const h0 = G.presets[preset]?.height; return h0 ? [h0[0], Math.max(h0[0], (h0[0] + h0[1]) >> 1)] : undefined; })();
    const params = (k, at, a = 0) => ({ preset, at, seed: fnv64(r.ctx.seed, G.generator, a ? `${id}_${k + 1}_r${a}` : `${id}_${k + 1}`).hex, ...(height ? { height } : a >= 2 && lower ? { height: lower } : {}), ...(part.roots !== undefined ? { roots: part.roots } : {}) });
    const shapes = new Map();
    const shapeOf = (k, a = 0) => {
      const sk = `${k}/${a}`;
      if (!shapes.has(sk)) {
        const g = G.grow(params(k, [0, 64, 0], a));
        const foot = new Map();
        for (const [key, s] of g.cells) { const [x, y, z] = key.split(',').map(Number); if (y <= 65) foot.set(key, s); }
        shapes.set(sk, { columns: g.columns, foot: columnRuns(foot), reach: Math.ceil(g.stats.trunk ?? 2) + 2 });
      }
      return shapes.get(sk);
    };
    const grow = (k, at, a = 0) => G.grow(params(k, at, a), { groundAt: (x, z) => env.S.groundAt(x, z), _unsafe: unsafe.leafNotPersistent || unsafe.mushroomFaces ? { leafNotPersistent: !!unsafe.leafNotPersistent, mushroomFaces: !!unsafe.mushroomFaces } : null });
    const area = open ? open.rect : loc.areaFor ? loc.areaFor(48, 48, tMove.ceiling) : env.claim;
    const roughAt = (x, z, reach) => C.rectStats(env, { minX: x - reach, minZ: z - reach, maxX: x + reach, maxZ: z + reach }).rough;
    let { sites, tried } = pickSites({ env, F, loc, area, want, shapeOf, grow, roughAt, maxMove: tMove.ceiling });
    if (unsafe.treeInPond) {
      // (the broken variant) placed as if no body were there, its trunk 5 east of the middle of the first body's footprint (a
      // fountain's apron, where the basin's single breach runs over the ground), no check at all: the trunk, its roots and the soil under them
      // stand in the body's watch, so M25:clear's backstop refuses the tree, never the body (the body's own shell is untouched)
      const rec = (C.keep ?? [])[0];
      if (rec) {
        const cs = [...(rec.kind === 'reserved' ? rec.cols : rec.cols.keys())].map((c) => c.split(',').map(Number));
        const x = ((Math.min(...cs.map((c) => c[0])) + Math.max(...cs.map((c) => c[0]))) >> 1) + (unsafe.offset ?? 5), z = (Math.min(...cs.map((c) => c[1])) + Math.max(...cs.map((c) => c[1]))) >> 1;
        const g0 = env.S.groundAt(x, z);
        sites = [{ at: [x, g0, z], gen: grow(0, [x, g0, z]), move: 0, k: 0 }];
      }
    }
    if (!sites.length) {
      C.rollback(cp);
      const why = zid ? `no open land in zone ${zid} holds the ${p.kind.replace('_', ' ')}` : `no site for the ${p.kind.replace('_', ' ')} within its locator`;
      const a = { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `${why}: dry, level, ${8} clear of natural trees, 2 clear of bodies, zones, lots and forms`, evidence: { tried, want, inside: zid ?? undefined } }] };
      C.ans(p, a);
      C.geom.delete(p.id);
      return a;
    }
    sites.forEach((s) => r.form(`${id}_${s.k + 1}`, s.gen, { stage: C.stageOf('forms') }));
    C.mark(p.id, C.addedSince(cp));
    const move = Math.max(...sites.map((s) => s.move));
    const j = C.judge([{ what: 'move', value: move, ...tMove }, { what: 'count', value: want - sites.length, ...tCount }]);
    let rect = null;
    for (const s of sites) { const q = runsRect(s.gen.columns); rect = rect ? { minX: Math.min(rect.minX, q.minX), minZ: Math.min(rect.minZ, q.minZ), maxX: Math.max(rect.maxX, q.maxX), maxZ: Math.max(rect.maxZ, q.maxZ) } : q; }
    C.geom.set(p.id, { rect });
    const f = C.res.get(p.id) ?? {};
    f.sites = sites.map((s) => [s.at[0], s.at[2]]);
    f.rect = rect;
    C.res.set(p.id, f);
    const notes = sites.length < want ? [`${sites.length} of ${want} placed: no other site is dry, level and clear (natural trees 8, bodies, zones, lots and forms 2)`] : [];
    const retried = sites.filter((q) => q.retry);
    if (retried.length) notes.push(`${retried.length} grown from another seed of the species (its own shape fit nowhere within the locator)`);
    const a = { class: j.klass, deviations: j.deviations, notes, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [] };
    if (j.klass === 'refused') { C.rollback(cp); C.geom.delete(p.id); }
    C.ans(p, a);
    return a;
  } catch (e) {
    C.rollback(cp);
    C.geom.delete(p.id);
    const oc = /OUT_OF_CLAIM/.test(e.message);
    const a = { class: 'refused', reasons: [{ code: oc ? 'OUT_OF_CLAIM' : 'NO_ROOM', message: e.message }] };
    C.ans(p, a);
    return a;
  }
}

/** (§3.3) A cave form's search box: its locator's rect (inside: the part's or the claim's; near: the target grown by within) x [the lowest ground - 48, the highest ground]. */
function caveBox(C, p, loc) {
  const env = C.env;
  const w = p.part.where;
  let rect;
  if (w?.inside?.part) rect = C.geomOf(w.inside.part)?.rect ?? null;
  else if (loc.target && Number.isInteger(loc.W)) rect = { minX: loc.target.minX - loc.W, minZ: loc.target.minZ - loc.W, maxX: loc.target.maxX + loc.W, maxZ: loc.target.maxZ + loc.W };
  else if (loc.areaFor) rect = loc.areaFor(8, 8, 0);
  rect ??= { minX: env.claim.minX + 2, minZ: env.claim.minZ + 2, maxX: env.claim.maxX - 2, maxZ: env.claim.maxZ - 2 };
  rect = { minX: Math.max(env.claim.minX, rect.minX), minZ: Math.max(env.claim.minZ, rect.minZ), maxX: Math.min(env.claim.maxX, rect.maxX), maxZ: Math.min(env.claim.maxZ, rect.maxZ) };
  let lo = Infinity, hi = -Infinity;
  for (let x = rect.minX; x <= rect.maxX; x++) for (let z = rect.minZ; z <= rect.maxZ; z++) { const g = env.S.groundAt(x, z); if (g < lo) lo = g; if (g > hi) hi = g; }
  return { rect, box: { minX: rect.minX, minZ: rect.minZ, maxX: rect.maxX, maxZ: rect.maxZ, minY: Math.max(-64, lo - DEPTH), maxY: Math.min(319, hi) } };
}

/**
 * Step 3 for a cave form (stalactites, roots): its frozen volume (asked on the first plan: `incomplete VOLUME`; past the cap: the same
 * with `evidence.cap`), its sites (ceilings with at least 4 headroom; roots: faces first, then ceilings), each cluster grown and written
 * (baked). No ceiling (or face) at all: refused NO_FEATURE {why}. Cells keep off every body's sets (KC), lot boxes and hard columns.
 */
export function f3CaveEmit(C, p) {
  const { env, r } = C;
  const G = CAVE[p.kind];
  const part = p.part;
  const id = `f_${p.id}`.slice(0, 44);
  const cp = C.checkpoint();
  try {
    const loc = C.locatorOf(env, part.where, C.geomOf, { within0: 24 });
    if (loc.error) { const a = { class: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message }] }; C.ans(p, a); return a; }
    const { rect, box } = caveBox(C, p, loc);
    const cells = (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) * (box.maxZ - box.minZ + 1);
    if (cells > CAVE_CAP.boxCells) {
      const a = { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `the ${p.kind}' search box is ${cells} cells, past the cap (${CAVE_CAP.boxCells})`, evidence: { box: [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ], cells, cap: 'boxCells', limit: CAVE_CAP.boxCells } }] };
      C.ans(p, a);
      return a;
    }
    const vol = r.needVolume(box);
    if (!vol) {
      const a = { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `the ${p.kind}' rock was not read yet (the two-plan flow reads it): prepare (or check with load: "generate"), then check again`, evidence: { box: [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ], cells, missing: true } }] };
      C.ans(p, a);
      return a;
    }
    const unsafe = part.ext?.['architect_mc:unsafe'] ?? {};
    const groundAt = (x, z) => env.S.groundAt(x, z);
    const lots = r.lots.map((l) => l.box);
    // (every cave form's cells so far, and their face neighbours: two cave forms never touch)
    const taken = (r._f3Cave ??= new Set());
    const keepCell = (x, y, z) => {
      if (C.keepBy && C.keepBy(x, y, z)) return false;
      if (taken.has(`${x},${y},${z}`)) return false;
      for (const b of lots) if (x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1 && y >= b.minY - 1 && y <= b.maxY + 1) return false;
      for (const q of env.hard) if (x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ) return false;
      return true;
    };
    const on = p.kind === 'roots' ? (part.params?.on === 'ceiling' ? 'ceiling' : part.params?.on === 'face' ? 'face' : 'auto') : 'ceiling';
    const ceilings = ceilingsOf(vol, rect, groundAt, loc.aim);
    const faces = p.kind === 'roots' && on !== 'ceiling' ? facesOf(vol, rect, groundAt, loc.aim) : [];
    const pool = [...(on === 'ceiling' ? [] : faces.map((f) => ({ face: f }))), ...(on === 'face' ? [] : ceilings.map((c) => ({ ceil: c })))];
    if (!pool.length) {
      C.rollback(cp);
      const why = p.kind === 'roots' ? (on === 'face' ? 'no face' : on === 'ceiling' ? 'no ceiling' : 'no face or ceiling') : 'no ceiling';
      const a = { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: `${why} with ${4} headroom in the search box (the frozen volume shows none)`, evidence: { why, box: [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ] } }] };
      C.ans(p, a);
      C.geom.delete(p.id);
      return a;
    }
    const want = part.count ?? 1;
    const preset = part.preset ?? G.preset;
    const height = part.height;
    const sites = [];
    const near = (s) => sites.some((q) => Math.max(Math.abs(q.x - s.x), Math.abs(q.z - s.z)) < 8);
    for (const c of pool) {
      if (sites.length >= want) break;
      const s = c.face ? { x: c.face.x, z: c.face.z } : { x: c.ceil.x, z: c.ceil.z };
      if (near(s)) continue;
      // (a site another cave form took)
      if (c.ceil ? taken.has(`${c.ceil.x},${c.ceil.y},${c.ceil.z}`) : taken.has(`${c.face.x},${c.face.top - 1},${c.face.z}`)) continue;
      const k = sites.length;
      const params = { preset, ...(height !== undefined ? { height } : {}), seed: fnv64(r.ctx.seed, G.generator, `${id}_${k + 1}`).hex };
      let gen;
      try { gen = c.face ? G.grow(params, { vol, site: c.face, keepCell }) : G.grow(params, { vol, site: c.ceil, ceiling: true, keepCell, _unsafe: unsafe.stalactiteUnderWater ? { stalactiteUnderWater: true } : null }); } catch (e) { if (/^NO_FEATURE/.test(e.message)) continue; throw e; }
      if (p.kind === 'stalactites') { const g2 = lintGrows(gen.cells, vol); if (g2) throw new Error(g2); }
      sites.push({ x: s.x, z: s.z, gen, k });
    }
    if (!sites.length) {
      C.rollback(cp);
      const a = { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: `no ${p.kind === 'roots' ? 'face or ceiling' : 'ceiling'} in the search box takes the form (water over every root, or kept cells)`, evidence: { why: 'no ceiling', candidates: pool.length } }] };
      C.ans(p, a);
      C.geom.delete(p.id);
      return a;
    }
    sites.forEach((s) => r.form(`${id}_${s.k + 1}`, s.gen, { stage: C.stageOf('forms') }));
    for (const s of sites) for (const k of s.gen.cells.keys()) { const [x, y, z] = k.split(',').map(Number); for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) taken.add(`${x + dx},${y + dy},${z + dz}`); }
    C.mark(p.id, C.addedSince(cp));
    const tCount = C.tolOf(part, 'count');
    const j = C.judge([{ what: 'count', value: want - sites.length, ...tCount }]);
    let gr = null;
    for (const s of sites) { const q = runsRect(s.gen.columns); gr = gr ? { minX: Math.min(gr.minX, q.minX), minZ: Math.min(gr.minZ, q.minZ), maxX: Math.max(gr.maxX, q.maxX), maxZ: Math.max(gr.maxZ, q.maxZ) } : q; }
    C.geom.set(p.id, { rect: gr });
    const f = C.res.get(p.id) ?? {};
    f.sites = sites.map((s) => [s.x, s.z]);
    C.res.set(p.id, f);
    const notes = [`read 1 frozen volume (${cells} cells); ${sites.length} cluster(s) on ${sites.filter((s) => s.gen.params.on === 'face').length ? 'faces' : 'ceilings'}`];
    if (sites.length < want) notes.push(`${sites.length} of ${want} placed: no other ceiling or face 8 apart takes one`);
    const a = { class: j.klass, deviations: j.deviations, notes, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [] };
    if (j.klass === 'refused') { C.rollback(cp); C.geom.delete(p.id); }
    C.ans(p, a);
    return a;
  } catch (e) {
    C.rollback(cp);
    C.geom.delete(p.id);
    const code = /^.*GROWS/.test(e.message) ? 'NO_ROOM' : /OUT_OF_CLAIM/.test(e.message) ? 'OUT_OF_CLAIM' : 'NO_ROOM';
    const a = { class: 'refused', reasons: [{ code, message: e.message }] };
    C.ans(p, a);
    return a;
  }
}

export { rectArr };
