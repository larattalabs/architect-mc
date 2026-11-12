// s6_cavern_sculpt (7b SB, "Slice SB as built"): S6's sculpted cavern, not a catalogue program. S6's fixture is weak (73% meadow on a
// high plateau, no cavern; CONTRACT 7b §0), so before S6 is planned the scenario harness writes this program's cells into the world as
// natural, unowned land with vanilla /fill (tools/lib/scenario-sculpt.mjs), as S3's flat variant raises its hill: a site lot's volume
// is the land read at plan time, so a cavern the city's own region carved could not be a carved house's site, and a cavern realised as
// a region of its own would make every cell another owner's (S3's finding). The program is 6b's `cavern` (a lit hollow, flat floor) for
// the hall's middle, plain air cuts for the hall's two edge rows and west column (the dwellings' front rows: no cavern light lands
// in a lot) and for the ramp up to the surface at the east end, with a lantern beside every sixth step. The hall's floor is chosen from
// the city's frozen volume: of the floors from CITY.cover to CITY.cover + 12 under the lowest ground, the one whose lot boxes and hall
// hold the fewest natural voids (caves; water, lava, sand and gravel weigh 100), ties to the higher floor; s6_cave_city plans with it (params.floorY).
// Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';
import { VC } from '../lib/region/volume.mjs';
import { CITY, caveLayout } from './s6_cave_city.mjs';

export const id = 's6_cavern_sculpt';
export const description = 'S6\'s sculpted cavern hall and ramp (7b SB): written as natural land before the city is planned.';
export const catalogue = false;
export const params = {};

/** A floor's cost over a decoded volume: natural voids in the lots' rock and the hall's shell (water and lava x100). */
function voidCost(L, v) {
  if (!v) return 0;
  const b = v.box;
  const cls = (x, y, z) => (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ ? VC.ROCK : v.classes[((x - b.minX) * v.depth + (z - b.minZ)) * v.height + (y - b.minY)]);
  const H = L.hall;
  const inHall = (x, y, z) => x >= H.x0 && x <= H.x1 && z >= H.z0 && z <= H.z1 && y >= H.y0 && y <= H.y1;
  let cost = 0;
  const box = (x0, y0, z0, x1, y1, z1) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (inHall(x, y, z)) continue;
      const c = cls(x, y, z);
      if (c === VC.WATER || c === VC.LAVA || c === VC.LOOSE) cost += 100; // (sand and gravel fall into a cut under them)
      else if (c === VC.AIR || c === VC.PLANT) cost += 1;
    }
  };
  for (const l of L.lots) box(...l.box);
  box(H.x0 - 1, H.y0 - 1, H.z0 - 1, H.x1 + 1, H.y1 + 1, H.z1 + 1);
  return cost;
}

export default function s6CavernSculpt(ctx) {
  const { claim, survey } = ctx;
  const r = region(ctx);
  r.stages(['ground']);
  const hAt = (x, z) => survey.heightAt(x, z);
  const L0 = caveLayout(claim, hAt);
  // the read box covers every candidate floor
  const vb = { ...L0.volume, minY: L0.floorY - 12 - 8, maxY: L0.floorY + CITY.lot[1] + 8 };
  const v = r.needVolume(vb);
  let best = null;
  for (let d = 0; d <= 12; d++) {
    const L = caveLayout(claim, hAt, L0.floorY - d);
    const cost = voidCost(L, v);
    if (!best || cost < best.cost) best = { L, cost, d };
  }
  const L = best.L;
  const H = L.hall;
  r.meta.sb = { scenario: 's6', sculpt: 'cavern', floorY: L.floorY, voidCost: best.cost, volumeRead: !!v, hall: H, top: L.top, ramp: L.ramp.length };
  r.anchor('entrance', L.top ?? [H.x1, H.y0, L.cz]);
  r.anchor('spawn', L.top ?? [H.x1, H.y0, L.cz]);
  // the hall's middle: 6b's cavern (lit, a flat rock floor), clear of the edge rows the lots' front rows take
  r.part('hall', { stage: 'ground' }).cavern({ kind: 'box', min: [H.x0 + 1, { abs: H.y0 }, H.z0 + 1], max: [H.x1, { abs: H.y1 }, H.z1 - 1] }, { amp: 0, floorY: H.y0, light: { every: 6 } });
  // the edge rows and the west column: air (the dwellings' front rows; the lots' designs light them)
  const edge = r.part('hall_edge', { stage: 'ground' });
  for (const z of [H.z0, H.z1]) edge.fill({ kind: 'box', min: [H.x0, { abs: H.y0 }, z], max: [H.x1, { abs: H.y1 }, z] }, null, { cond: 0 });
  edge.fill({ kind: 'box', min: [H.x0, { abs: H.y0 }, H.z0], max: [H.x0, { abs: H.y1 }, H.z1] }, null, { cond: 0 });
  // the ramp: four rows of air over each step, a lantern on the north edge of every sixth step
  const ramp = r.part('ramp', { stage: 'ground' });
  for (const [i, s] of L.ramp.entries()) {
    ramp.fill({ kind: 'box', min: [s.x, { abs: s.y + 1 }, s.z0], max: [s.x, { abs: s.y + 4 }, s.z1] }, null, { cond: 0 });
    if (i % 6 === 3) ramp.fill({ kind: 'box', min: [s.x, { abs: s.y + 1 }, s.z0], max: [s.x, { abs: s.y + 1 }, s.z0] }, 'light', { cond: 0 });
  }
  return r;
}
