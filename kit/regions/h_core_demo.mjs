// h_core_demo: H-core's own fluid bodies (docs/CONTRACT.md "Phase 6c slice H" §14 and §15 step 1: gate items 1-3, 5-7, 13, 14 and 17 on
// one plain pond body and one small spilling body), written straight through r.fluidBody, so the foundation is gated without H-a's
// generators. Not in the catalogue. On any claim of at least 48x48 with level ground near its centre (a flat world, or a pinned site):
//   pond   a sunk 7x5 pond, 2 deep in its middle 5x3 (surface 1 under the ground), bed and sides in clay, the rim in stone bricks;
//   spout  a 5x5 basin 1 deep (sunk) round a stone pillar whose top holds one source: its four sides fall into the basin (the spill:
//          two bodies, the spout and its basin; the spout's falling column is the declared spill);
//   lava   a 3x3 lava pit 1 deep, lined in stone, a stone coping (M20's fire reach clear), off by default.
// `variant` builds one broken variant for the gate's negative controls (§14 "Broken variants"): noShellCell (one rim cell of the pond
// left unwritten, still declared: M25:shell and M25:leak; in game the forced ticks make it leak), predictShort (the spout's spill
// declared one cell short: the escape guard drains it), sandShell (the pond's floor in sand over a carved gap: M25:shell), flowingState
// (lint FLUID_STATE), twoSourceCorner (an extra spill cell between two sources: M25:convert), lavaNearWater (the lava pit 1 from the
// pond: M25:mix), flammableRim (an oak-plank coping on the lava pit: M20), roofedPond (a slab roof over the pond: M25:trap), noExit (the
// pond walled 3 high all round: M25:exit).
import { region } from '../lib/region/program.mjs';

export const id = 'h_core_demo';
export const catalogue = false;

export const params = {
  pond: { type: 'bool', default: true, label: 'Sunk pond' },
  spout: { type: 'bool', default: true, label: 'Spout and basin' },
  lava: { type: 'bool', default: false, label: 'Lava pit' },
  variant: { type: 'enum', options: ['none', 'no_shell_cell', 'predict_short', 'sand_shell', 'flowing_state', 'two_source_corner', 'lava_near_water', 'flammable_rim', 'roofed_pond', 'no_exit'], default: 'none', label: 'Broken variant' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: -30000000, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: -30000000, label: 'Centre z' },
};

const AUTO = -30000000;

export default function hCoreDemo(ctx) {
  const { claim, survey, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 48 || D < 48) throw new Error(`h_core_demo needs a claim of at least 48x48 (got ${W}x${D})`);
  const cx = P.cx === AUTO ? claim.minX + (W >> 1) : P.cx;
  const cz = P.cz === AUTO ? claim.minZ + (D >> 1) : P.cz;
  const v = P.variant;
  const r = region(ctx);
  r.stages(['ground', 'fluids']);
  const g = (x, z) => survey.groundAt(x, z);
  const anchorY = g(cx, cz) + 1;
  r.anchor('entrance', [cx, anchorY, cz - 14]);
  r.anchor('spawn', [cx, anchorY, cz - 14]);
  r.anchor('cam_high', [cx, anchorY + 24, cz - 24]);
  const notes = [];

  // ---- the sunk pond: 7x5 at (cx - 12 .. cx - 6, cz - 2 .. cz + 2), surface 1 under the lowest ground of its rim
  if (P.pond) {
    const x0 = cx - 12, x1 = cx - 6, z0 = cz - 2, z1 = cz + 2;
    let low = Infinity;
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) low = Math.min(low, g(x, z));
    // (no_exit: the surface 4 under the ground, a shaft with no bank within reach: M25:exit)
    const level = v === 'no_exit' ? low - 4 : low - 1;
    const cells = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      cells.push([x, level, z]);
      if (x > x0 && x < x1 && z > z0 && z < z1) cells.push([x, level - 1, z]);
    }
    const carve = r.part('pond_carve', { stage: 'ground' });
    const cols = [];
    for (const [x, y, z] of cells) cols.push(x, z, y, y, 0);
    // the basin up to the ground (whatever stood over the surface goes too: the column's top)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.push(x, z, level + 1, g(x, z), 0);
    // (no_shell_cell: that rim cell is carved to air too, as a basin carved one wider than its water; the shell, written over it in every
    // other build, leaves it open, so in game the forced ticks make the pond leak there)
    if (v === 'no_shell_cell') cols.push(x0 - 1, cz, level, level, 0);
    carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 0 });
    if (v === 'sand_shell') {
      // the floor in sand over a carved gap (an air cell under the middle of the bed: M25:shell, a gravity block over a gap)
      carve.columns({ abs: 0 }, { abs: 0 }, [cx - 9, cz, level - 3, level - 3, 0], [null], { cond: 3 });
    }
    const shellRole = (x, y, z, where) => (v === 'sand_shell' && where === 'floor' ? 'minecraft:sand' : where === 'rim' ? 'minecraft:stone_bricks' : 'minecraft:clay');
    r.fluidBody(cells, { id: 'pond', kind: 'pond', stage: 'ground', level, shellRole, _unsafe: v === 'no_shell_cell' ? { noShellCell: [x0 - 1, level, cz] } : null });
    if (v === 'roofed_pond') {
      // a stone roof right on the water (no air over any surface cell: M25:trap)
      const roof = r.part('pond_roof', { stage: 'ground' });
      const rc = [];
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) rc.push(x, z, level + 1, level + 1, 0);
      roof.columns({ abs: 0 }, { abs: 0 }, rc, ['minecraft:stone_bricks'], { cond: 3 });
    }
    if (v === 'two_source_corner') notes.push('twoSourceCorner: see the spout');
  }

  // ---- the spout over a sunk 5x5 basin at (cx + 4 .. cx + 8, cz - 2 .. cz + 2): two bodies, the spout source falling into the basin
  if (P.spout) {
    const bx = cx + 6, bz = cz;
    let low = Infinity;
    for (let x = bx - 3; x <= bx + 3; x++) for (let z = bz - 3; z <= bz + 3; z++) low = Math.min(low, g(x, z));
    const level = low - 1;
    const basin = [];
    for (let x = bx - 2; x <= bx + 2; x++) for (let z = bz - 2; z <= bz + 2; z++) if (x !== bx || z !== bz) basin.push([x, level, z]);
    const carve = r.part('basin_carve', { stage: 'ground' });
    const cols = [];
    for (const [x, y, z] of basin) cols.push(x, z, y, g(x, z), 0);
    carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 0 });
    // the pillar: from the basin's bed up to 2 over the ground; the spout source on top
    const top = low + 2;
    const pillar = r.part('spout_pillar', { stage: 'ground' });
    pillar.columns({ abs: 0 }, { abs: 0 }, [bx, bz, level, top - 1, 0], ['minecraft:stone_bricks'], { cond: 3 });
    const solid = [];
    for (let y = level; y <= top - 1; y++) solid.push([bx, y, bz]);
    r.fluidBody(basin, { id: 'spout_basin', kind: 'fountain', stage: 'ground', level, shellRole: (x, y, z, where) => (where === 'rim' ? 'minecraft:stone_bricks' : 'minecraft:stone_bricks'), solid });
    const outlets = [[bx + 1, top, bz], [bx - 1, top, bz], [bx, top, bz + 1], [bx, top, bz - 1]];
    r.fluidBody([[bx, top, bz]], { id: 'spout', kind: 'fountain', stage: 'ground', level: top, outlets, shellRole: 'minecraft:stone_bricks', solid, world: (x, y, z) => (basin.some((c) => c[0] === x && c[1] === y && c[2] === z) ? 'water' : null),
      _unsafe: v === 'predict_short' ? { predictShort: true } : v === 'flowing_state' ? { flowingState: true } : null });
    if (v === 'two_source_corner') {
      // a third body: two sources with a gap between them over stone: the gap converts (M25:convert)
      const y = level + 3;
      const pad = r.part('corner_pad', { stage: 'ground' });
      pad.columns({ abs: 0 }, { abs: 0 }, [bx - 1, bz - 6, y - 1, y - 1, 0, bx, bz - 6, y - 1, y - 1, 0, bx + 1, bz - 6, y - 1, y - 1, 0], ['minecraft:stone_bricks'], { cond: 3 });
      r.fluidBody([[bx - 1, y, bz - 6], [bx + 1, y, bz - 6]], { id: 'corner', kind: 'pond', stage: 'ground', level: y, outlets: [[bx, y, bz - 6]], shellRole: 'minecraft:stone_bricks' });
    }
  }

  // ---- the lava pit: 3x3, 1 deep, sunk, a stone lining and coping
  if (P.lava) {
    const lx = v === 'lava_near_water' ? cx - 9 : cx, lz = v === 'lava_near_water' ? cz + 5 : cz + 8;
    let low = Infinity;
    for (let x = lx - 2; x <= lx + 2; x++) for (let z = lz - 2; z <= lz + 2; z++) low = Math.min(low, g(x, z));
    const level = low - 1;
    const cells = [];
    for (let x = lx - 1; x <= lx + 1; x++) for (let z = lz - 1; z <= lz + 1; z++) cells.push([x, level, z]);
    const carve = r.part('lava_carve', { stage: 'ground' });
    const cols = [];
    for (const [x, y, z] of cells) cols.push(x, z, y, g(x, z), 0);
    carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 0 });
    r.fluidBody(cells, { id: 'lava_pit', kind: 'pond', fluid: 'lava', stage: 'ground', level, shellRole: (x, y, z, where) => (where === 'rim' ? (v === 'flammable_rim' ? 'minecraft:oak_planks' : 'minecraft:stone_bricks') : 'minecraft:stone') });
  }
  for (const n of notes) r.note?.(n);
  return r;
}
