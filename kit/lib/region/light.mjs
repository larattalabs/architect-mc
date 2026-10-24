// r.lightCover (docs/CONTRACT.md "Phase 6c slice W" §3, with the Coordinator addition: bible-styled lamps): light the walk area
// the checker's M5 counts (every reached floor the region wrote: lot aprons and batter steps too), at plan time, with lamps in
// the bible's fixture (fixtures.mjs) beside the lots. Opt-in per program: only a program that calls it changes.
//
// Method (deterministic):
//   1. The plan so far as a draft IR (plan.mjs draftIR) -> its virtual world (buildVirtual), the walk graph from the entrance
//      anchor (the checker's), and the target set: reached cells whose floor the region wrote and a mob can spawn on.
//   2. Block light over that world from its emitters (the shared space's lamps) plus a model of the 4e street lanterns (the
//      mod lays them at realise: the IR road's spacing and side, its lamp or 4e's lantern); lot boxes are opaque (the building
//      that stands there blocks light, and its own lights are ignored: the cover is conservative).
//   3. Candidates beside each lot (the lamp prop's rules: supported, standable, never on a walk cell, a lane or door path, in a
//      lot box, the bell area, golem space or keep-out): the lot's corners outside the apron's diagonal first, then the batter
//      feet (the ring past the apron: edge middles and quarters, then further out), each group ordered by (lot id, x, z).
//   4. Greedy: add the candidate that lights the most dark targets (light from the fixture's real level), ties by candidate
//      order, until the dark targets are under 0.5% of the target set or no candidate helps; at most 4 lamps per lot. A lamp
//      that would cut a walk node off the entrance is dropped and the cover is run again without it.
// Emits part `props_apron` (stage `props`, natural cells only: a plant on the post's cell is replaced), each lot's lamp positions on its ext (`architect_mc:village`.lamps),
// meta.village.apronLamps (per-lot counts, before / after), the lamps as props (kind `apron_lamp`) and a plan note.
import { keptBy } from '../fluids/keep.mjs';
import { draftIR } from './plan.mjs';
import { buildVirtual, F_WALK, F_WRITTEN } from './vworld.mjs';
import { nodeReached, walkGraph, walkNodes } from './check.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from './geom.mjs';
import { ARM_DIRS, DEFAULT_FIXTURE, fixtureCells } from './fixtures.mjs';
import { COND } from './program.mjs';
import { walkKinds } from '../realise.mjs';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const COVER_SHARE = 0.005;
export const LAMPS_PER_LOT = 4;

/** Block light from sources [[x, y, z, level]...] over vw (opaque cells and lot boxes stop it): Map "x,y,z" -> level. */
function lightFrom(vw, sources, opaque, inArea = null) {
  const P = vw.pal;
  const L = new Map();
  const buckets = Array.from({ length: 16 }, () => []);
  for (const [x, y, z, lv] of sources) {
    const k = `${x},${y},${z}`;
    if ((L.get(k) ?? 0) < lv) { L.set(k, lv); buckets[lv].push([x, y, z]); }
  }
  for (let lv = 15; lv >= 2; lv--) {
    for (const [x, y, z] of buckets[lv]) {
      if (L.get(`${x},${y},${z}`) !== lv) continue;
      for (const [dx, dy, dz] of DIRS6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        // ((6c D3) `inArea`: a reach plan's light also spreads over the town's claim)
        if (!(inArea ? inArea(nx, nz) : vw.inClaim(nx, nz)) || opaque(nx, ny, nz)) continue;
        const v = lv - P.cost[vw.get(nx, ny, nz)];
        const k = `${nx},${ny},${nz}`;
        if (v > (L.get(k) ?? 0)) { L.set(k, v); if (v >= 2) buckets[v].push([nx, ny, nz]); }
      }
    }
  }
  return L;
}

/** The 4e street lanterns as the mod lays them (RoadPlan.lanterns: the first `first` out, then every `every`, beside the walkway). */
function roadLights(vw, ir, fixtureOf) {
  const out = [];
  const P = vw.pal;
  for (const r of ir.roads ?? []) {
    if (!r.lanterns) continue;
    const pts = r.points.map((p) => [p[0], p[2]]);
    const { cells } = centreCells(pts);
    const offs = crossOffsets(r.width);
    const hi = offs[offs.length - 1], lo = offs[0];
    const walk = new Set();
    for (const c of cells) {
      const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)];
      const rr = rightOf(segmentAxis(a, b));
      for (const k of offs) walk.add(`${c.x + rr[0] * k},${c.z + rr[1] * k}`);
    }
    const lamp = r.lamp ?? null;
    const every = lamp ? lamp.every : 12, first = lamp ? lamp.first : 6;
    const f = fixtureOf(lamp);
    let since = every - first;
    for (let i = 1; i < cells.length - 1; i++) {
      since += 1;
      if (since + 1e-9 < every) continue;
      const c = cells[i], n = cells[i + 1];
      const dx = Math.sign(n.x - c.x), dz = Math.sign(n.z - c.z);
      const rx = -dz, rz = dx;
      const feet = vw.colTop(c.x, c.z) + 1;
      let placed = false;
      for (const side of [hi + 1, lo - 1]) {
        const qx = c.x + side * rx, qz = c.z + side * rz;
        if (walk.has(`${qx},${qz}`) || !vw.inClaim(qx, qz)) continue;
        for (const dy of [0, 1, -1]) {
          const y = feet + dy;
          if (!P.solid[vw.get(qx, y - 1, qz)] || !P.air[vw.get(qx, y, qz)] || !P.air[vw.get(qx, y + 1, qz)]) continue;
          const la = lamp ? lamp.cells[lamp.light] : [0, 1];
          out.push([qx + la[0] * dx, y + la[1], qz + la[0] * dz, f.level]);
          placed = true;
          break;
        }
        if (placed) break;
      }
      since = placed ? 0 : every / 2;
    }
  }
  return out;
}

/**
 * `r.lightCover({fixture, stage, keepOut, reserved, laneCells, maxPerLot, share})`: plan and emit the apron and batter lamps.
 * `reserved`: "x,z" columns no lamp may take (the bell area, golem space, the props' own); `laneCells`: the lanes' cells
 * (door paths). Returns `{lamps: [{lot, at, cells}], perLot, before, after, targets, capped}`.
 */
export function lightCover(r, { fixture, stage = 'props', keepOut = [], reserved = new Set(), laneCells = [], maxPerLot = LAMPS_PER_LOT, share = COVER_SHARE, extra = [], extraCap = {}, part = 'props_apron', _drop = null, _format1 = false, lampGap = 0, reach = null } = {}) {
  const { ir, blobs } = draftIR(r);
  // (6c S2) a draft with side blobs (a relief pass's fields, a frozen volume, a baked form) is a format-2 IR (the kinds it walks, the
  // plan's seed and keep-out, as scatterPlan's draft), and its virtual world reads the volumes the plan used (the kept natural cells are there, not air); a draft without side blobs
  // (S7, route_demo) stays as it was
  let volumes = [];
  // ((6c H) a draft holding a fluid body's op (a farm pond, a wet well) is a format-2 IR as well)
  const fluidOp = ir.parts.some((p) => (p.ops ?? []).some((o) => o.op === 'fluid'));
  if (!_format1 && ((ir.blobs && Object.values(ir.blobs).some((b) => b && b.sha !== undefined)) || fluidOp)) { // (`_format1`: the broken variant)
    ir.format = 2;
    ir.requires = walkKinds(ir);
    ir.seed = r.ctx.seed; // (the plan's seed: a scatter op places as it will, so its boulders' tops are lit)
    const ko = r.ctx.keepOut;
    if (Array.isArray(ko)) ir.keepOut = ko;
    volumes = (r.ctx.volumes ?? []).filter((v) => Object.values(r.volumesUsed).some((u) => u.sha === v.sha)).map((v) => v.decoded).filter(Boolean);
  }
  const meta = { lots: r.meta.lots, parts: r.meta.parts };
  // ((6c D3) a reach plan's virtual world stands over the reach frame's survey: its join's cells in the town's claim are there)
  const surveyCols = r._reachSurvey ?? r.ctx.survey.columns;
  const vw = buildVirtual({ ir, survey: surveyCols, blobs, volumes }).vw;
  const P = vw.pal;
  const start = ir.anchors?.entrance;
  const opaque = (x, y, z) => P.opaque[vw.get(x, y, z)] || !!vw.lotAt(x, y, z);
  const nodes = walkNodes(ir, meta, null);
  const reach0 = walkGraph(vw, start ? [start] : []);
  const nodesOk0 = nodes.map((n) => nodeReached(reach0, n.at));
  // ---- targets: reached cells whose floor the region wrote and a mob spawns on
  const targets = [];
  const ra = reach0.reached;
  for (let i = 0; i < ra.length; i += 3) {
    const x = ra[i], y = ra[i + 1], z = ra[i + 2];
    if ((vw.flags(x, y - 1, z) & F_WRITTEN) && P.spawn[vw.get(x, y - 1, z)]) targets.push([x, y, z]);
  }
  // ((6c D3) `reach`: a reach join's walk cells in a standing town's claim (outside the walk graph's claim) are targets too, and the
  // cover must hold over them on their own (the M5 bar over the whole join); `reach.lights`: the town's own lights near them)
  const reachT = new Set();
  if (reach) for (const [x, y, z] of reach.targets ?? []) {
    if (!((vw.flags(x, y - 1, z) & F_WRITTEN) && P.spawn[vw.get(x, y - 1, z)]) || targets.some((t) => t[0] === x && t[1] === y && t[2] === z)) continue;
    reachT.add(targets.length);
    targets.push([x, y, z]);
  }
  const tIndex = new Map(targets.map((t, i) => [`${t[0]},${t[1]},${t[2]}`, i]));
  // ---- the base light: written emitters plus the modelled street lanterns
  const sources = [];
  vw.eachWritten((x, y, z, idx) => { const e = P.emit[idx]; if (e > 0) sources.push([x, y, z, e]); });
  sources.push(...roadLights(vw, ir, (lamp) => (lamp ? { level: fixture.level } : DEFAULT_FIXTURE)));
  if (reach) sources.push(...(reach.lights ?? []));
  const inArea = reach ? (x, z) => vw.inClaim(x, z) || reach.area(x, z) : null;
  const base = lightFrom(vw, sources, opaque, inArea);
  const lights0 = lampGap > 0 ? sources.filter((q) => q[3] >= 10).map((q) => [q[0], q[1], q[2]]) : [];
  const dark = new Set();
  targets.forEach((t, i) => { if (!((base.get(`${t[0]},${t[1]},${t[2]}`) ?? 0) > 0)) dark.add(i); });
  const before = { targets: targets.length, dark: dark.size, share: targets.length ? dark.size / targets.length : 0 };
  // ---- candidates
  const lanes = new Set(laneCells.map((c) => `${c[0]},${c[2]}`));
  const boxes = ir.lots.map((l) => l.box);
  const inBox = (x, z) => boxes.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
  const kept = (x, z) => keepOut.some((k) => x >= k[0] && x <= k[2] && z >= k[1] && z <= k[3]);
  const entrances = new Set(ir.lots.map((l) => { const e = r.meta.lots[l.id]?.entrance; return e ? `${e[0]},${e[2]}` : ''; }));
  // ((6c HY) a course's flowing water (its lips, falls and riffles: spill the plan never writes, so the draft holds air there) is no
  // place for a lamp; only a course's or ditch's bodies, so every other plan's lamps stand as before)
  const keep = Array.isArray(r._keep) ? r._keep.filter((q) => q.kind === 'body') : [];
  let keptSkipped = 0;
  const spillCols = new Set((r._fluidBodies ?? []).filter((b) => b.kind === 'course' || b.kind === 'ditch').flatMap((b) => b.spill.map((c) => `${c[0]},${c[2]}`)));
  const colOk = (x, z) => (vw.inClaim(x, z) || (reach ? reach.lampOk(x, z) : false)) && !inBox(x, z) && !lanes.has(`${x},${z}`) && !reserved.has(`${x},${z}`) && !kept(x, z) && !entrances.has(`${x},${z}`) && !spillCols.has(`${x},${z}`);
  const standY = (x, z, h) => {
    const [lo, hi] = vw.colRange(x, z);
    // the column's top floor: supported (solid, not a fluid), not a walk cell, with air for the fixture above it
    for (let y = hi + 2; y >= lo - 1; y--) {
      const f = vw.get(x, y - 1, z);
      if (P.air[f]) continue;
      if (!P.solid[f] || P.fluid[f] || (vw.flags(x, y - 1, z) & F_WALK)) return null;
      for (let k = 0; k < h; k++) if (!P.air[vw.get(x, y + k, z)]) return null;
      return y;
    }
    return null;
  };
  const cands = [];
  const order = [...ir.lots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = [[], [], []];
  for (const l of order) {
    const b = l.box, x0 = b.minX, x1 = b.maxX, z0 = b.minZ, z1 = b.maxZ;
    const mx = Math.floor((x0 + x1) / 2), mz = Math.floor((z0 + z1) / 2);
    const qx = [Math.floor((x0 + mx) / 2), Math.floor((mx + x1) / 2)], qz = [Math.floor((z0 + mz) / 2), Math.floor((mz + z1) / 2)];
    // 1: the corners outside the apron's diagonal
    for (const [x, z] of [[x0 - 2, z0 - 2], [x1 + 2, z0 - 2], [x0 - 2, z1 + 2], [x1 + 2, z1 + 2]]) groups[0].push({ lot: l.id, x, z });
    // 2: the batter feet next to the apron: edge middles and quarters, one ring out
    for (const x of [mx, ...qx]) for (const z of [z0 - 2, z1 + 2]) groups[1].push({ lot: l.id, x, z });
    for (const z of [mz, ...qz]) for (const x of [x0 - 2, x1 + 2]) groups[1].push({ lot: l.id, x, z });
    // 3: further out (the foot of a deeper batter)
    for (const d of [3, 4]) {
      for (const [x, z] of [[x0 - d, z0 - d], [x1 + d, z0 - d], [x0 - d, z1 + d], [x1 + d, z1 + d]]) groups[2].push({ lot: l.id, x, z });
      for (const x of [mx, ...qx]) for (const z of [z0 - 1 - d, z1 + 1 + d]) groups[2].push({ lot: l.id, x, z });
      for (const z of [mz, ...qz]) for (const x of [x0 - 1 - d, x1 + 1 + d]) groups[2].push({ lot: l.id, x, z });
    }
  }
  // (6c T2) a caller's extra candidates (beside a route: `{lot: key, x, z}`), after the lots' own, each key capped by extraCap
  if (extra.length) groups.push([...extra]);
  const seen = new Set();
  for (const g of groups) {
    g.sort((a, b) => (a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0) || a.x - b.x || a.z - b.z);
    for (const c of g) {
      const key = `${c.x},${c.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arms = fixture.kind === 'hanging_lantern' ? ARM_DIRS : [undefined];
      for (const arm of arms) {
        if (!colOk(c.x, c.z)) break;
        const y = standY(c.x, c.z, fixture.kind === 'hanging_lantern' ? 3 : fixture.height);
        if (y === null) break;
        const fc = fixtureCells(fixture, [c.x, y, c.z], { arm });
        // every footprint column free (the gibbet's arm column: off walk cells, lanes and boxes), every cell in air
        if (!fc.foot.every(([x, z]) => colOk(x, z)) || !fc.cells.every(([x, yy, z]) => P.air[vw.get(x, yy, z)] && !(vw.flags(x, yy - 1, z) & F_WALK))) continue;
        // ((6c KC, §4) never a fixture cell on a body's hard set or in its watch: the lamp is skipped (M5 still judges the lighting))
        if (keep.length && fc.cells.some(([x, yy, z]) => keptBy(keep, x, yy, z))) { keptSkipped++; continue; }
        if (_drop && _drop.has(`${c.x},${c.z}`)) break;
        cands.push({ ...c, y, arm, cells: fc.cells, lightAt: fc.lightAt, foot: fc.foot });
        break;
      }
    }
  }
  // ---- each candidate's reach over the targets (its own light, the fixture's level)
  for (const c of cands) {
    const L = lightFrom(vw, [[...c.lightAt, fixture.level]], opaque, inArea);
    c.reach = [];
    for (const [k, v] of L) if (v > 0) { const i = tIndex.get(k); if (i !== undefined) c.reach.push(i); }
  }
  // ---- greedy
  const chosen = [];
  const perLot = Object.fromEntries(ir.lots.map((l) => [l.id, 0]));
  for (const c of extra) perLot[c.lot] ??= 0;
  const capOf = (k) => extraCap[k] ?? maxPerLot;
  const reachDark = () => { let n = 0; for (const i of reachT) if (dark.has(i)) n++; return n; };
  const goal = () => (targets.length === 0 || dark.size / targets.length < share) && (!reachT.size || reachDark() / reachT.size < share);
  const taken = new Set();
  while (!goal()) {
    let best = null, gain = 0;
    for (const c of cands) {
      if (taken.has(c) || perLot[c.lot] >= capOf(c.lot)) continue;
      if (c.foot.some(([x, z]) => chosen.some((o) => o.foot.some(([ox, oz]) => Math.abs(ox - x) + Math.abs(oz - z) <= 1)))) continue; // never side by side
      // ((6c FL) `lampGap`: no lamp within that far (Chebyshev) of another light, the region's own or one chosen here; 0: no rule)
      if (lampGap > 0 && [...lights0, ...chosen.map((o) => o.lightAt)].some((q) => Math.max(Math.abs(q[0] - c.lightAt[0]), Math.abs(q[2] - c.lightAt[2])) < lampGap)) continue;
      let g = 0;
      for (const i of c.reach) if (dark.has(i)) g++;
      if (g > gain) { gain = g; best = c; }
    }
    if (!best) break;
    taken.add(best);
    chosen.push(best);
    perLot[best.lot]++;
    for (const i of best.reach) dark.delete(i);
  }
  // ---- the lamps must not cut a walk node off the entrance
  if (chosen.length) {
    for (const c of chosen) for (const [x, y, z, s] of c.cells) vw.set(x, y, z, P.of(s), 0);
    const g = walkGraph(vw, start ? [start] : []);
    const lost = nodes.filter((n, i) => nodesOk0[i] && !nodeReached(g, n.at));
    if (lost.length) {
      // drop the lamps nearest each lost node and plan the cover again without their columns
      const drop = new Set(_drop ?? []);
      for (const n of lost) {
        let near = null, nd = Infinity;
        for (const c of chosen) { const d = Math.abs(c.x - n.at[0]) + Math.abs(c.z - n.at[2]); if (d < nd) { nd = d; near = c; } }
        if (near) drop.add(`${near.x},${near.z}`);
      }
      if (drop.size > (_drop?.size ?? 0)) return lightCover(r, { fixture, stage, keepOut, reserved, laneCells, maxPerLot, share, extra, extraCap, part, _drop: drop, _format1, ...(reach ? { reach } : {}) });
    }
  }
  const after = { targets: targets.length, dark: dark.size, share: targets.length ? dark.size / targets.length : 0 };
  const capped = !goal();
  // ---- emit
  const lamps = chosen.map((c) => ({ lot: c.lot, at: [c.x, c.y, c.z], cells: c.cells }));
  lamps.sort((a, b) => (a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0) || a.at[0] - b.at[0] || a.at[2] - b.at[2]);
  if (lamps.length) {
    const lp = r.part(part, { stage });
    const mats = [], mi = new Map(), cols = [];
    for (const l of lamps) for (const [x, y, z, s] of l.cells) {
      let i = mi.get(s);
      if (i === undefined) { i = mats.length; mats.push(s); mi.set(s, i); }
      cols.push(x, z, y, y, i);
    }
    // natural cells only (not into air only): the plan survey has no plants, so a lamp's post cell may hold short grass or a
    // flower the plan reads as air; IF_AIR_OR_FLUID would skip it and leave the light floating (S7's first W run: 2 of 7)
    lp._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: COND.IF_NATURAL, walk: false });
    (r.meta.parts[lp.id] ??= {}).kind = 'add';
  }
  // each lot's lamp positions on its ext (Steward's panels; later additions keep clear of them)
  for (const l of r.lots) {
    const v = l.ext?.['architect_mc:village'];
    if (v) v.lamps = lamps.filter((m) => m.lot === l.id).map((m) => [...m.at]);
  }
  const counts = Object.fromEntries(Object.entries(perLot).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  r.note(`apron lamps (${fixture.kind}, light ${fixture.level}): ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}; dark ${(100 * before.share).toFixed(1)}% -> ${(100 * after.share).toFixed(2)}% of ${targets.length} walk cells at plan time${capped ? ` (capped at ${maxPerLot} per lot: not covered)` : ''}`);
  return { lamps, perLot: counts, before, after, targets: targets.length, capped, fixture: { kind: fixture.kind, level: fixture.level }, ...(keptSkipped ? { keptSkipped } : {}), ...(reach ? { reach: { targets: reachT.size, dark: reachDark() } } : {}) };
}
