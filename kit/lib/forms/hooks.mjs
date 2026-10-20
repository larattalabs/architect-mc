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
import { giantMushroom } from './giantMushroom.mjs';
import { giantTree } from './giantTree.mjs';
import { forbidden, pickSites } from './place.mjs';
import { columnRuns, runsRect } from './states.mjs';

/** The grown kinds F3 places on open land (trees and mushrooms), their generators and limits. */
export const GROWN = Object.freeze({
  giant_tree: { generator: 'giantTree', grow: giantTree, preset: 'oak' },
  giant_mushroom: { generator: 'giantMushroom', grow: giantMushroom, preset: 'brown' },
});
/** The F3 kinds still waiting for their sub-slice (stubs). */
export const PENDING = Object.freeze({ roots: 'F3b', stalactites: 'F3b', coral: 'F3c' });
export const isF3 = (p) => p.family === 'form' && (p.kind in GROWN || p.kind in PENDING);

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
    const params = (k, at) => ({ preset, at, seed: fnv64(r.ctx.seed, G.generator, `${id}_${k + 1}`).hex, ...(height ? { height } : {}), ...(part.roots !== undefined ? { roots: part.roots } : {}) });
    const shapes = new Map();
    const shapeOf = (k) => {
      if (!shapes.has(k)) {
        const g = G.grow(params(k, [0, 64, 0]));
        const foot = new Map();
        for (const [key, s] of g.cells) { const [x, y, z] = key.split(',').map(Number); if (y <= 65) foot.set(key, s); }
        shapes.set(k, { columns: g.columns, foot: columnRuns(foot), reach: Math.ceil(g.stats.trunk ?? 2) + 2 });
      }
      return shapes.get(k);
    };
    const grow = (k, at) => G.grow(params(k, at), { groundAt: (x, z) => env.S.groundAt(x, z), _unsafe: unsafe.leafNotPersistent || unsafe.mushroomFaces ? { leafNotPersistent: !!unsafe.leafNotPersistent, mushroomFaces: !!unsafe.mushroomFaces } : null });
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

export { rectArr };
