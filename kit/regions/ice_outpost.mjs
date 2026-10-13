// ice_outpost (6c S2, docs/CONTRACT.md "Phase 6c slice S2"): the ice-spike outpost, S2's bundled program (not a catalogue
// program). On S2's pinned claim (a frozen sea with a band of snowy land dense with natural ice spikes) it lays a small frontier
// outpost on the land only (N-S2-1): a watch tower (the landmark), a longhouse, a smithy, a store, a farm (S-S2-1) and huts, each on
// a pad blended into the land by the relief pass (T1, `pad.edge: 'blend'`), joined by T2 routes from a gate node to every lot
// entrance (grade at most 0.2; villager movers on the hut edges), with generated ice-spike clusters (F1) filling gaps between the
// natural spikes, ground scatter (F2: snow layers, boulders, spruce stumps; none on walk cells) and W's light cover in the bible's
// light role (soul lanterns by default: block light 10, under vanilla's melt, M17).
//
// The natural ice is kept (`keepNatural('ICE')` over the claim's frozen volume): no lot, apron, route, relief, form, scatter item
// or lamp writes a kept cell. Lots stand on the largest connected band of dry land clear of ice (frozen water reads as water, W),
// so the frozen sea stays untouched.
//
// Two-plan flow: the first plan asks for the claim's frozen volume and lays nothing; the second reads it. Deterministic: sorted
// scans, no Math.random.
//   ground: the pads and their relief blend;  routes: the routes;  forms: the generated ice spikes;  decor: scatter and lamps;
//   lots-1: the lots.
import { region, Region } from '../lib/region/program.mjs';
import { classAt, VC } from '../lib/region/volume.mjs';
import { sampleIndex } from '../lib/region/survey.mjs';
import { FLAG_TREE } from '../lib/region/pack.mjs';
import { fixtureFor } from '../lib/region/fixtures.mjs';
import { lightCover } from '../lib/region/light.mjs';
import { lampSpots } from '../lib/region/passes/route.mjs';
import { scatter } from '../lib/region/scatterPlan.mjs';
import { iceSpike } from '../lib/forms/iceSpike.mjs';
import { formCells } from '../lib/forms/rules.mjs';
import { fnv64 } from '../lib/noise.mjs';

export const id = 'ice_outpost';
export const catalogue = false;
export const passes = ['relief', 'route'];
/** The outpost's look when no bible is given (S2's fixture bible "frontier outpost" wins): spruce, stone bricks, packed snow. */
export const roles = { surface: 'minecraft:snow_block', path: 'minecraft:spruce_planks', foundation: 'minecraft:stone_bricks', light: 'minecraft:soul_lantern', rail: 'minecraft:spruce_fence', structure: 'minecraft:stone_bricks' };

export const params = {
  huts: { type: 'int', min: 0, max: 4, default: 3, label: 'Huts' },
  farm: { type: 'bool', default: true, label: 'A farm lot' },
  routeWidth: { type: 'int', min: 1, max: 3, default: 1, label: 'Route width' },
  gradePct: { type: 'int', min: 5, max: 50, default: 20, label: 'Route grade limit (%)' },
  spikes: { type: 'int', min: 0, max: 12, default: 6, label: 'Generated ice-spike clusters' },
  scatter: { type: 'bool', default: true, label: 'Ground scatter' },
  scatterPct: { type: 'int', min: 5, max: 90, default: 35, label: 'Scatter density (%)' },
  stairs: { type: 'bool', default: true, label: 'Stair flights on the routes' },
  minLots: { type: 'int', min: 1, max: 12, default: 6, label: 'Least lots (else the plan fails)' },
};

/** The lots, largest first (the order they are placed in): [id, type, villager kind, along the front, deep, landmark]. */
export function lotList(P) {
  const l = [
    { id: 'longhouse_1', type: 'longhouse', role: 'longhouse', villager: 'job', size: [14, 12] },
    { id: 'tower_1', type: 'watchtower', role: 'watch tower', villager: null, size: [7, 9], height: 36, landmark: true },
    { id: 'smithy_1', type: 'smithy', role: 'smithy', villager: 'job', size: [9, 9] },
    { id: 'store_1', type: 'store', role: 'store', villager: 'job', size: [9, 9] },
  ];
  if (P.farm) l.push({ id: 'farm_1', type: 'farm', role: 'farm', villager: 'farm', size: [9, 9] });
  for (let i = 1; i <= P.huts; i++) l.push({ id: `hut_${i}`, type: 'hut', role: 'hut', villager: 'dwelling', size: [9, 9] });
  return l;
}

/** The layout's constants (chosen on S2's pinned survey, docs/CONTRACT.md S2 as built: 7 lots, every one routed):
 *  PAD_MAX: a pad's cut and fill; GAP: cells between two lots' aprons; FRONT: the entrance and that many cells out (5 wide) on the
 *  land band; CLEAR: the approach room (5 wide) no other lot may take (a route leaves straight out of a front, then turns). */
const PAD_MAX = 4, GAP = 2, FRONT = 4, CLEAR = 6;
/** Candidate sites kept per lot (S2's land band gives a few hundred; open land many thousands). */
const MAX_CANDS = 2400;
const LAND_TOP = new Set([VC.ROCK, VC.SOIL, VC.LOOSE, VC.SNOW]);
const FRONTS = ['north', 'east', 'south', 'west'];

/** `build(ctx, hooks)`: the program with the gate's broken-variant hooks (`hooks.after(r, info)`). */
export function build(ctx, hooks = {}) {
  const { claim, survey: S, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'routes', 'forms', 'decor', 'lots-1']);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 96 || D < 96) throw new Error(`ice_outpost needs a claim of at least 96x96 (got ${W}x${D})`);
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  // the claim's frozen volume, as forms_demo and scatter_demo ask for it (8 under the lowest floor to 8 over the highest top)
  const box = { minX: claim.minX, minZ: claim.minZ, maxX: claim.maxX, maxZ: claim.maxZ, minY: Math.max(claim.minY, st.minFloor - 8), maxY: Math.min(claim.maxY, st.maxTop + 8) };
  const keep = r.keepNatural('ICE', box, { stage: 'ground' });
  const vol = keep ? r.needVolume(box) : null;
  const info = { lots: [], unplaced: [], land: null };
  const anchors = (ex, ez, ey) => {
    r.anchor('entrance', [ex, ey, ez]);
    r.anchor('spawn', [ex, ey, ez]);
    r.anchor('hub', [ex, ey, ez]);
  };
  if (!vol) {
    // the first plan: no volume yet (the mod plans again with it)
    r.note('ice_outpost: waiting for the claim\'s frozen volume (two-plan flow)');
    anchors(cx, cz, S.groundAt(cx, cz) + 1);
    r.meta.outpost = info;
    return r;
  }

  // ---- the land: dry, known, treeless columns with no kept ice whose ground cell is rock, soil, loose or snow
  const idx = (x, z) => (x - claim.minX) + (z - claim.minZ) * W;
  const iceCol = new Uint8Array(W * D);
  for (const k of keep.columns) { const [x, z] = k.split(',').map(Number); iceCol[idx(x, z)] = 1; }
  const clean = new Uint8Array(W * D);
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
    const i = idx(x, z);
    if (iceCol[i] || S.waterAt(x, z) || S.missingAt(x, z)) continue;
    if (S.columns.flags[sampleIndex(S.columns, x, z)] & FLAG_TREE) continue;
    if (LAND_TOP.has(classAt(vol, x, S.groundAt(x, z), z))) clean[i] = 1;
  }
  // the largest band of clean land (4-neighbours; the routes climb between levels); ties: the first column in scan order
  const comp = new Int32Array(W * D).fill(-1);
  let best = -1, bestN = 0;
  for (let s = 0, n = 0; s < W * D; s++) {
    if (!clean[s] || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = n;
    for (let t = 0; t < q.length; t++) {
      const i = q[t], x = i % W, z = (i - x) / W;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
        const j = X + Z * W;
        if (!clean[j] || comp[j] >= 0) continue;
        comp[j] = n;
        q.push(j);
      }
    }
    if (q.length > bestN) { bestN = q.length; best = n; }
    n++;
  }
  // the columns the relief keeps: kept ice, water and 2 around water (passes/relief.mjs WATER_GUARD)
  const fixedCol = new Uint8Array(W * D);
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
    const i = idx(x, z);
    if (iceCol[i]) fixedCol[i] = 1;
    if (!S.waterAt(x, z)) continue;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Z = z + dz; if (X >= claim.minX && X <= claim.maxX && Z >= claim.minZ && Z <= claim.maxZ) fixedCol[idx(X, Z)] = 1; }
  }
  const onBand = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ && comp[idx(x, z)] === best;
  let sx = 0, sz = 0;
  for (let i = 0; i < W * D; i++) if (comp[i] === best) { sx += i % W; sz += Math.floor(i / W); }
  const centre = bestN ? [claim.minX + Math.round(sx / bestN), claim.minZ + Math.round(sz / bestN)] : [cx, cz];
  info.land = { clean: clean.reduce((a, b) => a + b, 0), band: bestN, centre, keptColumns: keep.columns.size, keptCells: keep.cells };

  // ---- the lots. Every candidate site of every lot (each front): footprint and apron (and `ring` beyond the footprint) on the band,
  // the pad within its limits, the entrance and `frontLen` cells out (3 wide) on the band. Then, in the list's order, each lot
  // takes the candidate that rules out the fewest candidates of the lots still to place (the least-blocking site), then the
  // pad's earthworks, the distance to the outpost's centre and scan order; lots keep `gap` between their aprons.
  const allBand = (x0, z0, x1, z1) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (!onBand(x, z)) return false; return true; };
  const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  const specs = lotList(P);
  const cands = specs.map((spec) => {
    const out = [];
    for (const front of FRONTS) {
      const ns = front === 'north' || front === 'south';
      const w = ns ? spec.size[0] : spec.size[1], d = ns ? spec.size[1] : spec.size[0];
      for (let z0 = claim.minZ + 4; z0 + d - 1 <= claim.maxZ - 4; z0++) for (let x0 = claim.minX + 4; x0 + w - 1 <= claim.maxX - 4; x0++) {
        const x1 = x0 + w - 1, z1 = z0 + d - 1;
        if (!allBand(x0 - 1, z0 - 1, x1 + 1, z1 + 1)) continue;
        const [fx, fz] = CARD[front];
        const ex = front === 'east' ? x1 + 1 : front === 'west' ? x0 - 1 : x0 + Math.floor((w - 1) / 2);
        const ez = front === 'south' ? z1 + 1 : front === 'north' ? z0 - 1 : z0 + Math.floor((d - 1) / 2);
        let open = true;
        for (let t = 0; t <= FRONT && open; t++) for (let v = -2; v <= 2; v++) {
          const x = ex + fx * t + fz * v, z = ez + fz * t + fx * v;
          if (!(onBand(x, z) && x - claim.minX >= 4 && claim.maxX - x >= 4 && z - claim.minZ >= 4 && claim.maxZ - z >= 4)) { open = false; break; }
        }
        if (!open) continue;
        const ps = S.padStats(x0, z0, w, d);
        if (ps.cut > PAD_MAX || ps.fill > PAD_MAX || ps.water) continue;
        // M8: the relief can't raise a column it keeps (kept ice, water and the 2 beside water), so no such column within 2 of the
        // apron may lie more than 3 under the pad's top (an unguarded drop beside a walk cell)
        let drop = false;
        for (let z = z0 - 3; z <= z1 + 3 && !drop; z++) for (let x = x0 - 3; x <= x1 + 3; x++) {
          if (x >= x0 - 1 && x <= x1 + 1 && z >= z0 - 1 && z <= z1 + 1) continue;
          if (x < claim.minX || x > claim.maxX || z < claim.minZ || z > claim.maxZ) continue;
          if (!fixedCol[idx(x, z)]) continue;
          if (S.groundAt(x, z) < ps.floorY - 4) { drop = true; break; }
        }
        if (drop) continue;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        out.push({ x0, z0, x1, z1, w, d, front, floorY: ps.floorY, cut: ps.cut, fill: ps.fill, mid: [mx, mz], ex, ez, fx, fz,
          dist: Math.abs(mx - centre[0]) + Math.abs(mz - centre[1]), away: fx * (centre[0] - mx) + fz * (centre[1] - mz) < 0 ? 1 : 0 });
      }
    }
    // at most about MAX_CANDS a lot (open land, such as the flat variant, has tens of thousands): a coarser lattice of corners
    if (out.length > MAX_CANDS) {
      const k = Math.ceil(Math.sqrt(out.length / MAX_CANDS));
      return out.filter((o) => (o.x0 - claim.minX) % k === 0 && (o.z0 - claim.minZ) % k === 0);
    }
    return out;
  });
  // two sites clash when their aprons come within `gap`, or one's front cells fall in the other's footprint or apron
  const inRect = (x, z, a) => x >= a.x0 - 2 && x <= a.x1 + 2 && z >= a.z0 - 2 && z <= a.z1 + 2;
  // a's approach room (the entrance and CLEAR cells out, 5 wide) meets b's footprint or apron (with a ring)
  const clearIn = (a, b) => {
    for (let t = 0; t <= CLEAR; t++) for (let v = -2; v <= 2; v++) if (inRect(a.ex + a.fx * t + a.fz * v, a.ez + a.fz * t + a.fx * v, b)) return true;
    return false;
  };
  const R = CLEAR + 4; // (a quick reject: two sites farther apart than their approach room never clash)
  const clash = (a, b) => {
    if (a.x1 + R < b.x0 || b.x1 + R < a.x0 || a.z1 + R < b.z0 || b.z1 + R < a.z0) return false;
    return !(a.x1 + 1 + GAP < b.x0 - 1 || b.x1 + 1 + GAP < a.x0 - 1 || a.z1 + 1 + GAP < b.z0 - 1 || b.z1 + 1 + GAP < a.z0 - 1)
      || clearIn(a, b) || clearIn(b, a);
  };
  // place every lot in the list's order on the candidates not banned (`banned`: per lot index, the "x0,z0,front" keys)
  const place = (banned) => {
    const lots = [], unplaced = [];
    const live = cands.map((c, k) => c.filter((o) => !banned[k].has(`${o.x0},${o.z0},${o.front}`)));
    for (let k = 0; k < specs.length; k++) {
      const spec = specs[k];
      if (!live[k].length) { unplaced.push({ id: spec.id, reason: `no band site (dry, ice-free footprint and apron, pad within ${PAD_MAX}, the front open, ${GAP} from the other lots, a route from the gate)` }); continue; }
      let pick = null, pickKey = null;
      for (const c of live[k]) {
        let blocked = 0;
        for (let m = k + 1; m < specs.length; m++) for (const o of live[m]) if (clash(c, o)) blocked++;
        const key = [blocked, c.away, c.cut + c.fill, c.dist, c.z0, c.x0, FRONTS.indexOf(c.front)];
        let less = !pickKey;
        if (pickKey) for (let i = 0; i < key.length; i++) if (key[i] !== pickKey[i]) { less = key[i] < pickKey[i]; break; }
        if (less) { pick = c; pickKey = key; }
      }
      lots.push({ spec, k, ...pick });
      for (let m = k + 1; m < specs.length; m++) live[m] = live[m].filter((o) => !clash(pick, o));
    }
    return { lots, unplaced };
  };
  // ---- the gate: a band cell at least 8 from every lot's apron, on a 5x5 of band land within 1 of level, nearest the lots'
  // centroid (scan order breaks ties)
  const gateFor = (lots) => {
    const lc = [lots.reduce((a, l) => a + l.mid[0], 0) / lots.length, lots.reduce((a, l) => a + l.mid[1], 0) / lots.length];
    let gate = null, gd = Infinity;
    for (let z = claim.minZ + 6; z <= claim.maxZ - 6; z++) for (let x = claim.minX + 6; x <= claim.maxX - 6; x++) {
      if (!onBand(x, z)) continue;
      if (lots.some((l) => x >= l.x0 - 9 && x <= l.x1 + 9 && z >= l.z0 - 9 && z <= l.z1 + 9)) continue;
      const g = S.groundAt(x, z);
      let ok = true;
      for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2; dx++) if (!onBand(x + dx, z + dz) || Math.abs(S.groundAt(x + dx, z + dz) - g) > 1) { ok = false; break; }
      if (!ok) continue;
      const dd = Math.abs(x - lc[0]) + Math.abs(z - lc[1]);
      if (dd < gd) { gd = dd; gate = [x, g + 1, z]; }
    }
    return gate;
  };
  const lotSpec = (l) => ({
    at: [l.x0, l.z0], size: [l.w, l.d], floor: l.floorY, front: l.front, stage: 'lots-1', max: [l.w, l.spec.height ?? 24, l.d],
    pad: { edge: 'blend', maxCut: PAD_MAX, maxFill: PAD_MAX },
    ext: { 'architect_mc:village': { role: l.spec.role, type: l.spec.type, villager: l.spec.villager, ...(l.spec.landmark ? { landmark: true } : {}) } },
  });
  const routeIntent = (lots, gate) => {
    const order = lots.map((l) => ({ l, d: Math.abs(l.entrance[0] - gate[0]) + Math.abs(l.entrance[1] - gate[2]) })).sort((a, b) => a.d - b.d || a.l.k - b.l.k);
    const nodes = { gate: { at: gate, kind: 'gate' } };
    for (const { l } of order) nodes[l.spec.id] = { lot: l.spec.id };
    const edges = order.map(({ l }) => ({ id: `gate_${l.spec.id}`, from: 'gate', to: l.spec.id, width: P.routeWidth }));
    return { nodes, edges, maxGrade: P.gradePct / 100, stairs: P.stairs, ladders: true, stage: 'routes', lanterns: false };
  };
  // the layout: place, route on a scratch region, and ban the site of every lot whose route fails; again until every placed lot
  // is routed (at most 8 rounds). A lot that runs out of sites is unplaced: every placed lot is reachable from the gate.
  const banned = specs.map(() => new Set());
  let lay = null, gate = null, rounds = 0, failedLast = [];
  for (; rounds < 8; rounds++) {
    lay = place(banned);
    if (lay.lots.length < P.minLots) break;
    gate = gateFor(lay.lots);
    if (!gate) break;
    const r2 = new Region(ctx);
    r2.stages(['ground', 'routes', 'forms', 'decor', 'lots-1']);
    r2.keepNatural('ICE', box, { stage: 'ground' });
    const p2 = r2.part('pads', { stage: 'ground' });
    for (const l of lay.lots) { const res = p2.lot(l.spec.id, lotSpec(l)); l.entrance = [res.entrance[0], res.entrance[2]]; }
    const net2 = r2.pass('route', routeIntent(lay.lots, gate));
    const failed = net2.edges.filter((e) => !e.ok).map((e) => e.id.slice(5));
    failedLast = failed;
    if (!failed.length) break;
    // ban the failed site and its neighbours (the same front, within 2): a site 1 over meets the same obstacle
    for (const l of lay.lots) if (failed.includes(l.spec.id)) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) banned[l.k].add(`${l.x0 + dx},${l.z0 + dz},${l.front}`);
  }
  // a lot still unrouted after the last round is left out (every placed lot is reachable from the gate)
  const lots = lay.lots.filter((l) => !failedLast.includes(l.spec.id));
  info.unplaced = [...lay.unplaced, ...lay.lots.filter((l) => failedLast.includes(l.spec.id)).map((l) => ({ id: l.spec.id, reason: 'no route from the gate within the grade and the obstacles' }))];
  info.layoutRounds = rounds + 1;
  r.note(`ice_outpost: ${lots.length} lots on the land band (${bestN} columns of ${W * D}; ${keep.columns.size} kept ice columns; ${rounds + 1} layout round(s))${info.unplaced.length ? `; unplaced: ${info.unplaced.map((u) => u.id).join(', ')}` : ''}`);
  if (lots.length < P.minLots) throw new Error(`ice_outpost: only ${lots.length} lots fit on the land band (at least ${P.minLots}); unplaced ${info.unplaced.map((u) => u.id).join(', ')}`);
  if (!gate) throw new Error('ice_outpost: no gate site on the land band');
  const pads = r.part('pads', { stage: 'ground' });
  const placed = lots.map((l) => pads.lot(l.spec.id, lotSpec(l)));
  const rel = r.pass('relief', { around: placed, radius: 6, maxCut: PAD_MAX, maxFill: PAD_MAX });
  // the blend as the routes' base: they meet the land the relief leaves (its retaining columns and grades against that land, not the
  // frozen survey's), and graded columns throughout (a 4e ground road would refit to the survey's ground at realise)
  const relBase = (() => {
    const f = r.fields[rel.fields.relief];
    if (!f) return null;
    const b = r.sideBlobs[f.blob].bytes, n = f.width * f.depth, values = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = (b[2 * i] | (b[2 * i + 1] << 8)) << 16 >> 16; values[i] = v === -32768 ? 0 : v; }
    return { minX: f.minX, minZ: f.minZ, width: f.width, depth: f.depth, values };
  })();
  info.lots = lots.map((l) => ({ id: l.spec.id, at: [l.x0, l.z0], size: [l.w, l.d], front: l.front, floorY: l.floorY, cut: l.cut, fill: l.fill }));
  info.gate = gate;
  const net = r.pass('route', { ...routeIntent(lots, gate), ...(relBase ? { base: relBase } : {}) });
  info.routes = net.edges.map((e) => ({ id: e.id, ok: e.ok, length: e.length ?? null, movers: e.movers ?? null, why: e.ok ? null : (e.reason ?? e.note ?? null) }));

  // ---- the walk: the routes' cells (with their width) and the lots' boxes and aprons, for the forms' 6-cell clearance
  const near6 = new Uint8Array(W * D);
  const mark = (x, z, R) => { for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) { const X = x + dx, Z = z + dz; if (X >= claim.minX && X <= claim.maxX && Z >= claim.minZ && Z <= claim.maxZ) near6[idx(X, Z)] = 1; } };
  for (const e of r.meta.route.edges) if (e.ok) for (const [x, , z] of e.path) mark(x, z, 6 + (e.width >> 1));
  for (const l of lots) for (let z = l.z0 - 1; z <= l.z1 + 1; z++) for (let x = l.x0 - 1; x <= l.x1 + 1; x++) mark(x, z, 6);
  mark(gate[0], gate[2], 6);

  // ---- generated ice spikes (F1 iceSpike): clusters on the band's ice-free land between the natural spikes (the widest gaps
  // first), never within 6 of a lot or a route, none of their cells on a kept cell (M1), 2 clear of each other
  const AIR = 'minecraft:air';
  const takenCols = new Set();
  const fits = (gen) => {
    const { cells } = formCells(gen.ops);
    const cols = new Set();
    for (const [k, st2] of cells) {
      if (st2 === AIR) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (x < claim.minX || x > claim.maxX || z < claim.minZ || z > claim.maxZ || y < claim.minY + 2 || y > claim.maxY) return null; // (the skirt reaches 6 under the ground: not into a superflat world's bedrock)
      if (keep.has(x, y, z)) return null;
      if (near6[idx(x, z)]) return null;
      cols.add(`${x},${z}`);
    }
    for (const k of cols) { const [x, z] = k.split(',').map(Number); for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (takenCols.has(`${x + dx},${z + dz}`)) return null; }
    return cols;
  };
  const spikeSites = [];
  for (let z = claim.minZ + 6; z <= claim.maxZ - 6; z += 2) for (let x = claim.minX + 6; x <= claim.maxX - 6; x += 2) {
    if (!onBand(x, z) || near6[idx(x, z)]) continue;
    let ok = true, lo = Infinity, hi = -Infinity;
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1; dx++) { if (!onBand(x + dx, z + dz)) { ok = false; break; } const g = S.groundAt(x + dx, z + dz); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    if (!ok || hi - lo > 2) continue;
    // the distance to the nearest natural ice column (Chebyshev, up to 16): a gap among the natural spikes, the widest first (a
    // cluster spreads up to about 8 from its centre)
    // (land with no natural ice, the flat variant: anywhere on the band, so E-flat exercises the forms too)
    let dIce = 17;
    for (let rr = 2; rr <= 16 && dIce > 16; rr++) if (keep.near(x, z, rr)) dIce = rr;
    if (dIce > 16 && keep.columns.size) continue;
    spikeSites.push({ x, z, y: S.groundAt(x, z), dIce });
  }
  spikeSites.sort((a, b) => b.dIce - a.dIce || a.z - b.z || a.x - b.x);
  const SPIKES = ['classic', 'needles', 'stubby'];
  const forms = [];
  for (let i = 0, tries = 0; i < P.spikes && tries < 400; i++) {
    let got = null;
    for (const st2 of spikeSites) {
      if (tries >= 400) break;
      if ([...takenCols].length && [-3, 0, 3].some((a) => [-3, 0, 3].some((b) => takenCols.has(`${st2.x + a},${st2.z + b}`)))) continue;
      tries++;
      const fid = `ice_${forms.length + 1}`;
      const preset = SPIKES[forms.length % SPIKES.length];
      // compact clusters (spread 3, radius at most 2): they fill the gaps between the natural spikes, not the open land
      const gen = iceSpike({ preset, at: [st2.x, st2.y, st2.z], spread: 3, radius: [1, 2], seed: fnv64(ctx.seed, 'iceSpike', fid).hex }, { groundAt: (x, z) => S.groundAt(x, z) });
      const cols = fits(gen);
      if (!cols) continue;
      for (const k of cols) takenCols.add(k);
      got = { fid, gen, preset, site: st2 };
      break;
    }
    if (!got) break;
    r.form(got.fid, got.gen, { stage: 'forms' });
    forms.push({ id: got.fid, preset: got.preset, at: [got.site.x, got.site.y, got.site.z], spikes: got.gen.spikes.length, ops: got.gen.ops.length, bounds: got.gen.bounds });
  }
  info.forms = forms;
  if (forms.length < P.spikes) r.note(`ice_outpost: ${forms.length}/${P.spikes} generated ice-spike clusters (no more room 6 from the lots and routes and clear of the natural ice)`);

  // ---- anchors: the gate is the entrance and spawn (the light cover walks from it)
  anchors(gate[0], gate[2], gate[1]);

  // ---- ground scatter (F2): boulders, spruce stumps and snow layers on the band, never on walk cells (the op's own avoid), never
  // on a kept cell; before the lamps, so the light cover sees the boulders' tops (a soul lantern's 10 melts no snow layer)
  if (P.scatter) {
    // the scatter's own ground: band land at least 3 from water and 2 from kept ice (a boulder's top is a walk cell: never beside the
    // sea's drop or in the ice's lee), a u8 field the op masks by
    const dry = new Uint8Array(W * D);
    for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
      if (!onBand(x, z)) continue;
      let ok = true;
      for (let dz = -3; dz <= 3 && ok; dz++) for (let dx = -3; dx <= 3; dx++) {
        const X = x + dx, Z = z + dz;
        if (X < claim.minX || X > claim.maxX || Z < claim.minZ || Z > claim.maxZ) continue;
        if (S.waterAt(X, Z) || (Math.max(Math.abs(dx), Math.abs(dz)) <= 2 && iceCol[idx(X, Z)])) { ok = false; break; }
      }
      dry[idx(x, z)] = ok ? 1 : 0;
    }
    r.field('outpost_dry', { type: 'u8', minX: claim.minX, minZ: claim.minZ, width: W, depth: D, res: 1, values: dry });
    const res = scatter(r, 'outpost_scatter', {
      grid: 7, jitter: 2, density: { path: [2, 9], p: P.scatterPct / 100 }, mask: { field: 'outpost_dry', gte: 1 },
      items: [{ w: 3, item: 'boulder', maxRadius: 2, mix: [[6, 'rock'], [3, 'rubble']] }, { w: 2, item: 'stump', log: 'frame' }, { w: 6, item: 'snow_layer' }],
    }, { stage: 'decor' });
    info.scatter = { placements: res?.placements ?? null };
  }

  // ---- light: W's cover over the lot aprons and the routes, in the bible's light role on its rail; a light over 10 would melt the
  // ice (M17), so a brighter role falls back to the soul lantern (light 10)
  let fixture = fixtureFor(r.material('light', 'lamp'), r.material('rail', 'lamp post'));
  if (fixture.level > 10) { r.note(`ice_outpost: the light role (${fixture.kind}, light ${fixture.level}) melts ice over 10: soul lanterns instead`); fixture = fixtureFor('minecraft:soul_lantern', r.material('rail', 'lamp post')); }
  const reserved = new Set();
  for (const k of keep.columns) { const [x, z] = k.split(',').map(Number); for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) reserved.add(`${x + dx},${z + dz}`); }
  for (const k of takenCols) reserved.add(k);
  const extra = [], extraCap = {};
  // (light 10 reaches about half as far as a lantern's 15: twice W's caps, a lamp every 3 route cells as a candidate)
  for (const e of r.meta.route.edges) { const l = lampSpots(e, { every: 2 }); extra.push(...l.spots); if (l.spots.length) extraCap[`route:${e.id}`] = 4 * l.cap; }
  // and around each pad: every cell of the rings 2 to 4 out (W's corners and batter feet may all stand on the natural ice), then the
  // relief's blend (written floors out to its radius) on the rings 5 and 7, every 3 cells
  for (const l of lots) {
    const key = `ring:${l.spec.id}`;
    for (let x = l.x0 - 4; x <= l.x1 + 4; x++) for (let z = l.z0 - 4; z <= l.z1 + 4; z++) if (Math.max(l.x0 - x, x - l.x1, l.z0 - z, z - l.z1) >= 2) extra.push({ lot: key, x, z });
    extraCap[key] = 4;
  }
  for (const l of lots) {
    const key = `band:${l.spec.id}`;
    for (const k of [5, 7]) for (let x = l.x0 - k; x <= l.x1 + k; x += 3) for (let z = l.z0 - k; z <= l.z1 + k; z += 3) {
      if (Math.max(l.x0 - x, x - l.x1, l.z0 - z, z - l.z1) !== k) continue;
      extra.push({ lot: key, x, z });
    }
    extraCap[key] = 4;
  }
  // and around each generated cluster (its base is a written floor): every cell of its bounds' rings 1 to 4
  for (const f of forms) {
    const b = f.bounds, key = `form:${f.id}`;
    for (let x = b.minX - 4; x <= b.maxX + 4; x++) for (let z = b.minZ - 4; z <= b.maxZ + 4; z++) if (Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ) >= 1) extra.push({ lot: key, x, z });
    extraCap[key] = 3;
  }
  // and the open land near the walk (the boulders' tops are written floors a mob spawns on): band cells within 6 of a route or a
  // lot on a 5-cell grid, last
  for (let z = claim.minZ + 4; z <= claim.maxZ - 4; z += 5) for (let x = claim.minX + 4; x <= claim.maxX - 4; x += 5) if (onBand(x, z) && near6[idx(x, z)]) extra.push({ lot: 'field', x, z });
  extraCap.field = 48;
  const cover = lightCover(r, { fixture, stage: 'decor', reserved, extra, extraCap, maxPerLot: 12, share: 0.001, part: 'outpost_lamps' });
  info.lamps = { fixture: cover.fixture, count: cover.lamps.length, perKey: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped };

  // ---- the gallery's cameras: the hub between the gate and the lots' centroid
  const lc = [Math.round(lots.reduce((a, l) => a + l.mid[0], 0) / lots.length), Math.round(lots.reduce((a, l) => a + l.mid[1], 0) / lots.length)];
  const hub = [Math.round((lc[0] + gate[0]) / 2), Math.round((lc[1] + gate[2]) / 2)];
  r.anchor('hub', [hub[0], S.groundAt(hub[0], hub[1]) + 1, hub[1]]);
  const clampX = (x) => Math.max(claim.minX, Math.min(claim.maxX, x)), clampZ = (z) => Math.max(claim.minZ, Math.min(claim.maxZ, z));
  const camY = (x, z, up) => Math.min(claim.maxY - 1, Math.max(gate[1], S.topAt(x, z)) + up);
  const cam = (n, x, z, up) => r.anchor(n, [clampX(x), camY(clampX(x), clampZ(z), up), clampZ(z)]);
  cam('cam_n', hub[0], hub[1] - 70, 40); cam('cam_s', hub[0], hub[1] + 70, 40); cam('cam_e', hub[0] + 70, hub[1], 40); cam('cam_w', hub[0] - 70, hub[1], 40);
  cam('cam_high', hub[0] + 8, hub[1] + 8, 90); cam('cam_ground', gate[0] + 6, gate[2] + 6, 3);
  r.meta.outpost = info;
  if (hooks.after) hooks.after(r, info);
  return r;
}

export default function iceOutpost(ctx) {
  return build(ctx);
}
