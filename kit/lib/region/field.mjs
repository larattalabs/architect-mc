// (M5 FC, S-M5-4, docs/CONTRACT.md "M5 support" row FC) A module lot's field: `field {cells, crops}` on a plan lot (plan/0 and a revision's
// grown lots), the farmland cells in the lot's frame (IRR's lotFrame: the lot seen with its front to the south, u across, v from the back,
// y from the floor) and the crop kinds it grows. The cell above each farmland cell is its crop cell. The compiler records it on the IR's
// lot as `field {crops, cells: world column runs [x, z, y0, y1] of the farmland, frame: [width, depth], lotCells: the same in the frame as
// runs [u, v, y0, y1]}`; the mod copies it onto the lot's site (FieldCells) and judges its crop cells by the field rule (LC, the standing
// score, the deconstruct's refunds). A plan with no field is unchanged (nothing is written). Pure; no plan-module imports.

import { lotFrame } from '../fluids/irrigate.mjs';
import { toRuns } from '../fluids/body.mjs';
import { parseField } from './fieldSpec.mjs';

export { FIELD_CROPS, FIELD_CELLS_MAX, parseField } from './fieldSpec.mjs';

/** The lot defs asking a field, from the plan's zone parts (`order`: the compiler's; `zoneLots` as irrigate.mjs reads them). */
export function fieldDefs(order, okClass, zoneLots) {
  const out = [];
  for (const p of order) {
    if (p.family !== 'zone' || !okClass(p.id)) continue;
    for (const l of zoneLots(p.part)) if (l.field) out.push({ zone: p.id, def: l });
  }
  return out;
}

/**
 * Records each asked lot's field on the IR's lot (`lots`: the region's lots, each {id, box, front, floorY, irrigation?}). A frame cell off
 * the lot is dropped; so is one IRR keeps open above (a source or its bed: the cell over it is an irrigation cell); a side shell's farmland
 * stays a field cell (its crop cell is the lot's). Returns `{lots: [lot ids], notes: Map(zone -> [note])}`.
 */
export function emitFields(lots, defs) {
  const out = { lots: [], notes: new Map() };
  const note = (z, s) => { const l = out.notes.get(z) ?? []; l.push(s); out.notes.set(z, l); };
  for (const { zone, def } of defs) {
    const lot = lots.find((l) => l.id === def.id) ?? lots.find((l) => l.id.endsWith(`_${def.id}`));
    if (!lot) { note(zone, `field: ${def.id} was not placed (no field)`); continue; }
    const f = parseField(def.field, `${def.id}.field`);
    const F = lotFrame(lot);
    const [W, D] = F.size;
    const irr = new Set();
    for (const [x, z, y0, y1] of lot.irrigation?.cells ?? []) for (let y = y0; y <= y1; y++) irr.add(`${x},${y},${z}`);
    const world = [], frame = [];
    let off = 0, open = 0;
    for (const [u, y, v] of f.cells) {
      if (u >= W || v >= D) { off++; continue; }
      const [x, wy, z] = F.toWorld(u, y, v);
      if (irr.has(`${x},${wy + 1},${z}`)) { open++; continue; }
      world.push([x, wy, z]);
      frame.push([u, y, v]);
    }
    if (off) note(zone, `field: ${def.id}: ${off} cell(s) off the lot dropped`);
    if (open) note(zone, `field: ${def.id}: ${open} cell(s) under an irrigation cell dropped (the source and its bed stay the region's)`);
    if (!world.length) { note(zone, `field: ${def.id} has no field cell on the lot (no field)`); continue; }
    lot.field = { crops: f.crops, cells: toRuns(world), frame: [W, D], lotCells: toRuns(frame.map(([u, y, v]) => [u, y, v])) };
    out.lots.push(lot.id);
  }
  return out;
}
