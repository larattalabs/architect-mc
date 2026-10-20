// (6c IRR) The irrigated fields of an IR, for the checker (checkFluids.mjs): pure, no imports (irrigate.mjs reaches the plan modules;
// the checker must not, or the module graph cycles through pond.mjs).
const k3 = (x, y, z) => `${x},${y},${z}`;

/**
 * The fields of an IR (its lots' `irrigation`): [{lot, box, floorY, field, cells: Set, bodies: Set}] (for the checker: the flow's field
 * model, the own-lot keep exemption and the exits).
 */
export function irFields(ir) {
  const out = [];
  for (const l of ir?.lots ?? []) {
    const g = l.irrigation;
    if (!g || !Array.isArray(g.field)) continue;
    const cells = new Set();
    for (const [x, z, y0, y1] of g.cells ?? []) for (let y = y0; y <= y1; y++) cells.add(k3(x, y, z));
    out.push({ lot: l.id, box: l.box, floorY: l.floorY, field: { x0: g.field[0], z0: g.field[1], x1: g.field[2], z1: g.field[3] }, cells, bodies: new Set(g.bodies ?? []) });
  }
  return out;
}
