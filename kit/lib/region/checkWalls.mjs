// (7a K1a) The wall rules of the checker (docs/CONTRACT.md "Phase 7a slice K1" §5), over the plan meta's `walls` (kit/lib/connectors/
// wall.mjs emitWall):
//   M2:wall  (warning) no walk cell under a wall cell but in a gate's opening (no route or network cut); on a closed wall, with the
//            gates' openings blocked, no `player` or `villager` path from inside it to outside it (a terrain bypass included); with the
//            gates open, every walk node reaches across (each side's nodes from the other's) for both movers
//   M8:wall  (warning) every wall column at least `height` above the ground at its foot (block rows: the cap course counts), and at
//            least 2 above any standable ground within 2 of it on either side (half blocks: a jump is 1.25); a tree beside the wall
//            (its trunk, its leaves) is not ground
//   M6       each gate's opening `h` clear (doors and fence gates are passable) over a floor, the walk cell at its y
//   (7a K2) a wall's walk (meta walls[].walk: wallWalk.mjs):
//   M2:walk  (warning) the kit's player mover from the accesses' feet reaches every walk cell (round the whole walk) and each access's
//            landing from its own foot (up), and from the walk every access's foot (down)
//   M8:walk  (warning) every walk cell's edges: a neighbour that is no walk cell is a 1.5 barrier at the feet (the parapet, a rail, a
//            stub's wall), or a drop of at most 3 (the inner edge where the ground is near)
//   M6:walk  2 clear over every walk cell (its head room)
//   M5:walk  0 dark spawnable walk cells (and flight steps)
// An access's cells (its steps, their rail, a ladder, the corbels) are no ground beside the wall for M8:wall (the flight is the way up).
// A joined lot's box is an obstacle to the movers, so a wall that joins one is `provisional` (the answer's). Called by checkRegion
// (check.mjs), which passes `finding`; the virtual world is left as it was found.
import { blockLight, nodeReached, walkGraph, walkNodes } from './check.mjs';
import { F_WALK } from './vworld.mjs';

const key = (x, z) => `${x},${z}`;

/** The highest cell of a column at or under `yMax` for which `pred(idx)` holds: its y, or null. */
function highest(vw, x, z, yMin, yMax, pred) {
  for (let y = yMax; y >= yMin; y--) if (pred(vw.get(x, y, z), y)) return y;
  return null;
}

/** The wall rules: findings and `metrics.walls` ({[id]: {...}}). */
// ((7a K3) `boundLots`: a realised world whose wall lots hold their bound designs: the closure walks through the designs' own blocks (the
// lots on a wall's line are no obstacle boxes then), so their closed outer faces and open passage are what is judged)
export function wallRules({ ir, vw, walls, meta, want, findings, metrics, partStage, finding, boundLots = false }) {
  const P = vw.pal;
  const out = {};
  const claim = vw.claim;
  const light = want.has('M5') ? blockLight(vw) : null;
  for (const w of walls) {
    const part = `w_${w.id}`.slice(0, 48);
    const stage = partStage.get(part) ?? null;
    const m = { cells: w.cells.length, gates: w.gates.length, closed: !!w.closed };
    // ((6c HY-c) a wall's water gates: the grate (iron bars holding the reach's sources) under a lintel is wall to the movers, in the
    // closure below as in the world; counted, never a walk gate)
    if (w.waterGates?.length) m.waterGates = w.waterGates.length;
    const gateCell = new Map();
    for (const g of w.gates) for (const [x, z] of g.cells) gateCell.set(key(x, z), g);
    const wallCell = new Map(w.cells.map((c) => [key(c[0], c[1]), c]));
    // ---- M2:wall, the cut: a walk cell in a wall column that is not a gate's opening; (6c T3b) nor a postern's floor (a tunnel's bore
    // under the wall, with its rock between, counts as a gate: CONTRACT T3 §4)
    const posternFloor = new Set();
    for (const t of meta?.tunnels ?? []) if ((t.posterns ?? []).some((q) => q.wall === w.id)) for (const c of t.floor ?? []) posternFloor.add(`${c[0]},${c[1]},${c[2]}`);
    const cut = [];
    let posternCells = 0;
    for (const [x, z, T] of w.cells) {
      if (gateCell.has(key(x, z))) continue;
      for (let y = T + 2; y >= T - 64 && y > claim.minY; y--) {
        if (!(vw.flags(x, y, z) & F_WALK)) continue;
        if (posternFloor.has(`${x},${y},${z}`)) { posternCells++; continue; }
        cut.push([x, y, z]);
        break;
      }
    }
    if (posternCells) m.posternCells = posternCells;
    m.cut = cut.length;
    if (cut.length && want.has('M2')) findings.push(finding('M2:wall', part, stage, cut.length, cut, `wall ${w.id}: ${cut.length} walk cell(s) under the wall outside its gates (a route or network cut)`));
    // ---- M6 at the gates: `h` clear over each opening cell's walk surface
    const tight = [];
    for (const g of w.gates) for (const [x, z] of g.cells) {
      if (!P.floor[vw.get(x, g.y, z)]) { tight.push([x, g.y, z]); continue; }
      for (let y = g.y + 1; y <= g.y + g.h; y++) if (!P.passable[vw.get(x, y, z)]) { tight.push([x, y, z]); break; }
    }
    m.gateClearance = { cells: w.gates.reduce((n, g) => n + g.cells.length, 0), bad: tight.length };
    if (tight.length && want.has('M6')) findings.push(finding('M6', part, stage, tight.length, tight, `wall ${w.id}: ${tight.length} gate cell(s) without their clear height over a floor`));
    // the ground a mover stands on (the wall's own lamps aside: a post beside a gate is not ground)
    const pi = ir.parts.findIndex((p) => p.id === part);
    const TREE = /_(log|wood|leaves|stem|hyphae)$|mushroom_block$/;
    // ((7a K2) a walk's accesses and corbels: the way up, no terrain beside the wall)
    const accessCol = new Set();
    for (const a of w.walk?.accesses ?? []) { for (const q of a.steps ?? []) accessCol.add(key(q[0], q[2])); for (const q of a.rail ?? []) accessCol.add(key(q[0], q[2])); if (a.cells) accessCol.add(key(a.cells[0], a.cells[2])); }
    for (const q of w.walk?.corbels ?? []) accessCol.add(key(q[0], q[2]));
    const standY = (x, z, yMax, ground = false) => (ground && accessCol.has(key(x, z)) ? null : highest(vw, x, z, yMax - 24, yMax, (i, y) => P.floor[i] && P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)] && !(vw.partAt(x, y, z) === pi && !(vw.flags(x, y, z) & F_WALK)) && !(ground && TREE.test(P.states[i].replace(/\[.*$/, '')))));
    // ---- M5 over the gates' walk cells and the wall's top: 0 dark spawnable cells
    if (light) {
      const dark = [];
      let cells = 0, tops = 0;
      // ((7a K3) a gatehouse's passage is lit by its design, the lot's: not the wall's)
      for (const g of w.gates) if (g.kind !== 'passage') for (const [x, z] of g.cells) { cells++; if (P.spawn[vw.get(x, g.y, z)] && !(light.at(x, g.y + 1, z) > 0)) dark.push([x, g.y + 1, z]); }
      for (const [x, z, T] of w.cells) {
        if (gateCell.has(key(x, z))) continue;
        // the wall's own top (a trunk over it is felled at realise: 6a's rule)
        const y = highest(vw, x, z, T - 4, T + 8, (i, yy) => !P.air[i] && vw.partAt(x, yy, z) === pi);
        if (y === null || !P.spawn[vw.get(x, y, z)] || !P.passable[vw.get(x, y + 1, z)] || !P.passable[vw.get(x, y + 2, z)]) continue;
        tops++;
        if (!(light.at(x, y + 1, z) > 0)) dark.push([x, y + 1, z]);
      }
      m.M5 = { gateCells: cells, spawnableTops: tops, dark: dark.length };
      if (dark.length) findings.push(finding('M5', part, stage, dark.length, dark, `wall ${w.id}: ${dark.length} dark spawnable cell(s) on its gates' walks or its top`));
    }
    // ---- M8:wall: the top over the foot and over the standable ground within 2
    const low = [], bypass = [];
    let footMin = Infinity, overMin = Infinity;
    for (const [x, z, T] of w.cells) {
      if (gateCell.has(key(x, z))) continue;
      const top = highest(vw, x, z, T - 32, T + 8, (i, yy) => (P.solid[i] || P.barrier[i]) && vw.partAt(x, yy, z) === pi);
      if (top === null) { low.push([x, T, z]); continue; }
      const topH2 = 2 * top + Math.round(2 * (P.top[vw.get(x, top, z)] ?? 1));
      let foot = -Infinity, near = -Infinity;
      // the ground beside the column: a tree's trunk or leaves is no ground (the wall fells the trees it writes through, 6a's rule
      // bounded by C31, and leaves the ones beside it standing: they count for neither rule)
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, nz = z + dz;
        if (wallCell.has(key(nx, nz)) && !gateCell.has(key(nx, nz))) continue;
        if (!vw.inClaim(nx, nz)) continue;
        const s = standY(nx, nz, top + 2, true);
        if (s === null) continue;
        const sH2 = 2 * s + Math.round(2 * (P.top[vw.get(nx, s, nz)] ?? 1));
        if (Math.abs(dx) + Math.abs(dz) === 1) { const g = standY(nx, nz, top + 2, true); if (g !== null) foot = Math.max(foot, g); }
        near = Math.max(near, sH2);
      }
      if (foot > -Infinity) { footMin = Math.min(footMin, top - foot); if (top - foot < w.height) low.push([x, top, z]); }
      if (near > -Infinity) { overMin = Math.min(overMin, topH2 - near); if (topH2 - near < 4) bypass.push([x, top, z]); }
    }
    m.M8 = { columns: w.cells.length - gateCell.size, low: low.length, bypass: bypass.length, footMin: footMin === Infinity ? null : footMin, overMinHalfBlocks: overMin === Infinity ? null : overMin };
    if (low.length && want.has('M8')) findings.push(finding('M8:wall', part, stage, low.length, low, `wall ${w.id}: ${low.length} column(s) under ${w.height} above the ground at their foot`));
    if (bypass.length && want.has('M8')) findings.push(finding('M8:wall', part, stage, bypass.length, bypass, `wall ${w.id}: ${bypass.length} column(s) under 2 above a standable cell within 2 (a terrain bypass)`));
    // ---- M2:wall, closure (a closed wall): blocked gates keep every mover in; open gates join both sides
    if (w.closed && w.inside) {
      // ((7a K3) bound: the wall's lots' boxes lifted for the closure, then put back)
      const lifted = boundLots && w.lots?.length ? liftLots(vw, w.lots.map((q) => q.lot)) : null;
      try { m.closure = closure(ir, vw, meta, w, gateCell); } finally { lifted?.(); }
      if (lifted) m.closure.bound = w.lots.map((q) => q.lot);
      if (want.has('M2')) {
        for (const mv of ['player', 'villager']) {
          const c = m.closure[mv];
          if (c.leaks) findings.push(finding('M2:wall', part, stage, c.leaks, c.leakSample, `wall ${w.id}: with its gates blocked, the ${mv} mover gets from inside to outside at ${c.leaks} cell(s)`));
          if (c.across < c.nodes) findings.push(finding('M2:wall', part, stage, c.nodes - c.across, c.missed, `wall ${w.id}: with its gates open, ${c.nodes - c.across} of ${c.nodes} walk node(s) don't reach across by the ${mv} mover`));
        }
      }
      if (w.joined?.length) m.closure.provisional = { joined: w.joined };
      // ((7a K3, §5) the lots on its line: their boxes are unknown openings until their designs bind (the movers treat a box as an
      // obstacle, its passage as a gate))
      if (w.lots?.length) m.closure.provisional = { ...(m.closure.provisional ?? {}), lots: w.lots.map((q) => q.lot) };
    }
    if (w.walk) m.walk = walkRules({ vw, w, part, stage, light, want, findings, finding });
    out[w.id] = m;
  }
  metrics.walls = out;
}

/** (7a K3) The lots `ids` taken out of the virtual world's lot columns (no obstacle boxes); returns the function that puts them back. */
function liftLots(vw, ids) {
  const saved = [];
  for (let i = 0; i < vw.lots.length; i++) {
    if (!ids.includes(vw.lots[i].id)) continue;
    const b = vw.lots[i].box;
    for (let z = b.minZ; z <= b.maxZ; z++) for (let x = b.minX; x <= b.maxX; x++) if (vw.inClaim(x, z)) { const c = vw.colIndex(x, z); if (vw.lotCol[c] === i + 1) { saved.push(c); vw.lotCol[c] = 0; } }
    saved.push(-(i + 1));
  }
  return () => { let li = 0; for (let k = saved.length - 1; k >= 0; k--) { if (saved[k] < 0) li = -saved[k]; else vw.lotCol[saved[k]] = li; } };
}

/**
 * The closure of a closed wall: for the `player` and `villager` movers, the cells reached outside it from inside with the gates'
 * openings blocked (leaks), and with them open the walk nodes of each side reached from the other side's (across / nodes).
 */
export function closure(ir, vw, meta, w, gateCell) {
  const [x0, z0, x1, z1] = w.inside, t = w.thickness;
  const O = { minX: x0 - (t - 1), minZ: z0 - (t - 1), maxX: x1 + (t - 1), maxZ: z1 + (t - 1) };
  const isIn = (x, z) => x > x0 && x < x1 && z > z0 && z < z1;
  const isOut = (x, z) => x < O.minX || x > O.maxX || z < O.minZ || z > O.maxZ;
  // ((7a K3) a cell in a lot on the wall's line (its design's rooms, bound) is neither in nor out: a leak is a cell outside them all)
  const lotBoxes = (w.lots ?? []).map((q) => q.box);
  const inLot = (x, z) => lotBoxes.some((b) => x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5]);
  // the walk nodes (lot entrances and anchors) and the probes: the cells just inside and just outside each gate
  const nodes = walkNodes(ir, meta, null).map((n) => n.at);
  const probes = { in: [], out: [] };
  for (const g of w.gates) for (const [x, z] of g.cells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz;
    if (isIn(nx, nz)) probes.in.push([nx, g.y + 1, nz]);
    else if (isOut(nx, nz)) probes.out.push([nx, g.y + 1, nz]);
  }
  const inside = [...nodes.filter(([x, , z]) => isIn(x, z)), ...probes.in], outside = [...nodes.filter(([x, , z]) => isOut(x, z)), ...probes.out];
  const res = {};
  // the gates' openings blocked (restored after)
  const P = vw.pal, stone = P.of('minecraft:stone');
  const saved = [];
  // (6c T3b) a postern (a tunnel under this wall) is an opening too: its bore blocked with the gates (its broken variant
  // `_unsafe.ignorePostern` leaves it open, so closure leaks through it)
  const postern = [];
  for (const t of meta?.tunnels ?? []) if (!t._unsafe?.ignorePostern && (t.posterns ?? []).some((q) => q.wall === w.id)) for (const c of t.voids ?? []) postern.push(c);
  const block = () => {
    for (const g of w.gates) for (const [x, z] of g.cells) for (let y = g.y + 1; y <= g.y + Math.max(g.h, 3); y++) { saved.push([x, y, z, vw.get(x, y, z), vw.flags(x, y, z), vw.partAt(x, y, z)]); vw.set(x, y, z, stone, vw.flags(x, y, z), vw.partAt(x, y, z)); }
    for (const [x, y, z] of postern) { saved.push([x, y, z, vw.get(x, y, z), vw.flags(x, y, z), vw.partAt(x, y, z)]); vw.set(x, y, z, stone, vw.flags(x, y, z), vw.partAt(x, y, z)); }
  };
  const restore = () => { while (saved.length) { const [x, y, z, i, f, p] = saved.pop(); vw.set(x, y, z, i, f, p); } };
  for (const mover of ['player', 'villager']) {
    block();
    let leaks = 0;
    const leakSample = [];
    try {
      const g = walkGraph(vw, inside.length ? inside : [], { mover });
      for (let i = 0; i < g.reached.length; i += 3) {
        const x = g.reached[i], y = g.reached[i + 1], z = g.reached[i + 2];
        if (isOut(x, z) && !inLot(x, z)) { leaks++; if (leakSample.length < 20) leakSample.push([x, y, z]); }
      }
    } finally { restore(); }
    // gates open: each side's nodes from the other's
    const fromIn = walkGraph(vw, inside, { mover }), fromOut = walkGraph(vw, outside, { mover });
    const missed = [];
    let across = 0;
    for (const n of outside) { if (nodeReached(fromIn, n)) across++; else if (missed.length < 20) missed.push(n); }
    for (const n of inside) { if (nodeReached(fromOut, n)) across++; else if (missed.length < 20) missed.push(n); }
    res[mover] = { leaks, leakSample, nodes: inside.length + outside.length, across, missed, inside: inside.length, outside: outside.length };
  }
  return res;
}

/**
 * (7a K2) A wall walk's rules (the header's M2:walk, M8:walk, M6, M5) over its meta (`w.walk`: cells [[x, feet y, z, pos]], accesses
 * [{kind, foot, at, steps?, cells?}]): metrics `{cells, reached, accessesUp, accessesDown, edges: {bad}, headroom: {bad}, dark}`.
 */
export function walkRules({ vw, w, part, stage, light, want, findings, finding }) {
  const P = vw.pal, wk = w.walk;
  const cells = wk.cells.map(([x, y, z]) => [x, y, z]);
  const isWalk = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  const m = { cells: cells.length, accesses: wk.accesses.length };
  // ---- M2:walk: round the whole walk from the accesses' feet, each access up from its own foot, and down to every foot
  const feet = wk.accesses.map((a) => a.foot);
  const g = walkGraph(vw, feet, { mover: 'player' });
  const missed = cells.filter((c) => !g.seen.has(c[0], c[1], c[2]));
  m.reached = cells.length - missed.length;
  const up = wk.accesses.map((a) => nodeReached(walkGraph(vw, [a.foot], { mover: 'player' }), a.at));
  const down = walkGraph(vw, cells.slice(0, 1).concat(wk.accesses.map((a) => a.at)), { mover: 'player' });
  const downOk = wk.accesses.map((a) => nodeReached(down, a.foot));
  m.accessesUp = up.filter(Boolean).length;
  m.accessesDown = downOk.filter(Boolean).length;
  if (want.has('M2')) {
    if (missed.length) findings.push(finding('M2:walk', part, stage, missed.length, missed, `wall ${w.id}: ${missed.length} of ${cells.length} walk cell(s) not reached by the player from its accesses`));
    const badA = wk.accesses.filter((a, i) => !up[i] || !downOk[i]);
    if (badA.length) findings.push(finding('M2:walk', part, stage, badA.length, badA.map((a) => a.foot), `wall ${w.id}: ${badA.length} access(es) the player can't climb up and down (${badA.map((a) => a.kind).join(', ')})`));
  }
  // ---- M8:walk: every edge of a walk cell a 1.5 barrier or a drop of at most 3
  const open = [];
  // the walk's level area: its cells and any standable cell at their level the player steps onto beside them (a gap in the parapet
  // makes the outer course a ledge: its own edges are judged), at most 2 off the walk
  // (an access's column, a ladder's top: the way down, no ledge)
  const accessCols = new Set(wk.accesses.flatMap((a) => [...(a.steps ?? []).map((q) => `${q[0]},${q[2]}`), ...(a.cells ? [`${a.cells[0]},${a.cells[2]}`] : [])]));
  const stand = (x, y, z) => !accessCols.has(`${x},${z}`) && !P.climb[vw.get(x, y - 1, z)] && P.passable[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)] && (P.floor[vw.get(x, y - 1, z)] || P.half[vw.get(x, y - 1, z)]);
  const area = cells.map(([x, y, z]) => [x, y, z, 0]);
  const inArea = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  for (let q = 0; q < area.length; q++) {
    const [x, y, z, d] = area[q];
    if (d >= 2) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y},${z + dz}`;
      if (inArea.has(k) || isWalk.has(`${x + dx},${y + 1},${z + dz}`) || isWalk.has(`${x + dx},${y - 1},${z + dz}`)) continue;
      if (!stand(x + dx, y, z + dz) || P.barrier[vw.get(x + dx, y - 1, z + dz)]) continue;
      inArea.add(k); area.push([x + dx, y, z + dz, d + 1]);
    }
  }
  for (const [x, y, z] of area) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (inArea.has(`${nx},${y},${nz}`) || isWalk.has(`${nx},${y + 1},${nz}`) || isWalk.has(`${nx},${y - 1},${nz}`)) continue;
      const a = vw.get(nx, y, nz);
      if (P.barrier[a] || (!P.passable[a] && !P.passable[vw.get(nx, y + 1, nz)])) continue;
      // a step or a drop of at most 3 (a floor within 3 under the feet: the flight's steps, the ground)
      let ok = false;
      for (let yy = y + 1; yy >= y - 3 && !ok; yy--) if (P.passable[vw.get(nx, yy, nz)] && (P.floor[vw.get(nx, yy - 1, nz)] || P.half[vw.get(nx, yy - 1, nz)] || P.climb[vw.get(nx, yy, nz)])) ok = true;
      if (!ok) open.push([nx, y, nz]);
    }
  }
  m.edges = { bad: open.length };
  if (open.length && want.has('M8')) findings.push(finding('M8:walk', part, stage, open.length, open, `wall ${w.id}: ${open.length} walk edge(s) with no rail or parapet over a drop of more than 3`));
  // ---- M6: 2 clear over every walk cell
  const low = cells.filter(([x, y, z]) => !P.passable[vw.get(x, y, z)] || !P.passable[vw.get(x, y + 1, z)]);
  m.headroom = { bad: low.length };
  if (low.length && want.has('M6')) findings.push(finding('M6:walk', part, stage, low.length, low, `wall ${w.id}: ${low.length} walk cell(s) without 2 clear over them`));
  // ---- M5: 0 dark spawnable walk cells and flight steps
  if (light) {
    const steps = wk.accesses.flatMap((a) => (a.steps ?? []).map(([x, y, z]) => [x, y + 1, z]));
    const dark = [...cells, ...steps].filter(([x, y, z]) => P.spawn[vw.get(x, y - 1, z)] && !(light.at(x, y, z) > 0));
    m.dark = dark.length;
    if (dark.length) findings.push(finding('M5:walk', part, stage, dark.length, dark, `wall ${w.id}: ${dark.length} dark spawnable walk cell(s) or flight step(s)`));
  }
  return m;
}
