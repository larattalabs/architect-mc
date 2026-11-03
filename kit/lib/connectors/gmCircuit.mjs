// (7a GM) The gate mechanisms' cell layouts and timing, as `gm-probe` proved them on the running 26.3 server (docs/CONTRACT.md "Slice GM"
// §2, §2a, §7, §12; tools/gate7agm.mjs). Pure data and pure functions: no world, no compile context.
//
// Local frame (one gate): u across the passage (east, +x, in the probe), d along it from the front face (south, +z), r up from floorY.
// The gate plane is d = 1; the passage lanes are u = -1 and u = 1, the mullion u = 0; the recess (jambs) u in [-4, -2] and [2, 4];
// lintelY = r 3; the rows above it, r 4..7, hold the bus. A cell is [u, d, r, state]; a state's facing is written in the local frame
// (u+ = east, d+ = south) and turned by the caller.
//
//   layout(kind, mats) -> {cells: [[u,d,r,state]...], envelope: [[u,d,r]...], writeOrder}   the settled rest state (open by day, nothing
//                                                                                           moving); see settle()
//   settle(kind, rest, mats) -> the cells of the rest state: a fixed point (gm-unit)
//   TIMING   the ticks the probe recorded per kind (open, close)

const W = 'minecraft:';

/** The materials a gate takes: the structure block (leaf, mullion, lining, sleepers), the bar (portcullis leaves), the stone it sits in. */
export function gmMats(m = {}) {
  return {
    structure: m.structure ?? `${W}stone_bricks`,
    bar: m.bar ?? `${W}iron_bars`,
    slab: m.slab ?? `${W}stone_brick_slab`,
    button: m.button ?? `${W}stone_button`,
    plate: m.plate ?? `${W}stone_pressure_plate`,
  };
}

const k = (u, d, r) => `${u},${d},${r}`;
/** Map u-sign s to the facing that points toward the passage's centre (a piston on side s faces -s). */
const toCentre = (s) => (s < 0 ? 'east' : 'west');

/**
 * The sliding gate (portcullis = bars, slide = solid leaves): per side s = -1, +1, three sticky pistons at u = 3s (rows 0-2) push the leaf
 * column from the recess (u = 2s, open) to the lane (u = s, closed). Power G closes. The feed of G to the six pistons (§12; a 3-high piston
 * stack cannot be powered from its own plane alone, so the lining of the plane d = 2 carries the lower two):
 *   top    S = (3s,1,3), a structure block under the bus dust (3s,1,4): powers the top piston, and the middle one by quasi-connectivity
 *   right  (4s,1,2) under the dust (4s,1,3): the top piston again
 *   bottom (3s,2,0) under the dust (3s,2,1), reached down the lining: (4s,1,3) -> (4s,2,2) -> (3s,2,1)
 * The cut cells (air) let the dust step down: (4s,1,4), (3s,1,5), (4s,2,3), (3s,2,2).
 * G enters each side at (3s,2,5) on (3s,2,4).
 */
export function slideCells(kind, mats) {
  const M = gmMats(mats);
  const leaf = kind === 'slide' ? M.structure : M.bar;
  const c = new Map();
  const put = (u, d, r, s) => c.set(k(u, d, r), [u, d, r, s]);
  for (let r = 0; r <= 2; r++) put(0, 1, r, M.structure); // the mullion
  for (const s of [-1, 1]) {
    for (let r = 0; r <= 2; r++) {
      put(s, 1, r, `${W}air`); // the lane at rest (open)
      put(2 * s, 1, r, leaf); // the leaf in its recess
      put(3 * s, 1, r, `${W}sticky_piston[extended=false,facing=${toCentre(s)}]`);
    }
    put(3 * s, 1, 3, M.structure); // S
    put(3 * s, 1, 4, `${W}redstone_wire`);
    put(3 * s, 1, 5, `${W}air`);
    put(4 * s, 1, 0, M.structure);
    put(4 * s, 1, 1, M.structure);
    put(4 * s, 1, 2, M.structure);
    put(4 * s, 1, 3, `${W}redstone_wire`);
    put(4 * s, 1, 4, `${W}air`);
    put(2 * s, 1, 3, M.structure); // the sleeper over the recess
    // the lining, plane d = 2
    put(3 * s, 2, 0, M.structure);
    put(3 * s, 2, 1, `${W}redstone_wire`);
    put(3 * s, 2, 2, `${W}air`);
    put(4 * s, 2, 1, M.structure);
    put(4 * s, 2, 2, `${W}redstone_wire`);
    put(4 * s, 2, 3, `${W}air`);
    put(3 * s, 2, 4, M.structure);
    put(3 * s, 2, 5, `${W}redstone_wire`);
  }
  return c;
}

/** World placement of local cells for the probe: (u, d, r) -> (X + u, F + r, Z + d); facings unchanged (u+ = east, d+ = south). */
export function toWorld([u, d, r, s], X, F, Z) {
  return [X + u, F + r, Z + d, s];
}

/**
 * The swing gate (§2, rest closed, power opens): two iron doors (rows 0-1) at u = -1 and 1 in the plane d = 1, a transom of bars above
 * them, the mullion between. Every trigger powers the mullion's middle block (0,1,1), which both doors' upper halves touch: the button on
 * its front face (d = 0, outside, a player), the lever on its back face (d = 2, inside, holds it open); the plate on the floor of the left
 * lane behind the door (-1,2,0) powers the left door's lower half (anyone inside).
 */
export function swingCells(mats) {
  const M = gmMats(mats);
  const c = new Map();
  const put = (u, d, r, s) => c.set(k(u, d, r), [u, d, r, s]);
  for (let r = 0; r <= 2; r++) put(0, 1, r, M.structure);
  for (const [u, hinge] of [[-1, 'left'], [1, 'right']]) {
    put(u, 1, 0, `${W}iron_door[facing=south,half=lower,hinge=${hinge},open=false,powered=false]`);
    put(u, 1, 1, `${W}iron_door[facing=south,half=upper,hinge=${hinge},open=false,powered=false]`);
    put(u, 1, 2, M.bar);
  }
  const btn = M.button.replace(/\[.*$/, '');
  put(0, 0, 1, `${btn}[face=wall,facing=north,powered=false]`);
  put(0, 2, 1, `${W}lever[face=wall,facing=south,powered=false]`);
  put(-1, 2, 0, `${M.plate.replace(/\[.*$/, '')}[powered=false]`);
  return c;
}

/**
 * The drawbridge deck (GM-c, §2: lowered at rest, power raises, a ripple of one redstone tick a cell). Local frame: x along the crossing
 * (cell i = 0..n-1 over the water), z across, y up from the deck row (the deck's trapdoors, half top, flush with the banks). The deck is
 * `width` 2 (z 0 and 1); a middle row of a wider deck has nothing beside it to power it (its neighbours are trapdoors, the walk above and the
 * water below), so the deck is at most 2 wide. Each deck trapdoor is powered by a repeater beside it (z -1 or 2, delay a_i) fed by a second
 * one (z -2 or 3, delay b_i) from a bus (z -3 or 4) that both levers drive at once: cell i flips a_i + b_i = i + 2 redstone ticks after the
 * lever. Repeaters and the bus sit on sleepers one row down (in the water).
 */
export function drawbridgeCells(n, mats) {
  const M = gmMats(mats);
  if (n > 7) throw new Error('drawbridge: the ripple covers 7 cells (repeater delays 1..4 twice)');
  const c = [];
  for (let i = 0; i < n; i++) {
    const tot = i + 2, b = Math.min(4, tot - 1), a = tot - b;
    for (const [z, zf, zb, zbus, fac] of [[0, -1, -2, -3, 'north'], [1, 2, 3, 4, 'south']]) {
      c.push([i, 0, z, `${W}iron_trapdoor[facing=${fac === 'north' ? 'south' : 'north'},half=top,open=false,powered=false,waterlogged=false]`]);
      c.push([i, -1, zf, M.structure], [i, -1, zb, M.structure], [i, -1, zbus, M.structure]);
      c.push([i, 0, zf, `${W}repeater[facing=${fac},delay=${a}]`], [i, 0, zb, `${W}repeater[facing=${fac},delay=${b}]`], [i, 0, zbus, `${W}redstone_wire`]);
    }
  }
  return c;
}
/** The ripple's designed ticks: cell i flips 2 * (i + 2) game ticks after the lever (repeater ticks only; the lever and dust add none). */
export const drawbridgeTicks = (i) => 2 * (i + 2);

/**
 * The lever detectors (§2a "levers at both passage ends"; §12): each lever hangs from the lintel over a lane at its end of the passage, its
 * mount (the lintel cell) strongly powered when on; the iron trapdoor in the plane d = 1 above that lane (row 3) touches the mount and flips
 * with it; an observer above the trapdoor (row 4, facing down) gives one pulse per flip, out of its top (row 5). Outside: the lane u = -1
 * (mount (-1,0,3)); inside: the lane u = 1 at the last plane (mount (1,D-1,3)), its trapdoor (1,D-2,3) when D > 3, else (1,1,3).
 * Mobs cannot flip levers.
 */
export function detectorCells(depth = 3) {
  const inner = depth - 1;
  return [
    [-1, 0, 2, `${W}lever[face=ceiling,facing=south,powered=false]`],
    [-1, 1, 3, `${W}iron_trapdoor[facing=south,half=top,open=false,powered=false,waterlogged=false]`],
    [-1, 1, 4, `${W}observer[facing=down,powered=false]`],
    [1, inner, 2, `${W}lever[face=ceiling,facing=north,powered=false]`],
    [1, depth > 3 ? inner - 1 : 1, 3, `${W}iron_trapdoor[facing=north,half=top,open=false,powered=false,waterlogged=false]`],
    [1, depth > 3 ? inner - 1 : 1, 4, `${W}observer[facing=down,powered=false]`],
  ];
}

import { SETTLED } from './gmSettled.mjs';
/** The settled rest state of a kind (§7 item 1): every dependent property as the probe read it back (dust shapes and power, pistons, doors). */
export function settle(kind, rest = kind === 'swing' ? 'closed' : 'open') {
  const s = SETTLED[kind]?.[rest];
  if (!s) throw new Error(`gmCircuit.settle: no settled state for ${kind}/${rest}`);
  return Object.entries(s).map(([k2, st]) => [...k2.split(',').map(Number), st]);
}

/**
 * The ticks gm-probe recorded on 26.3 (game ticks; §10 item 0 "timing recorded").
 *   slide/portcullis: G at the leaves' feed to the leaves settled, closed 3 and open 3 (stone and fortress roles alike)
 *   the §2a logic bench (lever flip to settled leaves, through ~45 cells of bus): 34 and 34; the logic alone adds the detector (2), P'
 *   (6), the lock (8) and R_G (4)
 *   swing: the button holds 20 ticks (stone); the plate and lever open within 2
 *   drawbridge: cell i flips 2 (i + 2) ticks after a lever, raising and lowering
 *   detectors: an observer pulse of 2 ticks, 2 ticks after the flip
 */
export const TIMING = Object.freeze({ slide: { close: 3, open: 3 }, portcullis: { close: 3, open: 3 }, benchLeverToLeaves: { close: 34, open: 34 }, swingButton: 20, drawbridgeCell: (i) => 2 * (i + 2), detectorPulse: { delay: 2, length: 2 } });

// ------------------------------------------------------------------ step 1b: the gate and the day-cycle logic in a gatehouse box

/**
 * (§14) The whole sliding gate of a gatehouse box: the leaves and their feed (slideCells), the lever detectors (detectorCells), the
 * §2a day-cycle logic in the logic block (u in [-5, 5], d = 1..depth-2, rows lintelY+1..lintelY+5 = 4..8), the roof sensor and its wire
 * run, every unused logic-block cell written as the structure block. Local frame as above; `roof` is the roof's row (the box's height
 * from floorY: the minimum box 13 x 7 x 10 has its roof at row 10, the sensor in it).
 *
 * The logic is the bench's D latch (gmBench) with §14 item 3's timing, laid out in three dimensions:
 *   r 7  the chain SB -> CMP (subtract, back SB) -> DB -> RG (latch, delay 2) -> GB along d = 4; nQ (dust) on CMP's north side from T2
 *        on B2; RL (lock, delay 1) on RG's north side from T5 on BC; B2 -> rBC (delay 1) -> BC on the front row (the bench's B2 -> BC)
 *   r 6  T1 standing under DB, so D is a block (DB) powered by CMP or by T1
 *   r 5  B1 under T1, fed by rG (delay 1, reads the block under GB's G dust) and rQd (delay 2, Q' + 4)
 *   S    sensor (inverted) -> raw dust -> RS (delay 1, the clean S) -> S dust on SB; OS watches RS -> QB -> RQ (delay 4) -> Q' dust
 *   Q'   -> rB2 (delay 1) -> B2 = Q' + 2; -> rQd (delay 2) -> B1 = Q' + 4 = B2 + 2; BC = B2 + 2 (the rule: a = 2 on both paths)
 *   P    each detector's observer powers a block read by its own RP (delay 3); both feed P' -> rP (delay 1) -> BC
 *   G    GB -> dust under it (rG's input) and east, down to the line at row 4 along d = 3, which reaches both feed entries (3s,2,5)
 *        through the cut cells (+-3,3,5)
 * Each cell: {u, d, r, state, lint} (lint: gmLint's cell form in the frame x = u, y = r, z = d).
 */
export function gateLayout(kind, { depth = 7, roof = 10, mats } = {}) {
  if (depth < 7) throw new Error(`gateLayout: depth ${depth} under 7 (CONTRACT GM §14 item 1)`);
  if (roof < 10) throw new Error(`gateLayout: roof row ${roof} under 10 (CONTRACT GM §14 item 1)`);
  if (roof - 10 > depth - 3) throw new Error(`gateLayout: the sensor run climbs one row per plane; roof ${roof} needs depth ${roof - 7}`);
  const M = gmMats(mats);
  const S = M.structure;
  const cells = new Map();
  const F = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };
  const OPPF = { n: 's', s: 'n', e: 'w', w: 'e' };
  const put = (u, d, r, state, lint) => cells.set(k(u, d, r), { u, d, r, state, lint });
  const block = (u, d, r, o = {}) => put(u, d, r, S, { t: 'block', ...o });
  const air = (u, d, r) => put(u, d, r, `${W}air`, { t: 'air' });
  const dust = (u, d, r, o = {}) => put(u, d, r, `${W}redstone_wire`, { t: 'dust', ...o });
  const rep = (u, d, r, f, delay, o = {}) => put(u, d, r, `${W}repeater[facing=${F[f]},delay=${delay}]`, { t: 'rep', f, delay, ...o });
  const cmp = (u, d, r, f, o = {}) => put(u, d, r, `${W}comparator[facing=${F[f]},mode=subtract]`, { t: 'cmp', f, ...o });
  const torch = (u, d, r, m, o = {}) => { const v = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[m];
    put(u, d, r, `${W}redstone_wall_torch[facing=${F[OPPF[m]]},lit=true]`, { t: 'torch', mount: [u + v[0], r, d + v[1]], ...o }); };
  const torchUp = (u, d, r, o = {}) => put(u, d, r, `${W}redstone_torch[lit=true]`, { t: 'torch', mount: [u, r - 1, d], ...o });
  const obs = (u, d, r, f, o = {}) => put(u, d, r, `${W}observer[facing=${F[f]},powered=false]`, { t: 'obs', f, ...o });
  // the gate: leaves, feed, detectors
  for (const [u, d, r, s] of slideCells(kind, M).values()) {
    let l;
    if (/redstone_wire/.test(s)) l = { t: 'dust' };
    else if (/air$/.test(s)) l = { t: 'air' };
    else if (/sticky_piston/.test(s)) l = { t: 'piston', f: u < 0 ? 'e' : 'w', expect: ['G'] };
    else l = { t: 'block' };
    put(u, d, r, s, l);
  }
  for (const [u, d, r, s] of detectorCells(depth)) {
    const side = u < 0 ? 'A' : 'B';
    if (/lever/.test(s)) put(u, d, r, s, { t: 'lever', mount: [u, 3, d], label: `L${side}`, stop: true });
    else if (/trapdoor/.test(s)) put(u, d, r, s, { t: 'trap', expect: [`L${side}`] });
    else put(u, d, r, s, { t: 'obs', f: 'd', label: `P${side}`, stop: true });
  }
  block(-1, 0, 3); block(1, depth - 1, 3); // the levers' lintel mounts
  // the chain, r 7
  block(-4, 4, 7, { name: 'SB', expect: ['S'] });
  cmp(-3, 4, 7, 'w', { name: 'CMP' });
  block(-2, 4, 7, { name: 'DB', expect: ['S', 'nG', 'nQ'] });
  rep(-1, 4, 7, 'w', 2, { name: 'RG', label: 'G', stop: true });
  block(0, 4, 7, { name: 'GB' });
  torch(-2, 4, 6, 's', { name: 'T1', label: 'nG', stop: true }); block(-2, 5, 6, { name: 'B1', expect: ['G', 'QA'] }); // T1 under DB, hung on B1
  dust(-3, 3, 7, { name: 'nQ', expect: ['nQ'] }); torch(-3, 2, 7, 'n', { name: 'T2', label: 'nQ', stop: true }); block(-3, 1, 7, { name: 'B2', expect: ['QA'] });
  rep(-1, 3, 7, 'n', 1, { name: 'RL' }); torch(-1, 2, 7, 'n', { name: 'T5', label: 'nC', stop: true }); block(-1, 1, 7, { name: 'BC', expect: ['QA', 'Pp'] });
  rep(-2, 1, 7, 'w', 1, { name: 'rBC' });
  rep(0, 1, 7, 'e', 1, { name: 'rP' });
  air(-3, 2, 8); air(-1, 2, 8); // over the wall torches
  rep(-1, 5, 6, 'e', 1, { name: 'rG' });
  rep(-3, 5, 6, 'w', 2, { name: 'rQd' });
  // the G line, r 5, d 3 (floors in row 4, inside the logic block), touching both feed entries; G from GB down to it
  for (let u = -3; u <= 3; u++) dust(u, 3, 5, { expect: ['G'] });
  dust(-3, 2, 5, { expect: ['G'] }); dust(3, 2, 5, { expect: ['G'] });
  for (const [u, d, r] of [[0, 4, 6], [0, 5, 6]]) dust(u, d, r, { expect: ['G'] });
  air(0, 3, 6);
  // S: the sensor's run (a staircase along d for a higher roof), raw dust on the block RS reads, RS, S dust on SB
  let sd = 1;
  for (let r = 10; r < roof; r++) { air(-4, sd, r); sd++; block(-4, sd, r - 1); dust(-4, sd, r, { name: 'raw' }); }
  put(-4, sd, roof, `${W}daylight_detector[inverted=true,power=0]`, { t: 'sensor', label: 'raw' });
  dust(-4, 1, 9, { name: 'raw' }); block(-4, 1, 8);
  if (roof > 10) air(-4, 1, 10);
  rep(-4, 2, 8, 'n', 1, { name: 'RS', label: 'S', stop: true });
  dust(-4, 3, 8, { name: 'S', expect: ['S'] }); dust(-4, 4, 8, { name: 'S', expect: ['S'] });
  block(-3, 3, 8); block(-5, 3, 8);
  // Q: OS under RS, QB, RQ, Q' to rQd (the block under (-4,4,6)) and to rB2
  obs(-4, 2, 7, 'u', { name: 'OS', label: 'Q', stop: true });
  block(-4, 2, 6, { name: 'QB' });
  rep(-4, 3, 6, 'n', 4, { name: 'RQ', label: 'QA', stop: true });
  for (const [u, d, r] of [[-4, 4, 6], [-4, 5, 6], [-5, 4, 6], [-5, 3, 7], [-5, 2, 7], [-5, 1, 7]]) dust(u, d, r, { name: 'QA', expect: ['QA'] });
  air(-5, 4, 7);
  rep(-4, 1, 7, 'w', 1, { name: 'rB2' });
  // P: the detectors' output blocks, RPa and RPb (delay 3), P' to rP's input
  block(-1, 1, 5, { name: 'PAB' }); block(1, depth - 2, 5, { name: 'PBB' });
  rep(0, 1, 5, 'w', 3, { name: 'RPa', label: 'Pp', stop: true });
  rep(2, depth - 2, 5, 'w', 3, { name: 'RPb', label: 'Pp', stop: true });
  // P': RPa's output climbs (1,1,5) -> (2,1,6) -> (2,2,6) -> (2,3,7) -> (1,3,7); RPb's along the east column (4,d,6) -> (3,3,7); RP'
  // (delay 1) at (1,2,7) powers the block (1,1,7) that rP reads
  const P = [[1, 1, 5], [2, 1, 6], [2, 2, 6], [2, 3, 7], [1, 3, 7], [3, 3, 7], [3, depth - 2, 5]];
  for (let d = 3; d <= depth - 2; d++) P.push([4, d, 6]);
  for (const [u, d, r] of P) dust(u, d, r, { name: 'Pp', expect: ['Pp'] });
  air(1, 1, 6); air(2, 2, 7); air(4, 3, 7); air(3, depth - 2, 6);
  rep(1, 2, 7, 's', 1, { name: 'RPp' }); block(1, 1, 7, { name: 'PB2' });
  block(3, 2, 6);
  // floors under every dust, repeater and comparator; then the rest of the logic block as the structure block
  for (const c of [...cells.values()]) if (['dust', 'rep', 'cmp'].includes(c.lint.t)) { const kk = k(c.u, c.d, c.r - 1); if (!cells.has(kk)) block(c.u, c.d, c.r - 1); }
  for (let u = -LOGIC_HALF; u <= LOGIC_HALF; u++) for (let d = 1; d <= depth - 2; d++) for (let r = 4; r <= 8; r++) if (!cells.has(k(u, d, r))) block(u, d, r);
  return { cells, depth, roof, sensor: [-4, sd, roof] };
}
/** The logic block's half width in u (§14 item 2 gives u in [-6, 6]; the layout keeps off the 13-wide box's side faces at +-6). */
export const LOGIC_HALF = 5;
/** gateLayout's cells as [u, d, r, state] (the form slideCells and settle use). */
export const layoutCells = (lay) => [...lay.cells.values()].map((c) => [c.u, c.d, c.r, c.state]);

/**
 * The static checks of a gate layout in a box `half` (u in [-half, half]) x depth x roof (gmLint): the influence check with every cell
 * outside the layout `outside` ('solid': the design's walls; 'air': an open hall), and the hidden check (nothing but plain blocks on a
 * face). Returns the problems.
 */
export async function lintLayout(lay, { half = 6, outside = 'solid' } = {}) {
  const { lint, hiddenProblems } = await import('./gmLint.mjs');
  const m = new Map();
  for (const c of lay.cells.values()) m.set(`${c.u},${c.r},${c.d}`, c.lint);
  const inBox = (u, r, d) => Math.abs(u) <= half && d >= 0 && d < lay.depth && r >= -1 && r <= lay.roof;
  const passage = (u, r) => Math.abs(u) <= 1 && r >= 0 && r <= 2;
  const solid = (key) => { const [u, r, d] = key.split(',').map(Number); if (!inBox(u, r, d) || passage(u, r)) return false;
    if (outside === 'solid') return true; return d === 0 || d === lay.depth - 1 || Math.abs(u) === half || r <= 3 || r >= lay.roof; };
  const allowed = new Set([`-1,0,2`, `1,${lay.depth - 1},2`, `-1,1,3`, `1,${lay.depth - 2},3`, lay.sensor.join(',')]);
  for (const c of lay.cells.values()) if (Math.abs(c.u) <= 1 && c.r <= 2) allowed.add(`${c.u},${c.d},${c.r}`); // the passage's own cells (leaves, lanes)
  return [...lint(m, { solid }).problems, ...hiddenProblems(layoutCells(lay), { half, depth: lay.depth, roof: lay.roof }, allowed)];
}

/**
 * (§14 item 3) The latch's static timing in game ticks, from the delays a layout declares (repeater delays in redstone ticks). Times are
 * relative to the Q' pulse: B2 = 2 rB2, B1 = 2 rQd, BC = B2 + 2 rBC; the unlock starts when T5 (2) and RL go off; data is valid on the
 * T1 path when T1 (2) is off and on the CMP path when T2 (2) and the comparator (2) have answered. The rule: 1 <= a <= 2 RG - 1.
 */
export function latchTiming({ rB2 = 1, rQd = 2, rBC = 1, RL = 1, RG = 2 } = {}) {
  const b2 = 2 * rB2, b1 = 2 * rQd, bc = b2 + 2 * rBC;
  const unlock = bc + 2 + 2 * RL;
  const aT1 = unlock - (b1 + 2), aCMP = unlock - (b2 + 4);
  const max = 2 * RG - 1;
  return { b1MinusB2: b1 - b2, aT1, aCMP, max, ok: [aT1, aCMP].every((a) => a >= 1 && a <= max) };
}
/** The delays gateLayout declares (and the bench's, before §14). */
export const LAYOUT_DELAYS = Object.freeze({ rB2: 1, rQd: 2, rBC: 1, RL: 1, RG: 2 });

// ------------------------------------------------------------------ GM-a: the mechanism in a gatehouse lot

/** (§14 item 1) The least gatehouse box for a mechanism: along the wall, through it, and floorY to the roof underside. */
export const GM_BOX_MIN = Object.freeze({ along: 13, depth: 7, height: 10 });
/** Whether a gatehouse box takes a mechanism; `need` names the first short side (for the deviation and NO_ROOM's `need`). */
export function gmBoxFits({ along, depth, height }) {
  if (along < GM_BOX_MIN.along) return { ok: false, need: { along: GM_BOX_MIN.along } };
  if (depth < GM_BOX_MIN.depth) return { ok: false, need: { depth: GM_BOX_MIN.depth } };
  if (height < GM_BOX_MIN.height) return { ok: false, need: { height: GM_BOX_MIN.height } };
  return { ok: true };
}

/**
 * The cells a mechanism writes, in gmCircuit's local frame (u across, d in from the front face, r up from floorY), with the states the
 * realise writes: `portcullis` and `slide` are gateLayout's cells (the box `depth` deep, its roof at row `height`), `swing` is
 * swingCells. `rest` is §2's default. Returns {cells: [[u, d, r, state]...], kind, rest, dayDriven, triggers, sensor}.
 */
export function mechanismCells(kind, { depth, height, mats, rest } = {}) {
  if (kind === 'swing') {
    const cells = [...swingCells(mats).values()];
    return { kind, rest: rest ?? 'closed', dayDriven: false, cells, sensor: null,
      triggers: [{ kind: 'button', at: [0, 0, 1], side: 'front', who: 'player' }, { kind: 'lever', at: [0, 2, 1], side: 'back', who: 'player' }, { kind: 'plate', at: [-1, 2, 0], side: 'back', who: 'anyone' }] };
  }
  if (kind !== 'portcullis' && kind !== 'slide') throw new Error(`mechanismCells: unknown kind ${kind}`);
  const lay = gateLayout(kind, { depth, roof: height, mats });
  return { kind, rest: rest ?? 'open', dayDriven: true, cells: layoutCells(lay), sensor: lay.sensor,
    triggers: [{ kind: 'lever', at: [-1, 0, 2], side: 'front', who: 'player' }, { kind: 'lever', at: [1, depth - 1, 2], side: 'back', who: 'player' }, { kind: 'daylight', at: lay.sensor, side: 'roof', who: 'sky' }] };
}

const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const OUT = { north: 0, east: 1, south: 2, west: 3 };
/**
 * A local cell placed in the world for a passage whose front (outer) face is `facing` (the passage's `facing`, out of the wall): (cx, cz)
 * is the passage's centre column on the front face row, fy its floorY. The local frame is the probe's turned (never mirrored): d runs in
 * from the front, u to the right of an observer facing out (u+ = east when the front faces north). States turn with it.
 */
export function gmToWorld([u, d, r, s], { cx, fy, cz, facing }) {
  const k = OUT[facing];
  if (k === undefined) throw new Error(`gmToWorld: facing ${facing}`);
  const inv = { north: [0, 1], east: [-1, 0], south: [0, -1], west: [1, 0] }[facing];
  const ux = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[facing];
  return [cx + u * ux[0] + d * inv[0], fy + r, cz + u * ux[1] + d * inv[1], turnStateLocal(s, k)];
}
const DIRS4 = ['north', 'east', 'south', 'west'];
function turnStateLocal(s, k) {
  if (!k || typeof s !== 'string' || !s.includes('[')) return s;
  const i = s.indexOf('[');
  const props = Object.fromEntries(s.slice(i + 1, -1).split(',').map((kv) => kv.split('=')));
  const out = { ...props };
  const t = (dir) => { const j = DIRS4.indexOf(dir); return j < 0 ? dir : DIRS4[(j + k) % 4]; };
  if (props.facing) out.facing = t(props.facing);
  if (DIRS4.every((x) => x in props)) for (const x of DIRS4) out[t(x)] = props[x];
  return `${s.slice(0, i)}[${Object.entries(out).map(([a, b]) => `${a}=${b}`).join(',')}]`;
}
void CW;

/**
 * (§7 item 1) The settled rest state of a gateLayout, by a pure evaluator: torches lit unless their mount is powered, repeaters and
 * comparators from their inputs (the latch RG held at its rest: unpowered for `rest: open`), dust power by distance from its sources,
 * dust shapes from its links (a single link extends to the opposite side; none: a dot). By day, levers off, the sensor at 0. Returns
 * a Map 'u,d,r' -> state for every redstone part (blocks, leaves and pistons keep gateLayout's states). gm-unit runs it twice (a fixed
 * point) and compares it with gm-fit's dump of a freshly built box.
 */
export async function settleLayout(lay, { rest = 'open' } = {}) {
  const { lint, DIRS: LD, OPP: LO } = await import('./gmLint.mjs');
  const m = new Map();
  for (const c of lay.cells.values()) m.set(`${c.u},${c.r},${c.d}`, c.lint);
  const solid = () => true; // the design's cells around: walls (the dust links only see the layout's own dust)
  const inside = (key) => m.has(key);
  const L2 = lint(m, { solid: (key) => !inside(key) && solid(key) });
  const P = (k2) => k2.split(',').map(Number);
  const add = (p, d) => [p[0] + LD[d][0], p[1] + LD[d][1], p[2] + LD[d][2]];
  const K2 = (p) => p.join(',');
  const at = (p) => m.get(K2(p)) ?? { t: 'block', implicit: true };
  const lit = new Map(), pow = new Map(), on = new Map(), locked = new Map();
  for (const [k2, c] of m) { if (c.t === 'torch') lit.set(k2, true); if (c.t === 'dust') pow.set(k2, 0); if (c.t === 'rep' || c.t === 'cmp') on.set(k2, false); }
  const rgKey = [...m].find(([, c]) => c.name === 'RG')?.[0];
  // power into a cell from its neighbours: strong (diode/observer outputs, a torch below, a lever mount), weak (dust on top or pointing in)
  const strongInto = (bk) => { const p = P(bk);
    for (const d of Object.keys(LD)) { const n = add(p, d), nk = K2(n), c = m.get(nk); if (!c) continue;
      if ((c.t === 'rep' || c.t === 'cmp') && K2(add(n, LO[c.f])) === bk && on.get(nk)) return true;
      if (c.t === 'torch' && d === 'd' && lit.get(nk) && K2(c.mount) !== bk) return true; }
    return false; };
  const weakInto = (bk) => { const p = P(bk);
    for (const d of Object.keys(LD)) { const n = add(p, d), nk = K2(n), c = m.get(nk); if (!c || c.t !== 'dust' || !pow.get(nk)) continue;
      if (d === 'u') return true; if (L2.dustInfo.get(nk).point.includes(LO[d])) return true; }
    return false; };
  const blockOn = (bk) => strongInto(bk) || weakInto(bk);
  const signalAt = (srcKey, intoKey) => { // the signal a neighbour cell gives the cell intoKey (for a diode's input)
    const c = m.get(srcKey);
    if (!c) return 0;
    if (c.t === 'dust') return pow.get(srcKey) ?? 0;
    if (c.t === 'block') return blockOn(srcKey) ? 15 : 0;
    if (c.t === 'torch') return lit.get(srcKey) && K2(c.mount) !== intoKey ? 15 : 0;
    if (c.t === 'rep' || c.t === 'cmp') return K2(add(P(srcKey), LO[c.f])) === intoKey && on.get(srcKey) ? 15 : 0;
    return 0; };
  for (let it = 0; it < 200; it++) {
    let changed = false;
    const set = (map, k2, v) => { if (map.get(k2) !== v) { map.set(k2, v); changed = true; } };
    for (const [k2, c] of m) {
      if (c.t === 'torch') set(lit, k2, !blockOn(K2(c.mount)));
      if (c.t === 'rep') {
        const back = K2(add(P(k2), c.f));
        const sides = Object.keys(LD).filter((d) => d !== c.f && d !== LO[c.f] && d !== 'u' && d !== 'd');
        set(locked, k2, sides.some((d) => { const n = add(P(k2), d), nk = K2(n), s = m.get(nk); return s && (s.t === 'rep' || s.t === 'cmp') && K2(add(n, LO[s.f])) === k2 && on.get(nk); }));
        if (k2 === rgKey) set(on, k2, rest === 'closed');
        else set(on, k2, signalAt(back, k2) > 0);
      }
      if (c.t === 'cmp') {
        const back = signalAt(K2(add(P(k2), c.f)), k2);
        const sides = Object.keys(LD).filter((d) => d !== c.f && d !== LO[c.f] && d !== 'u' && d !== 'd');
        const side = Math.max(0, ...sides.map((d) => { const nk = K2(add(P(k2), d)), s = m.get(nk); return s && (s.t === 'dust' || s.t === 'rep' || s.t === 'cmp') ? signalAt(nk, k2) : 0; }));
        set(on, k2, back - side > 0);
      }
    }
    for (const [k2, c] of m) {
      if (c.t !== 'dust') continue;
      const p = P(k2);
      let best = 0;
      for (const d of Object.keys(LD)) {
        const n = add(p, d), nk = K2(n), s = m.get(nk);
        if (!s) continue;
        if (s.t === 'block' && strongInto(nk)) best = 15;
        if (s.t === 'torch' && lit.get(nk) && !(d === 'u' && P(K2(s.mount))[1] < n[1])) best = 15;
        if ((s.t === 'rep' || s.t === 'cmp') && K2(add(n, LO[s.f])) === k2 && on.get(nk)) best = 15;
      }
      for (const w of L2.dustInfo.get(k2).wires) best = Math.max(best, (pow.get(w) ?? 0) - 1);
      set(pow, k2, best);
    }
    if (!changed) break;
  }
  const out = new Map();
  const F = { n: 'north', s: 'south', e: 'east', w: 'west' };
  for (const c of lay.cells.values()) {
    const k2 = `${c.u},${c.r},${c.d}`, l = c.lint, key = `${c.u},${c.d},${c.r}`;
    if (l.t === 'dust') {
      const di = L2.dustInfo.get(k2);
      const p = P(k2);
      const shape = {};
      for (const h of ['n', 's', 'e', 'w']) {
        // (a dust with no link stays the dot it was placed as on 26.3 (gm-fit's dump): it powers only the block under it)
        if (!di.links.length || !di.point.includes(h)) { shape[F[h]] = 'none'; continue; }
        const n = add(p, h), up = add(n, 'u');
        shape[F[h]] = di.links.includes(h) && m.get(K2(up))?.t === 'dust' && di.wires.includes(K2(up)) ? 'up' : 'side';
      }
      out.set(key, `minecraft:redstone_wire[east=${shape.east},north=${shape.north},power=${pow.get(k2)},south=${shape.south},west=${shape.west}]`);
    } else if (l.t === 'rep') out.set(key, `minecraft:repeater[delay=${l.delay},facing=${F[l.f]},locked=${!!locked.get(k2)},powered=${on.get(k2)}]`);
    else if (l.t === 'cmp') out.set(key, `minecraft:comparator[facing=${F[l.f]},mode=subtract,powered=${on.get(k2)}]`);
    else if (l.t === 'torch') out.set(key, c.state.replace(/lit=\w+/, `lit=${lit.get(k2)}`));
    else if (l.t === 'sensor') out.set(key, c.state);
  }
  return out;
}
