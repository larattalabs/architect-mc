// s6_cave_city (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, SETTLEMENTS §16.2 S6 "a city carved inside the mountain"): the golden
// scenario S6's bundled program, not a catalogue program. A long hall runs east-west under the claim's centre, cut into the mountain by
// the scenario's sculpt (kit/regions/s6_cavern_sculpt.mjs: S6's fixture is mostly meadow, so the cavern is sculpted as natural land
// before the plan, as S3's flat hill is, "Slice SB as built"). Its dwellings are carve_into site lots dug into the hall's walls: three
// on the north wall facing south, three on the south wall facing north, one at the west end facing east. Each lot's front row is the
// hall's edge row (air), its other rows rock, so a carved design's face is the hall's wall and its door step stands on the hall's floor.
// A ramp at the east end climbs to the surface; `entrance` and `spawn` stand at its top. The program writes no op but the lots: the hall,
// its lights and the ramp are the land's (the sculpt's). Deterministic: no Math.random, no clock.
import { region } from '../lib/region/program.mjs';

export const id = 's6_cave_city';
export const description = 'S6 cave city: carved halls in the walls of a cavern hall under the mountain (7b SB).';
export const catalogue = false;
export const params = {
  floorY: { type: 'int', min: -64, max: 300, default: -64, label: 'Hall floor y (the sculpt; -64: auto)' },
};

/** The city's numbers: lots per long wall, the lot's design size [w, h, d] (front south), the gap between lots, the hall's size. */
export const CITY = Object.freeze({ perSide: 3, lot: Object.freeze([16, 12, 15]), gap: 2, hallWidth: 12, hallHeight: 8, cover: 24, ramp: 3 });

/**
 * The layout from the claim and the land: `heightAt(x, z)` the surveyed ground, `floorY` the hall floor's top solid row (the sculpt's
 * choice; default the lowest ground over the city less CITY.cover). Pure. Returns {cx, cz, floorY, hall {x0, x1, z0, z1, y0, y1},
 * lots [{id, rotation, box}], ramp [{x, y, z0, z1}] (the stairs' feet rows, x east of the hall), top, volume (the city's read box)}.
 */
export function caveLayout(claim, heightAt, floorY = null) {
  const cx = claim.minX + Math.floor((claim.maxX - claim.minX + 1) / 2), cz = claim.minZ + Math.floor((claim.maxZ - claim.minZ + 1) / 2);
  const [LW, LH, LD] = CITY.lot;
  const run = CITY.perSide * LW + (CITY.perSide - 1) * CITY.gap;
  const hx0 = cx - Math.floor(run / 2) - 1, hx1 = hx0 + run + 2;
  const hz0 = cz - CITY.hallWidth / 2, hz1 = hz0 + CITY.hallWidth - 1;
  const lots = [];
  for (let i = 0; i < CITY.perSide; i++) {
    const x0 = hx0 + 1 + i * (LW + CITY.gap);
    // north wall: front south, the front row (design z = d - 1) the hall's north edge row
    lots.push({ id: `hall_n${i + 1}`, rotation: 'none', box: [x0, null, hz0 - (LD - 1), x0 + LW - 1, null, hz0] });
    // south wall: turned 180 (front north), the front row the hall's south edge row
    lots.push({ id: `hall_s${i + 1}`, rotation: 'clockwise_180', box: [x0, null, hz1, x0 + LW - 1, null, hz1 + LD - 1] });
  }
  // the west end: turned a quarter (front east), across the hall's axis, its front row the hall's west column
  lots.push({ id: 'hall_w', rotation: 'counterclockwise_90', box: [hx0 - (LD - 1), null, cz - LW / 2, hx0, null, cz + LW / 2 - 1] });
  const ext = { minX: hx0 - LD - 8, maxX: hx1 + 8, minZ: hz0 - LD - 8, maxZ: hz1 + LD + 8 };
  let low = Infinity;
  for (let x = ext.minX; x <= ext.maxX; x++) for (let z = ext.minZ; z <= ext.maxZ; z++) low = Math.min(low, heightAt(x, z));
  const F = Number.isInteger(floorY) ? floorY : low - CITY.cover;
  for (const l of lots) { l.box[1] = F + 1; l.box[4] = F + LH; }
  // the ramp east of the hall: 3 wide on the axis, one row up per column until it opens at the surface
  const ramp = [];
  let top = null;
  for (let i = 1; i <= 96; i++) {
    const x = hx1 + i, y = F + i; // y: the step's top solid row (the feet stand at y + 1)
    if (x > claim.maxX - 4) break;
    let g = -Infinity;
    for (let z = cz - 1; z <= cz + 1; z++) g = Math.max(g, heightAt(x, z));
    ramp.push({ x, y, z0: cz - 1, z1: cz + 1 });
    if (y >= g) { top = [x, heightAt(x, cz) + 1, cz]; break; } // (the feet on the ground where the ramp opens)
  }
  // the city's read box: the lots and the hall + 8, east to the ramp's top + 8 and up to 6 over it (the checker walks the ramp in it)
  const rx = ramp.length ? ramp[ramp.length - 1].x : hx1, ry = top ? top[1] : F + LH;
  const volume = { minX: ext.minX, maxX: Math.min(claim.maxX, Math.max(ext.maxX, rx + 8)), minZ: ext.minZ, maxZ: ext.maxZ, minY: F - 8, maxY: Math.max(F + LH + 8, ry + 6) };
  return { cx, cz, floorY: F, low, hall: { x0: hx0, x1: hx1, z0: hz0, z1: hz1, y0: F + 1, y1: F + CITY.hallHeight }, lots, ramp, top, volume };
}

export default function s6CaveCity(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'lots']);
  const L = caveLayout(claim, (x, z) => survey.heightAt(x, z), P?.floorY > -64 ? P.floorY : null);
  r.meta.sb = { scenario: 's6', floorY: L.floorY, hall: L.hall, top: L.top, dwellings: L.lots.map((l) => l.id), fitCalledFor: { carve_into: L.lots.map((l) => l.id) } };
  const at = L.top ?? [L.hall.x1, L.floorY + 1, L.cz];
  r.anchor('entrance', at);
  r.anchor('spawn', [at[0] - 2, at[1] - 2, at[2]]); // (two steps down the ramp)
  // cameras: two in the hall (from each end, looking along it), one at the ramp's foot, three outside over the mountain
  const H = L.hall, cy = H.y0 + 4;
  r.anchor('hub', [L.cx, H.y0, L.cz]); // (the hall's middle: the cameras aim at it; an M2 node)
  r.anchor('cam_hall_w', [H.x0 + 2, cy, L.cz]);
  r.anchor('cam_hall_e', [H.x1 - 1, cy, L.cz]);
  r.anchor('cam_ramp', [H.x1 + 6, L.floorY + 8, L.cz]);
  r.anchor('cam_high', [L.cx, L.low + 40, L.cz + 60]);
  r.anchor('cam_n', [L.cx, L.low + 24, L.cz - 70]);
  r.anchor('cam_s', [L.cx, L.low + 24, L.cz + 70]);
  const vol = r.needVolume(L.volume);
  if (!vol) return r; // (the first plan asks for the city's volume; the second places the lots from it)
  // the street: the hall's floor paved (clear of the lots' front rows) and every ramp step, the path role over the sculpted rock
  const street = r.part('street', { stage: 'ground', set: 'path' });
  street.fill({ kind: 'box', min: [H.x0 + 1, { abs: L.floorY }, H.z0 + 1], max: [H.x1, { abs: L.floorY }, H.z1 - 1] }, 'path', { cond: 0 });
  for (const s of L.ramp) street.fill({ kind: 'box', min: [s.x, { abs: s.y }, s.z0], max: [s.x, { abs: s.y }, s.z1] }, 'path', { cond: 0 });
  for (const l of L.lots) {
    r.siteLot(l.id, { fit: 'carve_into', box: l.box, rotation: l.rotation, stage: 'lots', brief: 'A home carved into the hall\'s wall: the rock its walls, the cut face its facade.', ext: { 'architect_mc:sb': { role: 'dwelling' } } });
  }
  return r;
}
