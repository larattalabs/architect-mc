// (8cF, docs/CONTRACT.md "Phase 8c" §9) The in-game lane's hand-built flowing water, through the plan compiler (handcourse.mjs's
// precedent): `river_demo` (a river: a long current from one source reach) and `fall_island` (a fall off a floating island's rim into a
// raised basin). A connector.channel whose ext 'architect_mc:unsafe' carries {handRiver: {role, origin, variant}} dispatches here
// (hooks.mjs); nothing else does, so no plan Claude writes reaches it. Laid so today's sim.mjs `steady` predicts it exactly: no
// conversion cell, no waterlogged block or kelp in a reach, each run of the current at most 7 cells. It must not import compile.mjs or
// program.mjs.
//
// river (role 'river'), along +x from `origin` [x, z] on level ground g, 3 wide (dz -1..1), H = g + 6:
//   mound   stone dx 0..36, dz -4..4, g + 1..g + 7
//   r1      the head reach (kind 'river', flow 'current'): dx 1..6, H - 1..H, surface H; its outlet at dx 7
//   current 6 runs k = 0..5 of 6 cells each, water at H - k over a bed at H - k - 1 (dx 7 + 6k .. 12 + 6k), each ending in a 1-block
//           step (the overhang cell over the next run falls); the runs 0..4 are a trench in the mound, run 5 crosses the meadow (dx
//           37..42) on the natural grass at g, between lining walls; the banks are lining (the face neighbours of the current's cells
//           but the cells over it and the meadow's bed)
//   r2      the terminal pool (kind 'pool', flow 'level'): dx 43..50, g - 1..g, dug into the ground; the current lands on its row dx 43
//   meadow  dx 37..42 at g + 1: the gate's natural flowers (dandelions on the grass) stand in the predicted cells listed in `wash`
//           (variant 'nowash': the wash list left out, the flow washes them: the mint case)
// fall (role 'fall'), along +x from `origin`, 3 wide:
//   island  stone dx 0..10, dz -4..4, g + 14..g + 17 (a floating island: nothing under it)
//   r1      the header pool (kind 'header', lip 'form', on the island part): dx 2..6, g + 16..g + 17, surface g + 17; the lip run dx
//           7..10 at g + 17; the fall at dx 11 from g + 17 to the basin (a drop of 14)
//   plinth  stone dx 8..16, dz -4..4, g + 1..g + 1 (the basin's floor stands on it)
//   r2      the basin (kind 'basin', flow 'level'): dx 9..15, dz -2..2, g + 2..g + 4 (3 deep), surface g + 4; the fall lands on dx 11
// Variants: 'none', 'nowash' (river: no wash list, the flow washes the meadow's flowers), 'short' (the head's spill declared one cell
// short: the escape guard drains it).
import { reachId } from './body.mjs';
import { bodyAnswer } from './pond.mjs';
import { volumeAnswer, bodiesMark, bodiesRollback, leakRefusal, reachMeetsKeep } from './place.mjs';
import { UNSAFE_EXT } from './hooks.mjs';

export const acceptsOverflow = false;
export const ROLES = Object.freeze(['river', 'fall']);
export const VARIANTS = Object.freeze(['none', 'nowash', 'short']);
const MOUND = 'minecraft:stone', SHELL = 'minecraft:stone_bricks', BED = 'minecraft:clay', LINING = 'minecraft:polished_andesite';
/** The river's runs and their length (each at most 7: the spread restarts after each step). */
export const RUNS = 6, RUN = 6;

/** The hand river's spec on a part (its ext), or null. */
export function handRiverSpec(part) {
  const h = part?.ext?.[UNSAFE_EXT]?.handRiver;
  if (!h || typeof h !== 'object') return null;
  const role = ROLES.includes(h.role) ? h.role : 'river';
  const origin = Array.isArray(h.origin) && h.origin.length === 2 && h.origin.every(Number.isInteger) ? h.origin : null;
  const variant = VARIANTS.includes(h.variant) ? h.variant : 'none';
  // (the host form's id for the header's `on`: explicit, the island's own part (a hand IR has no plan part for its island); default 'isle')
  const on = typeof h.on === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(h.on) ? h.on : 'isle';
  return { role, origin, variant, on };
}

const box = (x0, y0, z0, x1, y1, z1) => { const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]); return out; };
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The footprint of a layout: [x0, z0, x1, z1]. */
export function handRiverFootprint(role, [ox, oz]) {
  return role === 'fall' ? [ox - 1, oz - 5, ox + 17, oz + 5] : [ox - 1, oz - 5, ox + 52, oz + 5];
}

/**
 * The river's geometry from an origin and its ground g: {mound, carve, r1, r2, water (the current's expected cells, for the banks),
 * lining, meadow (the flower cells the gate plants), wash}. Absolute cells.
 */
export function riverLayout([ox, oz], g, variant = 'none', part = 'river') {
  const X = (dx) => ox + dx, Z = (dz) => oz + dz, H = g + 6;
  const ids = [reachId(part, 1), reachId(part, 2)];
  const lanes = [-1, 0, 1].map(Z);
  const mound = [{ box: [X(0), g + 1, Z(-4), X(36), g + 7, Z(4)], block: MOUND }];
  const carve = [[X(1), H - 1, Z(-1), X(6), g + 7, Z(1)]];
  const water = [];
  for (let k = 0; k < RUNS; k++) {
    const x0 = 7 + RUN * k, x1 = x0 + RUN - 1, y = H - k;
    if (k < RUNS - 1) carve.push([X(x0), y, Z(-1), X(x1), g + 7, Z(1)]);
    for (let dx = x0; dx <= x1; dx++) for (const z of lanes) water.push([X(dx), y, z]);
    // the overhang: the cell past the run's end, over the next run (or the pool), falls
    for (const z of lanes) water.push([X(x1 + 1), y, z]);
  }
  const r1 = { id: ids[0], cells: box(X(1), H - 1, Z(-1), X(6), H, Z(1)), level: H, outlets: lanes.map((z) => [X(7), H, z]) };
  // (its inlet: the meadow run's last cells stand where its west rim would: no rim of r2's over them)
  const r2 = { id: ids[1], cells: box(X(43), g - 1, Z(-1), X(50), g, Z(1)), level: g, outlets: lanes.map((z) => [X(42), g + 1, z]) };
  carve.push([X(43), g - 1, Z(-1), X(50), g, Z(1)]);
  // the banks: the face neighbours of the current's cells that are no water, no reach cell, not over the water, not the meadow's bed
  const wet = new Set([...water, ...r1.cells, ...r2.cells].map(k3));
  const meadowBed = (c) => c[1] === g && c[0] >= X(7 + RUN * (RUNS - 1)) && c[0] <= X(42);
  const seen = new Set(), lining = [];
  for (const [x, y, z] of water) for (const [dx, dy, dz] of N6) {
    if (dy === 1) continue;
    const c = [x + dx, y + dy, z + dz], k = k3(c);
    if (wet.has(k) || seen.has(k) || meadowBed(c)) continue;
    seen.add(k);
    lining.push(c);
  }
  // the meadow's natural flowers: the predicted cells of run 5's middle lane (the gate plants them before the check)
  const meadow = [];
  for (let dx = 38; dx <= 41; dx++) meadow.push([X(dx), g + 1, Z(0)]);
  const wash = variant === 'nowash' ? [] : meadow;
  return { ids, mound, carve, r1, r2, water, lining, meadow, wash, H, join: { body: ids[1], cells: lanes.map((z) => [X(43), g, z]) } };
}

/** The fall's geometry: {island, plinth, carve, r1, r2, ids}. */
export function fallLayout([ox, oz], g, variant = 'none', part = 'fall') {
  void variant;
  const X = (dx) => ox + dx, Z = (dz) => oz + dz;
  const ids = [reachId(part, 1), reachId(part, 2)];
  const lanes = [-1, 0, 1].map(Z);
  const top = g + 17;
  const island = { box: [X(0), g + 14, Z(-4), X(10), top, Z(4)], block: MOUND };
  const plinth = { box: [X(8), g + 1, Z(-4), X(16), g + 1, Z(4)], block: MOUND };
  const carve = [[X(2), g + 16, Z(-1), X(6), top, Z(1)], [X(7), top, Z(-1), X(10), top, Z(1)]];
  const r1 = { id: ids[0], cells: box(X(2), g + 16, Z(-1), X(6), top, Z(1)), level: top, outlets: lanes.map((z) => [X(7), top, z]) };
  const r2 = { id: ids[1], cells: box(X(9), g + 2, Z(-2), X(15), g + 4, Z(2)), level: g + 4 };
  return { ids, island, plinth, carve, r1, r2, drop: top - (g + 4), join: { body: ids[1], cells: lanes.map((z) => [X(11), g + 4, z]) } };
}

/** Place the part: fits on its footprint. */
export function resolve(C, p) {
  const sp = handRiverSpec(p.part);
  if (!sp?.origin) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: 'a hand river needs ext architect_mc:unsafe.handRiver.origin [x, z]', evidence: {} }] };
  const fp = handRiverFootprint(sp.role, sp.origin);
  // (the ground beside the layout, clear of the mound or island)
  const g = C.env.S.groundAt(sp.origin[0] - 1, sp.origin[1] + 5);
  return { klass: 'fits', rect: { minX: fp[0], minZ: fp[1], maxX: fp[2], maxZ: fp[3] }, footprints: [fp], spec: sp, g, notes: [`architect_mc:unsafe handRiver (${sp.role}, ${sp.variant}): 8c's hand-built ${sp.role === 'fall' ? 'fall off an island' : 'river'}`] };
}

const solid = (r, name, stage, boxes) => {
  const part = r.part(name.slice(0, 48), { stage });
  for (const q of boxes) {
    const [x0, y0, z0, x1, y1, z1] = q.box;
    const cols = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.push(x, z, y0, y1, 0);
    part.columns({ abs: 0 }, { abs: 0 }, cols, [q.block], { cond: 3 });
  }
  return part;
};
const carveAll = (r, name, stage, boxes) => {
  const cols = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.push(x, z, y0, y1, 0);
  r.part(name.slice(0, 48), { stage }).columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 3 });
};
const shellRole = (x, y, z, where) => (where === 'lining' ? LINING : where === 'rim' ? SHELL : BED);

/** Write the part: the solids, then the bodies (downstream first: the tail's water is the head's landing). */
export function emit(K, p, res) {
  const r = K.r, sp = res.spec;
  const m = bodiesMark(r);
  try {
    const stage = K.stageOf('ground');
    const bodies = [];
    if (sp.role === 'river') {
      const L = riverLayout(sp.origin, res.g, sp.variant, p.id);
      solid(r, `${p.id}_mound`, stage, L.mound);
      carveAll(r, `${p.id}_carve`, stage, L.carve);
      // (§2.4) the wash clears: the predicted cells' natural washable blocks to air, IF_NATURAL (journaled; the undo puts them back)
      if (L.wash.length) r.part(`${p.id}_wash`.slice(0, 48), { stage }).columns({ abs: 0 }, { abs: 0 }, L.wash.flatMap(([x, y, z]) => [x, z, y, y, 0]), [null], { cond: 0 });
      const tail = r.fluidBody(L.r2.cells, { id: L.r2.id, part: p.id, kind: 'pool', stage, level: L.r2.level, outlets: L.r2.outlets, shellRole }); // (a plain HY pool: only a current is 8c's, the coordinator)
      bodies.push(tail);
      const head = r.fluidBody(L.r1.cells, { id: L.r1.id, part: p.id, kind: 'river', stage, level: L.r1.level, outlets: L.r1.outlets, lining: L.lining, joins: [L.join], flow: 'current', wash: L.wash, shellRole, _unsafe: sp.variant === 'short' ? { predictShort: true } : null });
      bodies.unshift(head);
      (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind: 'river', look: 'built', flow: 'current', bodies: L.ids, steps: Array.from({ length: RUNS }, (_, k) => ({ kind: 'riffle', run: RUN, drop: 1, k })), ends: [{ end: 'from', kind: 'spring', ref: L.ids[0] }, { end: 'to', kind: 'pool', ref: L.ids[1] }] });
    } else {
      const L = fallLayout(sp.origin, res.g, sp.variant, p.id);
      const island = sp.on; // (the island's part is named by the spec's `on`: the header's on: {part} names it explicitly)
      solid(r, island, stage, [L.island]);
      solid(r, `${p.id}_plinth`, stage, [L.plinth]);
      carveAll(r, `${p.id}_carve`, stage, L.carve);
      const tail = r.fluidBody(L.r2.cells, { id: L.r2.id, part: p.id, kind: 'basin', stage, level: L.r2.level, shellRole }); // (a plain HY basin)
      bodies.push(tail);
      const head = r.fluidBody(L.r1.cells, { id: L.r1.id, part: p.id, kind: 'header', stage, level: L.r1.level, outlets: L.r1.outlets, joins: [L.join], lip: 'form', on: island, shellRole, _unsafe: sp.variant === 'short' ? { predictShort: true } : null });
      bodies.unshift(head);
      (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind: 'waterfall', look: 'built', flow: 'fall', bodies: L.ids, steps: [{ kind: 'fall', from: L.ids[0], to: L.ids[1], drop: L.drop }], ends: [{ end: 'from', kind: 'form', ref: island }, { end: 'to', kind: 'basin', ref: L.ids[1] }] });
    }
    // (8c, the coordinator's answer: W3 breach cells feed KC keep-out) every body's cells, shell, spill and single-breach reach (its watch)
    // against the keep cells: no basin, spill or breach on a lot, a protected area or the claim's ring (M25:keep's reading, LEAK)
    for (const b of bodies) {
      const hit = reachMeetsKeep(r, K.env, b);
      if (hit) throw leakRefusal(b, hit);
    }
    res.emitted = { bodies, notes: [] };
  } catch (e) {
    bodiesRollback(r, m);
    if (r.meta.courses) { r.meta.courses = r.meta.courses.filter((c) => c.part !== p.id); if (!r.meta.courses.length) delete r.meta.courses; }
    throw e;
  }
}

/** The answer's fields: the bodies, the volume answer first. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { block: res.spec.role === 'fall' ? 'form.waterfall' : 'channel.course', hand: res.spec.variant } });
}
