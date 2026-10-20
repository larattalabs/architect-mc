// (6c IRR, S-IRR-2) A lot design's reserved cells: cells of the lot the design must leave as given (an irrigated farm's water, its bed,
// its farmland sides and the air over it: the artifact's lots[].irrigation.lotCells). The design checker (check.mjs, `opts.reserved`)
// refuses a design that puts a non-air block on one, placed as the realise places it.
//
// The frame (irrigate.mjs lotFrame): the lot seen with its front to the south (+z): u across (u = 0 the left seen from the street), v
// from the back (v = depth - 1 the front row), y from the lot's floor (0 the field's level). `reserved`: {front (the lot's real front:
// north | east | south | west), size: [width, depth] (in the frame), cells: [[u, y, v], ...]}.
//
// Where a design lands (LotFitting.fit with the lot's box, centred, setback 0, the entrance into the street): turned so its front faces
// the lot's front, its footprint centred across the lot (floor((W - w) / 2) from the west or north edge, which in the frame is floor for
// a south or west front and ceil for a north or east one), its front face on the front row, its groundY row on the floor.

const DIRS = ['north', 'east', 'south', 'west'];

/** Clockwise quarter turns that make `front` face `wanted` (BlueprintTransform.turnsToFace). */
export function turnsToFace(front, wanted) {
  const f = DIRS.indexOf(String(front).toLowerCase()), w = DIRS.indexOf(String(wanted).toLowerCase());
  if (f < 0 || w < 0) throw new Error(`bad direction ${front} / ${wanted}`);
  return (((w - f) % 4) + 4) % 4;
}

/** A template-local block (bx, bz) in a template of size (sx, sz) after `turns` (BlueprintTransform.rotateBlock). */
export function rotateBlock(bx, bz, sx, sz, turns) {
  switch (((turns % 4) + 4) % 4) {
    case 1: return [sz - 1 - bz, bx];
    case 2: return [sx - 1 - bx, sz - 1 - bz];
    case 3: return [bz, sx - 1 - bx];
    default: return [bx, bz];
  }
}

/**
 * A design's template cell in the lot's frame: `t` {size: [sx, sy, sz], groundY, front} (the design's sidecar), `r` the reserved object.
 * Returns [u, y, v].
 */
export function templateToFrame(bx, by, bz, t, r) {
  const turns = turnsToFace(t.front ?? 'south', 'south');
  const [sx, , sz] = t.size;
  const rsx = turns & 1 ? sz : sx, rsz = turns & 1 ? sx : sz;
  const [W, D] = r.size;
  const ceil = r.front === 'north' || r.front === 'east';
  const u0 = ceil ? Math.ceil((W - rsx) / 2) : Math.floor((W - rsx) / 2);
  const v0 = D - rsz;
  const [rx, rz] = rotateBlock(bx, bz, sx, sz, turns);
  return [u0 + rx, by - (t.groundY ?? 0), v0 + rz];
}

/** Validate a reserved object (the checker's --reserved): throws on a malformed one. Returns it normalised. */
export function parseReserved(o) {
  if (!o || typeof o !== 'object') throw new Error('reserved must be {front, size: [width, depth], cells: [[u, y, v], ...]}');
  if (!DIRS.includes(o.front)) throw new Error(`reserved.front must be ${DIRS.join(', ')}`);
  if (!Array.isArray(o.size) || o.size.length !== 2 || !o.size.every((v) => Number.isInteger(v) && v >= 1 && v <= 256)) throw new Error('reserved.size must be [width, depth]');
  if (!Array.isArray(o.cells) || o.cells.length > 65536 || !o.cells.every((c) => Array.isArray(c) && c.length === 3 && c.every(Number.isInteger))) throw new Error('reserved.cells must be [[u, y, v], ...] integers (at most 65536)');
  return { front: o.front, size: [...o.size], cells: o.cells.map((c) => [...c]) };
}

/**
 * The reserved cells a design writes: `blocks` [[x, y, z, name], ...] (its template's non-air cells; air is fine: the realise drops
 * it there too), `t` the sidecar, `r` the reserved object. Returns [{at: [u, y, v], template: [x, y, z], block}].
 */
export function reservedHits(blocks, t, r) {
  const want = new Set(r.cells.map((c) => c.join(',')));
  const out = [];
  for (const [x, y, z, name] of blocks) {
    if (/(^|:)(air|cave_air|void_air|structure_void)$/.test(String(name))) continue;
    const f = templateToFrame(x, y, z, t, r);
    if (want.has(f.join(','))) out.push({ at: f, template: [x, y, z], block: name });
  }
  return out;
}

/** The inverse of templateToFrame: a frame cell [u, y, v] as the design's template cell [x, y, z] (it may fall outside the template). */
export function frameToTemplate(u, y, v, t, r) {
  const turns = turnsToFace(t.front ?? 'south', 'south');
  const [sx, , sz] = t.size;
  const rsx = turns & 1 ? sz : sx, rsz = turns & 1 ? sx : sz;
  const [W, D] = r.size;
  const ceil = r.front === 'north' || r.front === 'east';
  const u0 = ceil ? Math.ceil((W - rsx) / 2) : Math.floor((W - rsx) / 2);
  const rx = u - u0, rz = v - (D - rsz);
  // rotateBlock's inverse: turning back by the same quarter turns the other way
  const back = (4 - turns) % 4;
  const [bx, bz] = rotateBlock(rx, rz, rsx, rsz, back);
  return [bx, y + (t.groundY ?? 0), bz];
}

/**
 * (the sim's stand-in, `build.mjs --leave-reserved`) Leave a built Blueprint's reserved cells: every template cell on one is dropped
 * (air). `bp`: a kit Blueprint (cells keyed "x,y,z" in template coordinates). Returns how many were dropped.
 */
export function leaveReserved(bp, r) {
  const t = { size: [bp.size.x, bp.size.y, bp.size.z], groundY: bp.groundY, front: bp.front };
  let n = 0;
  for (const [u, y, v] of r.cells) {
    const k = frameToTemplate(u, y, v, t, r).join(',');
    if (bp.cells.delete(k)) { bp.cellPart?.delete?.(k); n++; }
  }
  return n;
}
