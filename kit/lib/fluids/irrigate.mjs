// (6c IRR) Farm irrigation (docs/CONTRACT.md "Phase 6c slice IRR: farm irrigation"): `irrigate: true` on a farm lot, or on a zone for
// every farm lot of it, puts one open 1x1 water source in every 9x9 of the lot's field, each an H body (kind `irrigation`) owned by the
// region, never by the lot's design (S-HY-2). Must not import compile.mjs or program.mjs (hooks.mjs dispatches to it).
//
//   irrigateZones(order, okClass) -> [{zone, lots: [lot def], notes: [string]}]   the zones whose farm lots asked (structural, never a
//                                 regex over the JSON); lots from program.lots, program.params.lots and program.districts[].lots
//   stageWanted(C) -> bool        whether the plan gets the fluids stage for irrigation (any asked farm lot; a wet claim too)
//   fieldOf(lot) -> {x0, z0, x1, z1} | null      the field: the footprint less a 1-column border and less the front row
//   gridOf(lot) -> [[x, z]]       the sources: n = ceil(L / 9) a side, each at its segment's centre (ties to the back and to the left
//                                 seen from the entrance); every field column within 4 (Chebyshev) of one
//   irrigationCells(lot, sources) -> [[x, y, z]]  what the lot's design leaves: each source, its bed, its 4 sides and the cell over it
//   lotFrame(lot) -> {toFrame, toWorld, size}    the lot seen with its front to the south (the design's frame for `reserved`)
//   emitIrrigation(K) -> {lots: [{lot, zone, bodies}], notes: Map(zone -> [note])}   compile step 3, after the farm ponds
//   fieldWorld(fields) -> (x, y, z) -> 'stop' | null    the flow's model of a field: its farmland at floorY (the design's, §5)
//
// The shells are written in the `street` stage (the one after `ground`): the pads write the pad's top in `ground`, and a shell write
// (ALWAYS_OURS) passes only natural cells and the region's earlier stages, so a bed written in `ground` over the pad's top is skipped.
//
// The field model (an as-built decision, CONTRACT IRR "as built"): at plan time a lot's field is not in the plan's world (the lot's
// design is placed later, masked). The flow, the single breach and the checker read the field's floorY cells (the irrigation cells
// aside) as the design's farmland (fluid-stopping), as the brief and the reserved cells ask of the design. A breach then floods its
// own broken cell, inside the lot's box (S-IRR-3); a lot left as a bare pad (no entry) holds air there, which no plan-time rule sees.
import { inferVillager } from '../params.mjs';
import { fluidRolesOf, shellBlock, freezesAt, bodiesMark, bodiesRollback, linesBody } from './place.mjs';
import { naturalOf } from './pond.mjs';
import { toRuns } from './body.mjs';
export { irFields } from './irrfield.mjs';

/** The farmland an irrigation source's sides are written as (volatile moisture: StillOurs; dried to dirt it still holds, S-CU-3). */
export const EDGE_STATE = 'minecraft:farmland[moisture=7]';
/** Vanilla 26.3's hydration reach (FarmBlock.isNearWater: 4 horizontally, at the farmland's level or 1 over). */
export const HYDRATE = 4;
/** The grid's cell: a source per 9x9. */
export const SPAN = 2 * HYDRATE + 1;
/** A field side under this asks nothing (a note). */
export const MIN_SIDE = 3;

const k3 = (x, y, z) => `${x},${y},${z}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** A lot def's irrigate as asked: its own true or false, else its zone's true. */
const asked = (z, l) => !!l && (l.irrigate === true || (z.irrigate === true && l.irrigate !== false));
/** A lot def is a farm: its villager use as flat_village resolves it (given, else implied by its type: params.mjs). */
export const isFarm = (l) => (l.villager ?? inferVillager(l.type)) === 'farm';

/** Every lot def of a zone part: its program's lots, its template's params.lots and its districts' lots. */
export function zoneLots(z) {
  const p = z?.program ?? {};
  const out = [];
  for (const l of Array.isArray(p.lots) ? p.lots : []) out.push(l);
  for (const l of Array.isArray(p.params?.lots) ? p.params.lots : []) out.push(l);
  for (const d of Array.isArray(p.districts) ? p.districts : []) for (const l of Array.isArray(d?.lots) ? d.lots : []) out.push(l);
  return out.filter((l) => l && typeof l === 'object');
}

/** Whether any zone of the plan writes `irrigate` anywhere (a structural test, never over the JSON's text). */
export function asksIrrigate(order) {
  return order.some((p) => p.family === 'zone' && (p.part?.irrigate === true || zoneLots(p.part).some((l) => l.irrigate === true)));
}

/** The zones whose farm lots asked for irrigation: [{zone (validated part), lots: [lot def], notes: [string]}]. */
export function irrigateZones(order, okClass) {
  const out = [];
  for (const p of order) {
    if (p.family !== 'zone' || !okClass(p.id)) continue;
    const z = p.part;
    const all = zoneLots(z);
    const notes = [];
    const lots = [];
    for (const l of all) {
      if (!asked(z, l)) continue;
      if (isFarm(l)) lots.push(l);
      else if (l.irrigate === true) notes.push(`irrigate: ${l.id} is not a farm lot`);
    }
    if (z.irrigate === true && !all.some((l) => asked(z, l) && isFarm(l))) notes.push("irrigate: no farm lot in this zone (a lot whose villager use is 'farm', given or implied by its type), so nothing is irrigated");
    if (lots.length || notes.length) out.push({ zone: p, lots, notes });
  }
  return out;
}

/** Whether the plan gets the fluids stage for irrigation: a farm lot asked (the claim's own water does not matter, unlike the farm pond). */
export function stageWanted(C) {
  if (!asksIrrigate(C.order)) return false;
  return irrigateZones(C.order, C.okClass).some((z) => z.lots.length > 0);
}

// ------------------------------------------------------------------ the lot's frame, the field and the grid

/**
 * The lot seen with its front to the south (+z), as a design sees it: frame u across (west to east when the front is south), v from the
 * back (v = D - 1 is the front row), y from floorY. `size` [W, D] in the frame. A design facing south placed on the lot by LotFitting
 * (centred, front on the edge row) lands at frame u0 = floor((W - w) / 2) for a south or west front and ceil for a north or east one.
 */
export function lotFrame(lot) {
  const b = lot.box, f = lot.front ?? 'south', fy = lot.floorY ?? b.minY;
  const W = b.maxX - b.minX + 1, D = b.maxZ - b.minZ + 1;
  const T = {
    south: { size: [W, D], to: (x, z) => [x - b.minX, z - b.minZ], from: (u, v) => [b.minX + u, b.minZ + v] },
    north: { size: [W, D], to: (x, z) => [b.maxX - x, b.maxZ - z], from: (u, v) => [b.maxX - u, b.maxZ - v] },
    east: { size: [D, W], to: (x, z) => [b.maxZ - z, x - b.minX], from: (u, v) => [b.minX + v, b.maxZ - u] },
    west: { size: [D, W], to: (x, z) => [z - b.minZ, b.maxX - x], from: (u, v) => [b.maxX - v, b.minZ + u] },
  }[f];
  if (!T) throw new Error(`lotFrame: front '${f}' is not a cardinal`);
  return {
    front: f, size: T.size, floorY: fy, ceilU: f === 'north' || f === 'east',
    toFrame: (x, y, z) => { const [u, v] = T.to(x, z); return [u, y - fy, v]; },
    toWorld: (u, y, v) => { const [x, z] = T.from(u, v); return [x, y + fy, z]; },
  };
}

/** The field in the lot's frame: [u0, v0, u1, v1] (the border and the front row off), or null when a side is under MIN_SIDE. */
export function fieldFrame(lot) {
  const F = lotFrame(lot);
  const [W, D] = F.size;
  const u0 = 1, u1 = W - 2, v0 = 1, v1 = D - 3; // border 1 all round, then the front row (v = D - 2) off
  if (u1 - u0 + 1 < MIN_SIDE || v1 - v0 + 1 < MIN_SIDE) return null;
  return [u0, v0, u1, v1];
}

/** The field as world columns {x0, z0, x1, z1} (inclusive), or null. */
export function fieldOf(lot) {
  const f = fieldFrame(lot);
  if (!f) return null;
  const F = lotFrame(lot);
  const a = F.toWorld(f[0], 0, f[1]), c = F.toWorld(f[2], 0, f[3]);
  return { x0: Math.min(a[0], c[0]), z0: Math.min(a[2], c[2]), x1: Math.max(a[0], c[0]), z1: Math.max(a[2], c[2]) };
}

/** Sources along one side [a, b]: n = ceil(L / 9) segments, each source at its segment's centre, a tie to the low end. */
export function axisSources(a, b) {
  const L = b - a + 1;
  const n = Math.ceil(L / SPAN);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s0 = a + Math.floor((i * L) / n), s1 = a + Math.floor(((i + 1) * L) / n) - 1;
    out.push(s0 + Math.floor((s1 - s0) / 2));
  }
  return out;
}

/** The lot's sources as world columns [[x, z]] in (v, u) order of the frame (back row first, left first), or [] when too small. */
export function gridOf(lot) {
  const f = fieldFrame(lot);
  if (!f) return [];
  const F = lotFrame(lot);
  const us = axisSources(f[0], f[2]), vs = axisSources(f[1], f[3]);
  const out = [];
  for (const v of vs) for (const u of us) { const w = F.toWorld(u, 0, v); out.push([w[0], w[2], us.indexOf(u), vs.indexOf(v)]); }
  return out;
}

/** The irrigation cells of a lot: per source, the source, its bed, its 4 sides and the cell over it (world [[x, y, z]], sorted). */
export function irrigationCells(lot, sources = gridOf(lot)) {
  const y = lot.floorY ?? lot.box.minY;
  const seen = new Set(), out = [];
  const add = (x, yy, z) => { const k = k3(x, yy, z); if (!seen.has(k)) { seen.add(k); out.push([x, yy, z]); } };
  for (const [x, z] of sources) {
    add(x, y, z); add(x, y - 1, z); add(x, y + 1, z);
    for (const [dx, dz] of N4) add(x + dx, y, z + dz);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
}

/**
 * The flow's model of irrigated fields (see the header): a cell at a field's floorY inside its field that is not an irrigation cell is
 * the design's farmland ('stop'); anything else null (the world decides). `fields`: [{field: {x0, z0, x1, z1}, floorY, cells: Set}].
 */
export function fieldWorld(fields) {
  return (x, y, z) => {
    for (const f of fields) {
      if (y !== f.floorY || x < f.field.x0 || x > f.field.x1 || z < f.field.z0 || z > f.field.z1) continue;
      if (f.cells.has(k3(x, y, z))) return null;
      return 'stop';
    }
    return null;
  };
}

/** A lot's irrigation body id: `<lot>_irr_<i>_<j>` (the part id rule: at most 48 characters). */
export function irrBodyId(lot, i, j) {
  const suffix = `_irr_${i}_${j}`;
  return `${String(lot).slice(0, 48 - suffix.length)}${suffix}`;
}

// ------------------------------------------------------------------ the emit (compile step 3, after the farm ponds)

/**
 * Each asked farm lot's sources (§2, §3): its grid in its field, each source an H body `<lot>_irr_<i>_<j>` (kind irrigation) whose shell,
 * written by the zone in stage `ground` after the pads, is its bed (the bible's `fluids.bed`, differing from the pad's top) and its four
 * sides (EDGE_STATE); its water in the fluids stage. One frozen volume per lot, shared by its sources. The lot records
 * `irrigation {sources, bodies, field, cells, lotCells}` (the IR's lots[], the artifact's). Notes go to the zone's answer.
 * Broken variants (the zone's `ext.architect_mc:unsafe`): irrNoBed (the first source's bed written as air, a hole: M25:shell), irrBreachOut (the
 * first source moved onto the field's edge row against the border, so its breach leaves the lot: M25:keep), irrUnmasked (true: the
 * IR lot says `unmasked`, so the mod places the lot's design over the sides and the live check refuses the source, PARTIAL; 'plan': a
 * part of no plan part writes one side too, M25:clear at plan time).
 */
export function emitIrrigation(K) {
  const out = { lots: [], notes: new Map() };
  const note = (z, s) => { const l = out.notes.get(z) ?? []; l.push(s); out.notes.set(z, l); };
  const zones = irrigateZones(K.order, K.okClass);
  if (!zones.length) return out;
  const r = K.r;
  const roles = fluidRolesOf(K.ctx);
  for (const z of zones) {
    for (const n of z.notes) note(z.zone.id, n);
    const unsafe = z.zone.part?.ext?.['architect_mc:unsafe'] ?? {};
    for (const def of z.lots) {
      const lot = r.lots.find((l) => l.id === def.id) ?? r.lots.find((l) => l.id.endsWith(`_${def.id}`));
      if (!lot) { note(z.zone.id, `irrigate: ${def.id} was not placed (no irrigation)`); continue; }
      let grid = gridOf(lot);
      if (!grid.length) { note(z.zone.id, `irrigate: ${def.id}'s field is too small (a side under ${MIN_SIDE})`); continue; }
      const fy = lot.floorY;
      const fr = grid.map(([x, zz]) => freezesAt(K.ctx, x, fy, zz)).find((q) => q.freezes);
      if (fr) { note(z.zone.id, `irrigate: the biome freezes the sources (${fr.biome}): ${def.id} is not irrigated`); continue; }
      if (unsafe.irrBreachOut === true) {
        // (the broken variant: the first source on the field's edge row against the border, its outer side in the border column)
        const F = lotFrame(lot), f = fieldFrame(lot);
        const w = F.toWorld(f[0], 0, F.toFrame(grid[0][0], fy, grid[0][1])[2]);
        grid = [[w[0], w[2], 0, 0], ...grid.slice(1)];
      }
      const field = fieldOf(lot);
      const cellsAll = irrigationCells(lot, grid);
      const cellSet = new Set(cellsAll.map((c) => k3(...c)));
      const world = fieldWorld([{ field, floorY: fy, cells: cellSet }]);
      const b = lot.box;
      const volumeBox = { minX: b.minX - 1, minY: fy - 3, minZ: b.minZ - 1, maxX: b.maxX + 1, maxY: fy + 2, maxZ: b.maxZ + 1 };
      const natural = naturalOf(r, { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ }, fy - 2, fy + 2);
      const bedChain = [roles.bed.block, 'minecraft:clay', 'minecraft:mud'].filter((q) => linesBody(q));
      const bed = (x, y, zz) => { const n = natural(x, y, zz); return bedChain.find((q) => nameOfState(q) !== n) ?? bedChain[bedChain.length - 1] ?? shellBlock(r.ctx.roles, 'structure'); };
      const m = bodiesMark(r);
      const cp = K.checkpoint();
      const bodies = [];
      try {
        for (const [x, zz, i, j] of grid) {
          const id = irrBodyId(lot.id, i, j);
          const rec = r.fluidBody([[x, fy, zz]], {
            id, part: z.zone.id, kind: 'irrigation', fluid: 'water', stage: K.stageOf('street'), level: fy, rim: false, raised: false, world, volumeBox,
            // (the broken variant irrNoBed: the first source's bed written as air, a hole under the water: M25:shell)
            shellRole: (sx, sy, sz, where) => (where === 'floor' ? (unsafe.irrNoBed === true && !bodies.length ? null : bed(sx, sy, sz)) : EDGE_STATE),
          });
          bodies.push(rec);
        }
        K.mark(z.zone.id, K.addedSince(cp));
      } catch (e) {
        K.rollback(cp);
        bodiesRollback(r, m);
        note(z.zone.id, `irrigate: ${def.id} is not irrigated (${e.message})`);
        continue;
      }
      // the lot's record: the world cells and the same cells in the lot's frame (front to the south: the design's)
      const F = lotFrame(lot);
      const lotCells = cellsAll.map((c) => F.toFrame(...c)).sort((a, c) => a[1] - c[1] || a[0] - c[0] || a[2] - c[2]);
      lot.irrigation = { sources: bodies.length, bodies: bodies.map((q) => q.id), field: [field.x0, field.z0, field.x1, field.z1], cells: toRuns(cellsAll), lotCells: toRuns(lotCells.map(([u, y, v]) => [u, y, v])) };
      if (unsafe.irrUnmasked === true || unsafe.irrUnmasked === 'plan') {
        // (the broken variant: the mod is told not to mask this lot, so its design writes over the sides; 'plan' also writes one side
        // here, a part of no plan part standing in for the design: M25:clear at plan time)
        lot.irrigation.unmasked = true;
        if (unsafe.irrUnmasked === 'plan') {
          const [x, zz] = grid[0];
          const dp = r.part(`${lot.id}_irr_design`.slice(0, 48), { stage: K.stageOf('lots') });
          dp.columns({ abs: 0 }, { abs: 0 }, [x + 1, zz, fy, fy, 0], ['minecraft:oak_planks'], { cond: 3 });
        }
      }
      out.lots.push({ lot: lot.id, def: def.id, zone: z.zone.id, bodies });
      note(z.zone.id, `irrigate: ${def.id} gets ${bodies.length} source${bodies.length === 1 ? '' : 's'} (${new Set(grid.map((g) => g[2])).size} x ${new Set(grid.map((g) => g[3])).size}), every field column within ${HYDRATE} of one`);
    }
  }
  return out;
}

/** A block state's name (no properties, the minecraft: namespace kept). */
function nameOfState(s) {
  return String(s ?? '').replace(/\[.*$/, '');
}

/** The cells a lot's design must leave, from an IR lot or an artifact lot (its `irrigation.cells`): a Set of "x,y,z". */
export function reservedSet(lot) {
  const s = new Set();
  for (const [x, z, y0, y1] of lot?.irrigation?.cells ?? []) for (let y = y0; y <= y1; y++) s.add(k3(x, y, z));
  return s;
}
