// (6c slice PT2) A captured source: a player's build adopted as a site (docs/CONTRACT.md "Phase 6c slice PT2" §3).
//
// The mod captures the build's cells (its tracked cells and the air between each footprint column's lowest and highest build cell)
// and writes the entry's version 1 itself (<id>.nbt, <id>.blueprint.json, <id>.parts.nbt) together with a generated <id>.mjs that
// calls `adopted(id, CAPTURE, values)` below. Built with `floors: 0` that source gives back exactly the captured cells: the same
// block states (as the world held them: no property defaults, no reconnected fences) and the same block-entity data (inventories
// were never captured). So `versionOf`'s designer, the renders and the frame guard work on it as on any `.mjs` blueprint.
//
// CAPTURE (format 1), all in template coordinates (the box's minimum corner is 0,0,0; frame origin 0,0,0):
//   { format: 1, build, size: [x, y, z], groundY, front, frameGuessed, palette: ['minecraft:oak_log[axis=y]', ...],
//     runs: [y, z, x0, x1, p, ...]  (runs along x, one palette index each; every captured cell is in exactly one run),
//     nbt: { 'x,y,z': <tagged compound> } (lib/nbt.mjs's {t, v} shape; a long's v is a decimal string),
//     wall: '<state>' (the most used non-air captured state: an added storey's walls; C35: its frame and roof come from the mix too),
//     anchors: { entrance?: {x, y, z, yaw, pitch}, spawn?: ... } (outside the door; none for a guessed front) }
//
// One part, `adopted` (v0, SQ-PT2-3). The param `floors` (default 0) adds storeys on top: the sim's versionOf ("an int param's
// default up by one") then adds a floor, and a designer may do the same. Each storey stands on the old top layer's footprint: a
// ring of walls 4 high, a roof layer, and one hatch cut into the layer below (the first storey's hatch is one of v1's cells).
import { Blueprint } from './kit.mjs';
import { isCube } from './blocks.mjs';

export const ADOPT_FORMAT = 1;
/** Rows one added storey takes: 4 of walls, 1 of roof. */
export const STOREY_H = 5;

/** "minecraft:oak_log[axis=y,waterlogged=false]" -> { name, props } (the mod writes states this way). */
export function parseState(s) {
  const i = s.indexOf('[');
  if (i < 0) return { name: s, props: {} };
  const props = {};
  for (const kv of s.slice(i + 1, s.endsWith(']') ? -1 : undefined).split(',')) {
    if (!kv) continue;
    const j = kv.indexOf('=');
    props[kv.slice(0, j)] = kv.slice(j + 1);
  }
  return { name: s.slice(0, i), props };
}

/** A capture's tagged NBT JSON as kit tags (lib/nbt.mjs): longs come as decimal strings. */
export function tagOf(j) {
  switch (j.t) {
    case 'compound': return { t: 'compound', v: Object.fromEntries(Object.entries(j.v).map(([k, v]) => [k, tagOf(v)])) };
    case 'list': return { t: 'list', of: j.of, v: j.v.map(tagOf) };
    case 'long': return { t: 'long', v: BigInt(j.v) };
    case 'longArray': return { t: 'longArray', v: j.v.map((n) => BigInt(n)) };
    default: return { t: j.t, v: j.v };
  }
}

/** The captured cells: [x, y, z, paletteIndex] for every cell of every run. */
export function cellsOf(cap) {
  const out = [];
  const r = cap.runs;
  for (let i = 0; i + 4 < r.length; i += 5) {
    for (let x = r[i + 2]; x <= r[i + 3]; x++) out.push([x, r[i], r[i + 1], r[i + 4]]);
  }
  return out;
}

/**
 * The blueprint of an adopted entry: the captured cells (part `adopted`), plus `floors` storeys on top. `name`/`description`: the
 * entry's. Throws on a capture of another format.
 */
export function adopted(id, cap, { floors = 0, name, description } = {}) {
  if (cap?.format !== ADOPT_FORMAT) throw new Error(`${id}: a capture of format ${cap?.format} (this kit reads ${ADOPT_FORMAT})`);
  const [sx, sy, sz] = cap.size;
  const n = Math.max(0, Math.floor(floors));
  const bp = new Blueprint({
    id, name: name ?? cap.name ?? id, description: description ?? cap.description ?? '', type: 'adopted', profile: [], tags: ['adopted'],
    size: [sx, sy + n * STOREY_H, sz], origin: [0, 0, 0], groundY: cap.groundY, front: cap.front, approach: false,
  });
  // the source kind (sidecar `sourceKind: "captured"`), and (C35) the palette opt-out: the player's house as built is theirs, so the
  // kit's palette guard (build.mjs loadDesign) lets this source ignore a palette or bible it is given and records it (`paletteIgnored`).
  // An added storey is built of the house's own blocks by role (storeyMaterials), never a palette's.
  bp.captured = true;
  const states = cap.palette.map(parseState);
  const cells = cellsOf(cap);
  bp.part('adopted', (b) => {
    for (const [x, y, z, p] of cells) {
      const nb = cap.nbt?.[`${x},${y},${z}`];
      b.setRaw(x, y, z, states[p], nb ? tagOf(nb) : null);
    }
  });
  for (const [name, a] of Object.entries(cap.anchors ?? {})) bp.anchor(name, a.x, a.y, a.z, a.yaw ?? 0, a.pitch ?? 0);
  if (n > 0) addStoreys(bp, cap, cells, states, n);
  return bp;
}

/**
 * (C35) What an added storey is built of: the captured blocks by role, never a palette (a bible sent with the change is ignored).
 *   wall   `cap.wall` (the mod's most used non-air captured state), else the most used full block
 *   frame  the most used full block in the footprint's corner columns below the top layer (a log hut's corner posts), else wall
 *   roof   the most used full block of the top captured layer, else wall
 * The floor is the old top layer, which stays. Ties: the capture palette's lower index. `corners`: "x,z" keys.
 */
export function storeyMaterials(cap, cells, states, corners) {
  const sy = cap.size[1];
  const mostUsed = (pick) => {
    const n = new Map();
    for (const [x, y, z, p] of cells) if (states[p].name !== 'minecraft:air' && isCube(states[p]) && pick(x, y, z)) n.set(p, (n.get(p) ?? 0) + 1);
    let best;
    for (const [p, c] of n) if (best === undefined || c > n.get(best) || (c === n.get(best) && p < best)) best = p;
    return best === undefined ? undefined : states[best];
  };
  const wall = cap.wall ? parseState(cap.wall) : mostUsed(() => true) ?? { name: 'minecraft:oak_planks', props: {} };
  return {
    wall,
    frame: mostUsed((x, y, z) => y < sy - 1 && corners.has(`${x},${z}`)) ?? wall,
    roof: mostUsed((x, y) => y === sy - 1) ?? wall,
  };
}

/** The storeys: on the top captured layer's footprint, a ring of walls (frame at its corners), a roof, a hatch into the layer below. */
function addStoreys(bp, cap, cells, states, n) {
  const sy = cap.size[1];
  const top = new Set();
  for (const [x, y, z, p] of cells) if (y === sy - 1 && states[p].name !== 'minecraft:air') top.add(`${x},${z}`);
  if (!top.size) return;
  const inF = (x, z) => top.has(`${x},${z}`);
  const ring = (x, z) => !inF(x + 1, z) || !inF(x - 1, z) || !inF(x, z + 1) || !inF(x, z - 1);
  const corner = (x, z) => (!inF(x + 1, z) || !inF(x - 1, z)) && (!inF(x, z + 1) || !inF(x, z - 1));
  const cols = [...top].map((k) => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const m = storeyMaterials(cap, cells, states, new Set(cols.filter(([x, z]) => corner(x, z)).map(([x, z]) => `${x},${z}`)));
  // the hatch: the inner column nearest the footprint's centre (ties: lowest z, then x)
  const cx = cols.reduce((s, c) => s + c[0], 0) / cols.length;
  const cz = cols.reduce((s, c) => s + c[1], 0) / cols.length;
  const inner = cols.filter(([x, z]) => !ring(x, z));
  inner.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz) || a[1] - b[1] || a[0] - b[0]);
  const hatch = inner[0];
  for (let k = 0; k < n; k++) {
    const y0 = sy + k * STOREY_H;
    bp.part(`storey_${k + 1}`, (b) => {
      if (hatch) b.setRaw(hatch[0], y0 - 1, hatch[1], { name: 'minecraft:air', props: {} });
      for (const [x, z] of cols) {
        for (let y = y0; y < y0 + STOREY_H - 1; y++) {
          if (ring(x, z)) b.setRaw(x, y, z, corner(x, z) ? m.frame : m.wall);
          else b.setRaw(x, y, z, { name: 'minecraft:air', props: {} });
        }
        b.setRaw(x, y0 + STOREY_H - 1, z, m.roof);
      }
    });
  }
}
