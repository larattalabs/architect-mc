// Slice 0b (docs/CONTRACT.md "Phase 6c slice 0b" §2.2, lever 3): mirror a built Blueprint left-right across its front axis,
// so `front` is unchanged. A north or south front flips x (vanilla Mirror.FRONT_BACK); an east or west front flips z
// (Mirror.LEFT_RIGHT). Every written cell, its block state (as vanilla's BlockState.mirror), its part, the anchors and
// cameras (position and yaw), the ports and the interior box are mapped; the approach is built from the entrance anchor,
// so it follows. Placement code is untouched: the mirror is baked into the template.
//
// The block-state table is rules on property names and values; kit/test/mirror.test.mjs compares it with vanilla's
// (kit/test/fixtures/mirror-oracle.json, written by the mod's MirrorOracleTest) for every state of every block.

/** The vanilla Mirror a front uses: 'x' (FRONT_BACK, x flips) for north/south, 'z' (LEFT_RIGHT, z flips) for east/west. */
export function mirrorAxisOf(front) {
  return front === 'east' || front === 'west' ? 'z' : 'x';
}

const SWAP = {
  x: { east: 'west', west: 'east' },
  z: { north: 'south', south: 'north' },
};

/** A direction value mirrored (the six directions; others unchanged). */
export function mirrorDir(d, axis) {
  return SWAP[axis][d] ?? d;
}

/** Underscore-separated direction words swapped (`ascending_east`, `south_west`, `north_up`). */
function swapWords(v, axis) {
  return v.split('_').map((w) => SWAP[axis][w] ?? w).join('_');
}

const LR = { left: 'right', right: 'left' };
const RAIL_SHAPES = new Set(['north_south', 'east_west', 'ascending_east', 'ascending_west', 'ascending_north', 'ascending_south', 'south_east', 'south_west', 'north_west', 'north_east']);
/** blocks with direction properties that vanilla does not mirror (no BlockState.mirror override) */
const UNMIRRORED = new Set(['anvil', 'chipped_anvil', 'damaged_anvil', 'chorus_plant', 'fire']);
const HORIZONTAL = new Set(['north', 'south', 'east', 'west']);
/** the axis a horizontal direction runs along */
const axisOfDir = (d) => (d === 'east' || d === 'west' ? 'x' : d === 'north' || d === 'south' ? 'z' : 'y');

/**
 * A block state's properties mirrored (vanilla BlockState.mirror). `name` is the block id (minecraft:...), `props` its
 * full property map (strings). Returns a new object.
 */
export function mirrorProps(name, props, axis) {
  if (!props || !Object.keys(props).length) return { ...(props ?? {}) };
  const base = name.replace(/^minecraft:/, '');
  // blocks without a mirror of their own in vanilla (Block.mirror is the identity)
  if (UNMIRRORED.has(base)) return { ...props };
  const out = {};
  // connection-style properties named by direction: swap the pair
  for (const [k, v] of Object.entries(props)) out[SWAP[axis][k] ?? k] = v;
  const facing = props.facing;
  for (const [k, v] of Object.entries(props)) {
    if (k === 'facing' || k === 'orientation') out[k] = swapWords(v, axis);
    else if (k === 'rotation') {
      const r = Number(v);
      out[k] = String(axis === 'x' ? (16 - r) % 16 : (24 - r) % 16);
    } else if (k === 'shape' && /^(ascending_|north_|south_|east_|west_)/.test(v)) {
      // rails: north_south and east_west stay (their swap is no rail shape)
      const w = swapWords(v, axis);
      out[k] = RAIL_SHAPES.has(w) ? w : v;
    } else if (k === 'hinge') out[k] = LR[v] ?? v;
  }
  // stairs: vanilla flips a corner's handedness only when the facing lies along the mirrored axis, and with FRONT_BACK
  // only the outer corners (its inner corners keep their hand: vanilla's own table, matched as it is). A double chest's
  // half and a shelf's chain side never change.
  const along = !!facing && HORIZONTAL.has(facing) && axisOfDir(facing) === axis;
  if (along && /_stairs$/.test(base) && typeof props.shape === 'string') {
    const m = /^(inner|outer)_(left|right)$/.exec(props.shape);
    if (m && (axis === 'z' || m[1] === 'outer')) out.shape = `${m[1]}_${LR[m[2]]}`;
  }
  return out;
}

/**
 * Mirror a Blueprint in place across its front axis (template coordinates; the origin stays). Call it after the design
 * has written everything; `finalize()` (run by entries()) recomputes the pane, fence and wall connections afterwards.
 */
export function mirrorBlueprint(bp, axis = mirrorAxisOf(bp.front)) {
  const S = axis === 'x' ? bp.size.x : bp.size.z;
  const flipCell = (x, y, z) => (axis === 'x' ? [S - 1 - x, y, z] : [x, y, S - 1 - z]);
  const cells = new Map();
  const parts = new Map();
  for (const [k, c] of bp.cells) {
    const [x, y, z] = k.split(',').map(Number);
    const nk = flipCell(x, y, z).join(',');
    cells.set(nk, { state: { name: c.state.name, props: mirrorProps(c.state.name, c.state.props, axis) }, nbt: c.nbt });
    const part = bp.cellPart.get(k);
    if (part) parts.set(nk, part);
  }
  bp.cells = cells;
  bp.cellPart = parts;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const yaw = (y) => {
    let v = axis === 'x' ? -y : 180 - y;
    while (v > 180) v -= 360;
    while (v <= -180) v += 360;
    return r3(v) === -0 ? 0 : r3(v);
  };
  for (const a of Object.values(bp.anchors)) {
    if (axis === 'x') a.x = r3(S - a.x);
    else a.z = r3(S - a.z);
    a.yaw = yaw(a.yaw);
  }
  bp.ports = bp.ports.map((p) => {
    const [x, y, z] = flipCell(p.x, p.y, p.z);
    return { ...p, x, y, z, facing: mirrorDir(p.facing, axis) };
  });
  if (bp.interiorBox) {
    const b = bp.interiorBox;
    if (axis === 'x') bp.interiorBox = { ...b, minX: S - 1 - b.maxX, maxX: S - 1 - b.minX };
    else bp.interiorBox = { ...b, minZ: S - 1 - b.maxZ, maxZ: S - 1 - b.minZ };
  }
  bp.mirrored = axis;
  return bp;
}

/**
 * A sidecar JSON (`<id>.blueprint.json`, e.g. a massing's) mirrored the same way: the part boxes, anchors, ports and the
 * interior. Used for conformance: a mirrored copy is checked against its archetype's massing mirrored with it.
 */
export function mirrorSidecar(sc, axis = mirrorAxisOf(sc.front)) {
  const out = structuredClone(sc);
  const S = axis === 'x' ? sc.size?.x : sc.size?.z;
  if (!Number.isInteger(S)) return out;
  const i0 = axis === 'x' ? 0 : 2;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  for (const p of Object.values(out.parts ?? {})) {
    if (!Array.isArray(p.box) || p.box.length !== 6) continue;
    const lo = p.box[i0];
    const hi = p.box[i0 + 3];
    p.box[i0] = S - 1 - hi;
    p.box[i0 + 3] = S - 1 - lo;
  }
  for (const a of Object.values(out.anchors ?? {})) {
    if (axis === 'x') a.x = r3(S - a.x);
    else a.z = r3(S - a.z);
    if (typeof a.yaw === 'number') {
      let v = axis === 'x' ? -a.yaw : 180 - a.yaw;
      while (v > 180) v -= 360;
      while (v <= -180) v += 360;
      a.yaw = r3(v) === 0 ? 0 : r3(v);
    }
  }
  if (Array.isArray(out.ports)) for (const p of out.ports) {
    if (axis === 'x') p.x = S - 1 - p.x;
    else p.z = S - 1 - p.z;
    p.facing = mirrorDir(p.facing, axis);
  }
  if (out.interior) {
    const k = axis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
    const [lo, hi] = [out.interior[k[0]], out.interior[k[1]]];
    out.interior[k[0]] = S - 1 - hi;
    out.interior[k[1]] = S - 1 - lo;
  }
  return out;
}
