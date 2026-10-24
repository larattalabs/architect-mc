// (7a CL) The climbs' fittings (docs/CONTRACT.md "Phase 7a slice CL" §3): what T2's own moves don't lay on a stair, a switchback or a
// ladder route. Pure plan-time geometry over a routed edge (the route pass's edge record: path, segments, landings, ladderCols, width),
// written by `emitClimbs` into a links part (the plan compiler's links stage, or a region program's own stage: climbs_demo):
//   - stair rails: every tread, landing or walk cell of the climb beside a drop over 3 gets the rail role at its surface + 1 on the
//     cell beside it (a wall block where the role has one, else its fence), on a support block at the surface (rails: both, every edge
//     cell; none, none: M8's warning stands);
//   - switchback retaining: T2's retaining columns (the land beside standing over 2 higher) in the connectors.switchback.retaining role,
//     capped with the trim's slab (retaining: none keeps T2's);
//   - ladders: a climb of more than `rest` rungs is laid as flights of at most `rest` in alternating face columns; at each break a rest
//     landing, a 2 x 1 ledge (the next flight's column and the one beyond it) on two brackets against the face, railed on its open sides,
//     with a lamp; the top: the rail role 2 cells either side along the cliff edge and a fence gate in the ladder's own cell (top: gate);
//   - lamps (W's fixture, every floor(12 * level / 15) cells along the climb's tread, landing and walk cells, beside them).
// The face rule (§3): every ladder cell needs a sturdy face cell behind it: ROCK or SOIL in the pre-region classes (a frozen volume's
// where the plan holds one, else the 2.5D survey's), or a block the plan wrote under its raise (a program's base). Sand, gravel, ice,
// leaves or air: ANCHOR, naming the cells. Integer math only (the plan-path lint).
import { classAt as volumeClassAt, VOXEL_CLASSES } from '../region/volume.mjs';
import { footprintOf, edgeColumns } from '../region/passes/route.mjs';
import { shapeOf, woodOf } from './style.mjs';
import { variant } from '../kit.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor } from '../region/fixtures.mjs';

export const CLIMB = Object.freeze({ minAscent: 2, railDrop: 3, rest: 24, restMin: 8, restMax: 24, ladderMax: 48, topRail: 2, lampLight: 15 });

const isInt = Number.isInteger;
const DIR4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
const CARD = Object.freeze({ '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' });
const STURDY = new Set(['ROCK', 'SOIL']);

/**
 * The pre-region classes the face rule reads: `volumes` (decoded frozen volumes the plan asked for) where one holds the cell, else the
 * survey's 2.5D classes (soil to 3 under the ground, rock below, air above, water down a water column, MISSING); a cell under the
 * program's raise (`baseAt(x, z)` > 0: the ground a region program raises in an earlier stage) is the plan's own block (WRITTEN).
 */
export function climbLand(S, { volumes = [], baseAt = null } = {}) {
  const vols = (volumes ?? []).filter(Boolean);
  const classAt = (x, y, z) => {
    if (S.missingAt?.(x, z)) return 'MISSING';
    const g = S.groundAt(x, z), b = baseAt ? baseAt(x, z) : 0;
    if (b > 0 && y > g && y <= g + b) return 'WRITTEN';
    for (const v of vols) { const c = volumeClassAt(v, x, y, z); if (c !== 14) return VOXEL_CLASSES[c]; }
    if (y > g + b) return 'AIR';
    if (S.waterAt?.(x, z) && y > S.floorAt(x, z)) return 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const groundAt = (x, z) => S.groundAt(x, z) + (baseAt ? baseAt(x, z) : 0);
  return { classAt, groundAt, sturdy: (x, y, z) => { const c = classAt(x, y, z); return STURDY.has(c) || c === 'WRITTEN'; } };
}

/** The ladder's face direction (toward the wall) from its record's `facing` (the ladder faces away from its wall). */
export function faceDir(facing) {
  return facing === 'west' ? [1, 0] : facing === 'east' ? [-1, 0] : facing === 'north' ? [0, 1] : [0, -1];
}

/**
 * A ladder column's plan: its flights (at most `rest` rungs each, alternating between the column `A` T2 chose (lc.x, lc.z) and the side
 * column `B` along the face, `side` +1 or -1) and rest landings. The flights alternate so that the last one is in A (the route's top
 * walk cell stands in front of A): with an even number of flights the first is in B, whose foot the climber reaches by a side step.
 * Returns `{flights: [{x, z, y0, y1}], landings: [{y (feet), deck: [[x, z], [x, z]], brackets: [[x, y, z]], rails: [[x, z]], faces}],
 * faces: [[x, y, z]] (every rung's face cell), rungs, startB}`.
 */
export function ladderPlan(lc, rest, side) {
  const [fx, fz] = faceDir(lc.facing), rx = -fz * side, rz = fx * side;
  const rungs = lc.y1 - lc.y0 + 1;
  const ranges = [];
  for (let y = lc.y0; y <= lc.y1;) { const top = Math.min(lc.y1, y + rest - 1); ranges.push([y, top]); y = top + 1; }
  const start = (ranges.length - 1) % 2;
  const cols = [[lc.x, lc.z], [lc.x + rx, lc.z + rz]];
  const flights = [], landings = [], faces = [];
  ranges.forEach(([y0, y1], k) => {
    const [cx, cz] = cols[(start + k) % 2];
    flights.push({ x: cx, z: cz, y0, y1 });
    for (let t = y0; t <= y1; t++) faces.push([cx + fx, t, cz + fz]);
    if (k === ranges.length - 1) return;
    // the landing: bottom slabs at this flight's top rung in the next flight's column and the one beyond it (away from this column)
    const [nx, nz] = cols[(start + k + 1) % 2];
    const away = [nx - cx, nz - cz];
    const deck = [[nx, nz], [nx + away[0], nz + away[1]]];
    // its open sides: outward (away from the face) of both deck cells, the far end beyond the second, and that corner
    const rails = [[deck[0][0] - fx, deck[0][1] - fz], [deck[1][0] - fx, deck[1][1] - fz], [deck[1][0] + away[0], deck[1][1] + away[1]], [deck[1][0] + away[0] - fx, deck[1][1] + away[1] - fz]];
    landings.push({ y: y1 + 1, deck, brackets: deck.map(([x, z]) => [x, y1, z]), rails, faces: deck.map(([x, z]) => [x + fx, y1, z + fz]) });
  });
  return { flights, landings, faces, rungs, startB: start === 1, B: cols[1] };
}

/** A role's block in a shape (wall, fence, slab, stairs, fence_gate), with a fallback chain. */
const shaped = (block, ...shapes) => { for (const s of shapes) { const v = s === 'self' ? block : shapeOf(block, s); if (v) return v; } return null; };

/** The fence gate of a rail block (its wood family's, else oak's), facing `f`, closed. */
function gateOf(railBlock, f) {
  const w = woodOf(railBlock);
  const g = (w && variant(`minecraft:${w}_planks`, 'fence_gate')) || 'minecraft:oak_fence_gate';
  return `${g.replace(/\[.*$/, '')}[facing=${f},in_wall=false,open=false,powered=false]`;
}

/**
 * The fittings of one routed climb edge, as cells `[[x, y, z, state, what]]` (what: rail, support, cap, retain, ladder, air, deck, bracket,
 * gate, lamp) plus its records. `e`: the route pass's edge record; `o`: {kind, rails ('drops' | 'both' | 'none'), retaining ('plain' |
 * 'none'), rest (8..24), top ('gate' | 'open'), lamps (bool), roles: {rail, support, retain, cap, landing, light, post}}, `land`
 * (climbLand), `taken(x, z)` (a column another writer holds: true for a lot or a kept column, another walk's surface y, else false), `side` (a ladder's lateral side, or
 * null to choose). Throws 'ANCHOR: ...' (with .evidence) when a ladder cell has no sturdy face.
 */
export function climbCells(e, o, land, { taken = () => false } = {}) {
  const out = [], meta = { flights: 0, hairpins: 0, ladders: [], rails: 0, caps: 0, lamps: 0, gates: 0 };
  const own = new Set();
  for (const g of e.segments) if (!g.shared) for (const q of footprintOf(e.path.slice(g.from, g.to + 1), e.width)) own.add(`${q[0]},${q[1]}`);
  for (const l of e.landings ?? []) for (const [x, z] of l.cells) own.add(`${x},${z}`);
  const ec = edgeColumns({ path: e.path, segments: e.segments, landings: e.landings ?? [], width: e.width });
  meta.flights = e.segments.filter((g) => g.kind === 'stair').length;
  meta.hairpins = e.segments.filter((g) => g.kind === 'landing').length;
  const put = (x, y, z, s, what) => { out.push([x, y, z, s, what]); };
  const used = new Set();
  // ---- rails beside drops (stair, landing and walk cells alike: the climb's whole footprint)
  // (`unsafe.noRails`: the broken variant, a stair that skips its rails while claiming them; M8:climb catches it)
  if (o.rails !== 'none' && !o.unsafe?.noRails) {
    for (const c of ec.cols) {
      if (!c.edge || e.segments[c.seg]?.shared) continue;
      for (const [dx, dz] of DIR4) {
        const ox = c.x + dx, oz = c.z + dz, k = `${ox},${oz}`;
        // (a column another walk holds: railed only over it, when its surface stands more than 4 under this tread: the rail and its
        // support then stand over that walk's head room)
        const tk = taken(ox, oz);
        if (own.has(k) || used.has(k) || tk === true || (typeof tk === 'number' && c.y - tk <= CLIMB.railDrop + 1)) continue;
        const drop = c.y - Math.max(land.groundAt(ox, oz), typeof tk === 'number' ? tk : -Infinity);
        if (!(o.rails === 'both' ? drop >= 0 : drop > CLIMB.railDrop)) continue;
        used.add(k);
        if (drop > 0) put(ox, c.y, oz, o.roles.support, 'support');
        put(ox, c.y + 1, oz, o.roles.rail, 'rail');
        meta.rails++;
      }
    }
  }
  // ---- switchback retaining: T2's columns (the land beside over 2 higher), in the role, capped with the trim's slab
  if (o.kind === 'switchback' && o.retaining !== 'none') {
    const seen = new Set();
    for (const c of ec.cols) {
      if (!c.edge || e.segments[c.seg]?.shared) continue;
      for (const [dx, dz] of DIR4) {
        const ox = c.x + dx, oz = c.z + dz, k = `${ox},${oz}`;
        if (own.has(k) || seen.has(k) || taken(ox, oz)) continue;
        const g = land.groundAt(ox, oz);
        if (g - c.y <= 2) continue;
        seen.add(k);
        if (o.roles.retain) put(ox, c.y + 1, oz, o.roles.retain, 'retain'), out[out.length - 1].push(g); // (y1 = the land: a column)
        if (o.roles.cap) { put(ox, g + 1, oz, o.roles.cap, 'cap'); meta.caps++; }
      }
    }
  }
  // ---- ladders: flights, rest landings, the face rule, the top
  for (const lc of e.ladderCols ?? []) {
    const rungs = lc.y1 - lc.y0 + 1;
    const rest = o.rest ?? CLIMB.rest;
    let plan = null, bad = null;
    for (const side of [1, -1]) {
      const p = ladderPlan(lc, rest, side);
      const faceBad = p.faces.filter(([x, y, z]) => !land.sturdy(x, y, z));
      // a landing's deck stands in the open, its brackets against the face (a sturdy face cell behind each)
      const deckBad = p.landings.some((l) => l.deck.some(([x, z]) => (!(x === lc.x && z === lc.z) && (own.has(`${x},${z}`) || taken(x, z))) || land.groundAt(x, z) >= l.y - 1)); // (A, the ladder's own column, may hold a deck)
      const brBad = p.landings.flatMap((l) => l.faces.filter(([x, y, z]) => !land.sturdy(x, y, z) || !land.sturdy(x, y - 1, z)));
      // the first flight in B: the climber side-steps from A's foot to B's, level
      const topBad = p.startB && (land.groundAt(p.B[0], p.B[1]) !== lc.y0 - 1 || own.has(`${p.B[0]},${p.B[1]}`) || taken(p.B[0], p.B[1]));
      if (topBad) { if (!bad) bad = { cells: [], deck: true }; continue; }
      if (!faceBad.length && !deckBad && !brBad.length) { plan = p; break; }
      if (!bad || faceBad.length + brBad.length < bad.cells.length) bad = { cells: [...faceBad, ...brBad], deck: deckBad };
      if (!p.landings.length) { bad = { cells: faceBad, deck: false }; break; } // (one flight: the side does not matter)
    }
    if (!plan) {
      const cells = bad.cells.slice(0, 16);
      const err = new Error(`ANCHOR: the ladder at ${lc.x}, ${lc.z} (${rungs} rungs) has ${bad.cells.length ? `${bad.cells.length} face cell(s) that are not sturdy (rock, soil or the plan's block): ${cells.map((q) => q.join(' ')).join('; ')}` : 'no room for its rest landings beside the face'}`);
      err.evidence = { at: [lc.x, lc.y0, lc.z], rungs, cells, classes: cells.map(([x, y, z]) => land.classAt(x, y, z)) };
      throw err;
    }
    const [fx, fz] = faceDir(lc.facing);
    const ladderState = `minecraft:ladder[facing=${lc.facing},waterlogged=false]`;
    // T2 wrote the whole column at A (lc.x, lc.z): each rung whose flight stands in B is air at A and a ladder at B, with head room
    // over each flight's top rung in its own column (T2 cleared A's over the top)
    // (every rung is written here, A's too: T2's own column op writes only natural cells, so the walk's cut at A's foot left its lowest
    // rungs air)
    for (const f of plan.flights) {
      const inA = f.x === lc.x && f.z === lc.z;
      for (let y = f.y0; y <= f.y1; y++) { if (!inA) put(lc.x, y, lc.z, null, 'air'); put(f.x, y, f.z, ladderState, 'ladder'); }
      if (!inA) { put(f.x, f.y1 + 1, f.z, null, 'air'); put(f.x, f.y1 + 2, f.z, null, 'air'); }
    }
    for (const l of plan.landings) {
      for (const [x, z] of l.deck) put(x, l.y - 1, z, o.roles.landing, 'deck');
      for (const [x, y, z] of l.brackets) put(x, y - 1, z, o.roles.bracket, 'bracket');
      for (const [x, z] of l.rails) { put(x, l.y - 1, z, o.roles.rail, 'rail'); put(x, l.y, z, o.roles.rail, 'rail'); }
      // the landing's lamp: a lantern on its far rail post
      if (o.lamps !== false && o.roles.light) { const [x, z] = l.rails[2]; put(x, l.y + 1, z, o.roles.light, 'lamp'); meta.lamps++; }
    }
    // the top: the cliff-top walk cell in front of the top rung (the last flight is in A) stands over the drop
    const tx = lc.x + fx, tz = lc.z + fz, ty = lc.y1 + 1;
    let gate = null;
    const topRails = [];
    if (o.top !== 'open') {
      gate = [tx, ty, tz];
      // (`unsafe.noGate`: the broken variant, the gate recorded but not written; M10:climb catches it)
      if (!o.unsafe?.noGate) put(tx, ty, tz, gateOf(o.roles.railBlock ?? 'minecraft:oak_fence', CARD[`${fx},${fz}`]), 'gate');
      meta.gates++;
      const [rx, rz] = [-fz, fx];
      for (const s of [1, -1]) for (let t = 1; t <= CLIMB.topRail; t++) {
        const x = tx + rx * s * t, z = tz + rz * s * t;
        if (own.has(`${x},${z}`) || taken(x, z) || land.groundAt(x, z) !== lc.y1) break;
        // only along the edge: the cell in front (toward the ladder's side) is a drop
        if (lc.y1 - land.groundAt(x - fx, z - fz) < 2) break;
        put(x, ty, z, o.roles.rail, 'rail');
        topRails.push([x, ty, z]);
      }
    }
    meta.ladders.push({ at: [lc.x, lc.y0, lc.z], rungs, landings: plan.landings.length, flights: plan.flights.map((f) => ({ ...f })), rest: plan.landings.map((l) => ({ y: l.y, deck: l.deck.map((q) => [...q]) })), top: gate, topRails, facing: lc.facing });
  }
  return { cells: out, meta };
}

/**
 * Lamp spots along a climb (W's fixture, every `every` path cells over its tread, landing and walk cells): a lantern on a post beside
 * the footprint, on whichever side stands open (the post on a support where the ground falls away). `[[x, y, z, state, what]]`.
 */
export function climbLamps(e, land, { every = 12, light, post, support, taken = () => false, skip = new Set(), rails = new Map() } = {}) {
  const out = [], lit = new Set();
  const lo = -Math.floor((e.width - 1) / 2) - 1, hi = Math.floor(e.width / 2) + 1;
  const own = new Set();
  for (const g of e.segments) for (const q of footprintOf(e.path.slice(g.from, g.to + 1), e.width)) own.add(`${q[0]},${q[1]}`);
  for (const l of e.landings ?? []) for (const [x, z] of l.cells) own.add(`${x},${z}`);
  let since = Math.floor(every / 2);
  for (let i = 0; i < e.path.length; i++) {
    const g = e.segments.find((s) => i >= s.from && i <= s.to);
    if (g?.shared) continue;
    if (++since < every) continue;
    const [x, y, z] = e.path[i];
    const nb = e.path[Math.min(e.path.length - 1, i + 1)], pv = e.path[Math.max(0, i - 1)];
    const ax = Math.abs(nb[0] - pv[0]) >= Math.abs(nb[2] - pv[2]) ? [0, 1] : [1, 0];
    for (const v of [hi, lo]) {
      const qx = x + ax[0] * v, qz = z + ax[1] * v, k = `${qx},${qz}`;
      // a rail beside the walk carries the lamp on its top (a ridge's stair has no ground beside it for a post)
      if (rails.has(k) && !lit.has(k)) { const ry = rails.get(k); out.push([qx, ry + 1, qz, light, 'lamp']); lit.add(k); since = 0; break; }
      if (own.has(k) || taken(qx, qz) || skip.has(k)) continue;
      const gq = land.groundAt(qx, qz);
      if (gq > y + 1) continue; // (a cut: the bank stands over the post)
      if (gq < y) out.push([qx, y, qz, support, 'support']);
      out.push([qx, y + 1, qz, post, 'post'], [qx, y + 2, qz, light, 'lamp']);
      skip.add(k);
      since = 0;
      break;
    }
  }
  return out;
}

/** A routed edge's walk columns: "x,z" -> its surface y (the footprint and the hairpin landings). */
export function walkCols(e) {
  const m = new Map();
  for (const g of e.segments ?? []) if (!g.shared) for (const q of footprintOf(e.path.slice(g.from, g.to + 1), e.width)) if (!m.has(`${q[0]},${q[1]}`)) m.set(`${q[0]},${q[1]}`, q[2]);
  for (const l of e.landings ?? []) for (const [x, z] of l.cells) m.set(`${x},${z}`, l.y);
  return m;
}

/**
 * Emit the climbs' fittings of routed edges into part `part` (stage `stage`): `edges` the route pass's edge records, `opts` per edge id
 * ({kind, rails, retaining, rest, top, lamps}), `land` (climbLand), `taken`. Writes under the caller's checkpoint; returns per edge
 * `{edge, cells, meta, bom}`. The fittings' records go to r.meta.climbs (the siteplan's climbs rows) with the part id `meta.part`.
 */
export function emitClimbs(r, edges, { opts, stage, part = 'links_climbs', land, taken = () => false, recPart = null, kept = null } = {}) {
  const res = [];
  const roles = climbRoles(r);
  // (the other edges passed together keep their footprints and landings: no fitting of one lands on another's walk)
  const fps = new Map(edges.filter((e) => e?.ok).map((e) => [e.id, walkCols(e)]));
  const takenBut = (id) => (x, z) => { const t = taken(x, z); if (t !== false && t !== null && t !== undefined) return t; for (const [k, m] of fps) if (k !== id && m.has(`${x},${z}`)) return m.get(`${x},${z}`); return false; };
  for (const e of edges) {
    if (!e?.ok) continue;
    const taken0 = takenBut(e.id);
    const o = { rails: 'drops', retaining: 'plain', rest: CLIMB.rest, top: 'gate', lamps: true, ...(opts?.[e.id] ?? {}), roles };
    const { cells, meta } = climbCells(e, o, land, { taken: taken0 });
    const lamps = o.lamps === false ? [] : climbLamps(e, land, { every: Math.max(4, Math.floor((12 * levelOf(roles.light)) / 15)), light: roles.light, post: roles.post, support: roles.support, taken: taken0, skip: new Set(cells.filter((c) => c[4] === 'rail' || c[4] === 'support').map((c) => `${c[0]},${c[2]}`)), rails: new Map(cells.filter((c) => c[4] === 'rail' && c.length === 5).map((c) => [`${c[0]},${c[2]}`, c[1]])) });
    // ((6c KC, §5) a fluid body's cells are its own: a rail, support, lamp or cap never lands in its hard or watch sets (skipped); the
    // treads, as streets, are the route's: KC's rule there)
    const inBody = (c) => { if (!kept) return null; for (let y = c[1]; y <= (c.length > 5 ? c[5] : c[1]); y++) { const k = kept(c[0], y, c[2]); if (k) return { ...k, at: [c[0], y, c[2]] }; } return null; };
    // ((6c KC, §5) a ladder's rungs, its rest landings (decks, brackets) and its top gate are never skipped: one in a body's sets refuses
    // the part OVERLAP {kind: body} (whoever is placed later keeps clear, S-KC-1)
    for (const c of [...cells]) {
      if (!['ladder', 'deck', 'bracket', 'gate'].includes(c[4])) continue;
      const k = inBody(c);
      if (!k) continue;
      const err = new Error(`OVERLAP: the ladder's ${c[4]} at ${k.at.join(' ')} lands in body ${k.body} (${k.set}) of part ${k.part}`);
      err.evidence = { kind: 'body', body: k.body, part: k.part, set: k.set, at: k.at, what: c[4] };
      throw err;
    }
    const all = [...cells, ...lamps].filter((c) => !(['rail', 'support', 'lamp', 'post', 'cap', 'retain'].includes(c[4]) && inBody(c)));
    meta.lamps += lamps.filter((c) => c[4] === 'lamp').length;
    if (all.length) {
      const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage, set: 'path' });
      const mats = [], idx = new Map();
      const mi = (s) => { const k = s ?? 'air'; if (!idx.has(k)) { idx.set(k, mats.length); mats.push(s); } return idx.get(k); };
      const cols = [];
      for (const c of all) {
        const y1 = c.length > 5 ? c[5] : c[1];
        cols.push(c[0], c[2], c[1], y1, mi(c[3]));
      }
      p.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: 3 });
    }
    const written = all.filter((c) => c[3] !== null).flatMap((c) => { const n = (c.length > 5 ? c[5] : c[1]) - c[1] + 1; return Array.from({ length: n }, () => c[3]); });
    const rec = { id: `climb_${e.id}`.slice(0, 48), part: recPart ?? e.id, kind: o.kind, edge: e.id, flights: meta.flights, hairpins: meta.hairpins, ladders: meta.ladders.map((l) => ({ at: l.at, rungs: l.rungs, landings: l.landings })), rails: meta.rails, caps: meta.caps, lamps: meta.lamps, gates: meta.gates, detail: meta.ladders, rest: o.rest, railsMode: o.rails,
      // (the checker reads the climb's own route: meta.route holds only the last pass's edges)
      route: { path: e.path.map((q) => [...q]), segments: e.segments.map((g) => ({ kind: g.kind, from: g.from, to: g.to, ...(g.shared ? { shared: true } : {}) })), width: e.width, landings: (e.landings ?? []).map((l) => ({ cells: l.cells.map((q) => [...q]), y: l.y })) } };
    (r.meta.climbs ??= []).push(rec);
    res.push({ edge: e.id, cells: all, meta, rec, bom: bomOf(written) });
  }
  return res;
}

const levelOf = (s) => (/lantern|torch|glowstone|sea_lantern|shroomlight|froglight|lamp/.test(String(s)) ? 15 : 15);

/** The fittings' blocks from the plan's roles (the bible's connectors member resolved: ctx.connectors), with each one's fallback. */
export function climbRoles(r) {
  const c = r.ctx?.connectors ?? {};
  const role = (slot, chain) => { for (const x of [slot, ...chain]) if (x && r.roles?.[x]) return r.roles[x]; return null; };
  const railBlock = role(c.stair?.rail, ['rail']) ?? 'minecraft:oak_fence';
  const rail = shaped(railBlock, 'wall', 'fence', 'self');
  const support = role(null, ['foundation', 'structure']) ?? 'minecraft:cobblestone';
  const retain = role(c.switchback?.retaining, ['structure', 'foundation']);
  const trim = role(null, ['trim']);
  const cap = trim ? shaped(trim, 'slab') : null;
  const floor = role(c.ladder?.landing, ['floor']) ?? 'minecraft:oak_planks';
  const landing = shaped(floor, 'slab', 'self');
  const ladderRail = role(c.ladder?.rail, ['rail']) ?? railBlock;
  // W's fixture for the light role, stood on a post (a hanging lantern stands; a sea lantern or glowstone is a bollard block)
  const fx = fixtureFor(r.roles?.light, railBlock);
  const light = fx.kind === 'hanging_lantern' ? fx.light.replace('hanging=true', 'hanging=false') : fx.light;
  return { rail, railBlock: role(c.ladder?.gate, ['rail']) ?? railBlock, support, retain, cap: cap ? `${cap.replace(/\[.*$/, '')}[type=bottom,waterlogged=false]` : null,
    landing: landing && /_slab/.test(landing) ? `${landing.replace(/\[.*$/, '')}[type=bottom,waterlogged=false]` : landing, bracket: shaped(ladderRail, 'fence', 'self'),
    light, post: shaped(railBlock, 'fence', 'self') };
}

void isInt;
