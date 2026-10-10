// Phase 6a gate item 1 (kit): every 6a primitive's guarantee as a property over seeded random params, checked on the
// evaluator's real output (planned, then every tile realised against the same frozen heights): stairs, bridges,
// terraces, pads, ring gates, pillars; conditions, last-op-wins and claim clipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { region, COND } from '../lib/region/program.mjs';
import { compassDir } from '../lib/region/geom.mjs';
import { insidePolygon, polygonDistance } from '../lib/sdf.mjs';
import { planInline, prng, realiseAll, worldOf } from './region-helpers.mjs';

const AIR = 'minecraft:air';
const anchors = (r, c) => { r.anchor('spawn', [c.minX + 2, c.minZ + 2]); r.anchor('entrance', [c.minX + 3, c.minZ + 2]); };
const at = (cells, x, y, z) => cells.get(`${x},${y},${z}`);
/** cross-section check along a path's centre cells (axis from the next/previous cell): every offset of the width (or,
 * with `state`, the two offsets just outside it) holds a cell (walk, or of `state` at y + dy) within `tol` of y */
function walkNear(cells, centre, width, tol, state = null, dy = 0) {
  const offs = [];
  for (let k = -Math.floor((width - 1) / 2); k <= Math.floor(width / 2); k++) offs.push(k);
  const ks = state ? [offs[0] - 1, offs[offs.length - 1] + 1] : offs;
  let misses = 0;
  for (let i = 0; i < centre.length; i++) {
    const [x, y, z] = centre[i];
    // the segment axis: the dominant direction to a cell a few steps along
    const j = Math.min(centre.length - 1, i + 3), h = Math.max(0, i - 3);
    const dx = centre[j][0] - centre[h][0], dz = centre[j][2] - centre[h][2];
    const axes = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    let ok = false;
    for (const r of axes) {
      if (ks.every((k) => {
        for (let e = -tol; e <= tol; e++) {
          const c = cells.get(`${x + r[0] * k},${y + dy + e},${z + r[1] * k}`);
          if (c && (state ? c.state === state : c.walk)) return true;
        }
        return false;
      })) { ok = true; break; }
    }
    if (!ok && (dx || dz)) misses++;
  }
  return misses;
}

test('stair: rise <= 1 per step, a 2-cell landing at least every landingEvery steps, full width, 2 headroom, walk treads', async () => {
  const R = prng(11);
  for (let t = 0; t < 12; t++) {
    const world = worldOf({ seed: `stair${t}` });
    const landingEvery = R.int(3, 8), width = R.int(1, 4);
    const x0 = R.int(40, 60), z0 = R.int(40, 60);
    const len = R.int(14, 40);
    const d = compassDir(R.int(0, 7) * 45);
    const x1 = Math.round(x0 + d[0] * len), z1 = Math.round(z0 + d[1] * len);
    const y0 = 80, rise = R.int(-Math.floor(len * 0.6), Math.floor(len * 0.6));
    const mid = [Math.round((x0 + x1) / 2) + R.int(-5, 5), Math.round((z0 + z1) / 2) + R.int(-5, 5)];
    let out;
    const { ir } = await planInline((ctx) => {
      const r = region(ctx);
      out = r.part('s', { set: 'path' }).stair([[x0, y0, z0], [mid[0], y0 + Math.round(rise / 2), mid[1]], [x1, y0 + rise, z1]], { width, landingEvery, railing: 'rail' });
      anchors(r, ctx.claim);
      return r;
    }, { world });
    const cells = realiseAll(ir, world);
    const ys = out.cells.map((c) => c[1]);
    let flight = 0, flat = 0;
    for (let i = 1; i < ys.length; i++) {
      const dy = Math.abs(ys[i] - ys[i - 1]);
      assert.ok(dy <= 1, `step ${i} rises ${dy}`);
      if (dy) { assert.ok(flight < landingEvery, `stair ${t}: more than ${landingEvery} steps without a landing at ${i}`); flight++; flat = 0; } else { flat++; if (flat >= 2) flight = 0; }
    }
    assert.equal(ys[0], y0); assert.equal(ys[ys.length - 1], y0 + rise);
    for (const [x, y, z] of out.cells) {
      const c = at(cells, x, y, z);
      assert.ok(c && c.walk && c.state !== AIR, `stair ${t}: tread at ${x},${y},${z}`);
      assert.equal(c.cond, COND.ALWAYS_OURS, 'a path part turns IF_NATURAL into ALWAYS_OURS');
      for (const h of [1, 2]) {
        const above = at(cells, x, y + h, z);
        assert.ok(above, `stair ${t}: headroom ${h} over ${x},${y},${z}`);
        if (above.state !== AIR) assert.ok(above.walk, `stair ${t}: headroom ${h} over ${x},${y},${z} is a tread of the stair itself (a turn), else air`);
      }
    }
    // full width: every centre cell's cross-section column holds a walk cell within 2 of its y
    assert.equal(walkNear(cells, out.cells, width, 2), 0, `stair ${t}: full width`);
  }
});

test('stair: too steep fails at plan with the numbers; spiral turns keep headroom', async () => {
  await assert.rejects(planInline((ctx) => {
    const r = region(ctx);
    r.part('s', { set: 'path' }).stair([[10, 70, 10], [20, 82, 10]]);
    anchors(r, ctx.claim);
    return r;
  }), /rises 12 over 10 cells.*needs at least/);
  const world = worldOf({ flat: 60 });
  let out;
  const { ir } = await planInline((ctx) => {
    const r = region(ctx);
    out = r.part('s', { set: 'path' }).stair({ center: [60, 60], radius: 4, top: 100, bottom: 61, start: 90 }, { spiral: true });
    anchors(r, ctx.claim);
    return r;
  }, { world });
  const cells = realiseAll(ir, world);
  const ys = out.cells.map((c) => c[1]);
  assert.equal(ys[0], 100); assert.equal(ys[ys.length - 1], 61);
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) <= 1);
  for (const [x, y, z] of out.cells) {
    assert.ok(at(cells, x, y, z)?.walk);
    for (const h of [1, 2]) assert.equal(at(cells, x, y + h, z)?.state, AIR, `spiral headroom over ${x},${y},${z}`);
  }
  assert.ok(at(cells, 60, 80, 60) && at(cells, 60, 80, 60).state !== AIR, 'the core');
});

test('bridge: continuous deck at width, rise <= 1 per block, rails both sides, headroom, supports <= every <= maxSpan reaching the floor', async () => {
  const R = prng(5);
  for (let t = 0; t < 10; t++) {
    const world = worldOf({ seed: `bridge${t}` });
    const width = R.int(1, 5), every = R.int(4, 16), maxSpan = every + R.int(0, 8);
    const x0 = R.int(20, 40), z0 = R.int(20, 40), len = R.int(30, 120);
    const d = compassDir(R.int(0, 15) * 22.5);
    const x1 = Math.round(x0 + d[0] * len), z1 = Math.round(z0 + d[1] * len);
    const y0 = R.int(90, 100), y1 = y0 + R.int(-20, 20);
    const ox = 128 - Math.round((x0 + x1) / 2), oz = 128 - Math.round((z0 + z1) / 2); // centred in the claim
    let out;
    const claim = { minX: 0, minZ: 0, maxX: 255, maxZ: 255, minY: -64, maxY: 319 };
    const ok = Math.abs(y1 - y0) <= Math.abs(x1 - x0) + Math.abs(z1 - z0);
    const plan = planInline((ctx) => {
      const r = region(ctx);
      out = r.part('b', { set: 'path' }).bridge([[x0 + ox, y0, z0 + oz], [x1 + ox, y1, z1 + oz]], { width, supports: { every }, maxSpan });
      anchors(r, ctx.claim);
      return r;
    }, { world, claim });
    if (!ok) { await assert.rejects(plan, /at most 1 per block/); continue; }
    const { ir } = await plan;
    const cells = realiseAll(ir, world);
    const ys = out.cells.map((c) => c[1]);
    for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) <= 1, `bridge ${t} rise at ${i}`);
    for (const [x, y, z] of out.cells) {
      const c = at(cells, x, y, z);
      assert.ok(c && c.walk && c.state !== AIR, `bridge ${t}: deck at ${x},${y},${z}`);
      assert.equal(c.cond, COND.IF_AIR_OR_FLUID);
      for (const h of [1, 2]) assert.equal(at(cells, x, y + h, z)?.state, AIR, `bridge ${t}: headroom`);
    }
    assert.equal(walkNear(cells, out.cells, width, 1), 0, `bridge ${t}: the deck is continuous at its width`);
    // rails on both sides: every deck cell's neighbours are deck or rail, except at the two ends
    const ends = [out.cells[0], out.cells[out.cells.length - 1]];
    for (const c of cells.values()) {
      if (!c.walk) continue;
      if (ends.some(([x, , z]) => Math.abs(c.x - x) + Math.abs(c.z - z) <= width + 2)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const near = [-1, 0, 1, 2].map((e) => at(cells, c.x + dx, c.y + e, c.z + dz)).filter(Boolean);
        assert.ok(near.some((n) => n.walk || n.state === 'minecraft:oak_fence'), `bridge ${t}: the deck at ${c.x},${c.y},${c.z} is open to the ${dx},${dz} side`);
      }
    }
    // supports: gaps at most `every` (<= maxSpan), each reaching the frozen floor
    const s = out.supports;
    assert.equal(s[0], 0); assert.equal(s[s.length - 1], out.cells.length - 1);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] <= every && every <= maxSpan, `bridge ${t}: span ${s[i] - s[i - 1]}`);
    for (const i of s) {
      const [x, y, z] = out.cells[i];
      const f = world(x, z).f;
      for (let yy = f + 1; yy < y; yy++) assert.ok(at(cells, x, yy, z)?.state === 'minecraft:stone_bricks', `bridge ${t}: support ${i} at y ${yy} (floor ${f}, deck ${y})`);
    }
  }
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('b', { set: 'path' }).bridge([[10, 80, 10], [60, 80, 10]], { supports: { every: 30 }, maxSpan: 24 }); anchors(r, ctx.claim); return r; }), /over maxSpan/);
});

test('terrace: every level flat at its y (cut above, filled below), risers within riser or walled, stairs between levels', async () => {
  const R = prng(9);
  for (let t = 0; t < 6; t++) {
    const world = worldOf({ seed: `terrace${t}` });
    const n = R.int(2, 4), edge = t % 2 ? 'wall' : 'slope', riser = 2, step = edge === 'wall' ? R.int(3, 6) : R.int(1, 2);
    const radius = R.int(30, 50);
    let levels;
    const { ir } = await planInline((ctx) => {
      const r = region(ctx);
      levels = r.part('t').terrace({ center: [96, 96], radius }, n, { edge, riser, step, stairs: true });
      anchors(r, ctx.claim);
      return r;
    }, { world });
    const cells = realiseAll(ir, world);
    for (let k = 1; k < n; k++) if (edge === 'slope') assert.ok(Math.abs(levels[k].y - levels[k - 1].y) <= riser);
    let checked = 0;
    for (let x = 96 - radius; x <= 96 + radius; x += 3) {
      for (let z = 96 - radius; z <= 96 + radius; z += 3) {
        const d = Math.sqrt((x - 96) ** 2 + (z - 96) ** 2);
        let k = -1;
        for (let i = 0; i < n; i++) if (d <= levels[i].radius - 1.5 && (i === n - 1 || d >= levels[i + 1].radius + 1.5)) k = i;
        if (k < 0) continue;
        // skip the stair corridors
        const col = [...cells.values()].some((c) => c.x === x && c.z === z && c.walk);
        if (col) continue;
        const y = levels[k].y;
        assert.equal(at(cells, x, y, z)?.state, 'minecraft:grass_block', `terrace ${t} level ${k} top at ${x},${y},${z}`);
        const top = Math.max(world(x, z).h, world(x, z).g);
        for (let yy = y + 1; yy <= top; yy++) assert.equal(at(cells, x, yy, z)?.state, AIR, `terrace ${t}: cut above level ${k} at ${x},${yy},${z}`);
        for (let yy = world(x, z).f + 1; yy < y; yy++) assert.ok(at(cells, x, yy, z) && at(cells, x, yy, z).state !== AIR, `terrace ${t}: fill under level ${k} at ${x},${yy},${z}`);
        checked++;
      }
    }
    assert.ok(checked > 50, `terrace ${t}: checked ${checked} columns`);
    if (n > 1) assert.ok([...cells.values()].some((c) => c.walk), 'stairs join the levels');
  }
  await assert.rejects(planInline((ctx) => { const r = region(ctx); r.part('t').terrace({ center: [96, 96], radius: 40 }, [70, 74], { edge: 'slope', riser: 2 }); anchors(r, ctx.claim); return r; }), /riser 1 is 4/);
});

test('lot pads: the footprint flat at floorY-1 with air to the box top; cut/fill within the limits; over the limits fails with the numbers', async () => {
  const R = prng(3);
  for (let t = 0; t < 10; t++) {
    const world = worldOf({ seed: `pad${t}` });
    const w = R.int(9, 24), d = R.int(9, 24), h = R.int(6, 14), x0 = R.int(30, 120), z0 = R.int(30, 120);
    let lot;
    const res = await planInline((ctx) => {
      const r = region(ctx);
      anchors(r, ctx.claim);
      const ps = ctx.survey.padStats(x0, z0, w, d);
      lot = r.part('p').lot('l', { at: [x0, z0], size: [w, d], max: [w, h, d], pad: { maxCut: Math.max(ps.cut, 1), maxFill: Math.max(ps.fill, 1) }, front: 'toward:spawn' });
      return r;
    }, { world });
    const cells = realiseAll(res.ir, world);
    const L = res.ir.lots[0];
    assert.deepEqual(L.box, { minX: x0, minY: L.floorY, minZ: z0, maxX: x0 + w - 1, maxY: L.floorY + h - 1, maxZ: z0 + d - 1 });
    assert.ok(['north', 'south', 'east', 'west'].includes(L.front));
    assert.equal(L.part, 'p');
    for (let x = x0 - 1; x <= x0 + w; x++) for (let z = z0 - 1; z <= z0 + d; z++) {
      const inFoot = x >= x0 && x < x0 + w && z >= z0 && z < z0 + d;
      // the footprint's top is the foundation; (6b addition) the apron keeps the ground: untouched, or the surface role in a gap
      if (inFoot) assert.ok([undefined, 'minecraft:grass_block'].includes(at(cells, x, L.floorY - 1, z)?.state), `pad ${t}: top at ${x},${z}: ${at(cells, x, L.floorY - 1, z)?.state}`);
      else assert.ok([undefined, 'minecraft:grass_block'].includes(at(cells, x, L.floorY - 1, z)?.state), `pad ${t}: apron top at ${x},${z}: ${at(cells, x, L.floorY - 1, z)?.state}`);
      const top = inFoot ? Math.max(L.box.maxY, world(x, z).h) : Math.max(world(x, z).h, world(x, z).g);
      for (let y = L.floorY; y <= top; y++) assert.equal(at(cells, x, y, z)?.state, AIR, `pad ${t}: clear at ${x},${y},${z}`);
      for (let y = world(x, z).f + 1; y < L.floorY - 1; y++) assert.ok(at(cells, x, y, z)?.state === 'minecraft:cobblestone', `pad ${t}: fill at ${x},${y},${z}`);
      const g = world(x, z).g;
      assert.ok(g - (L.floorY - 1) <= lot.pad.maxCut && (L.floorY - 1) - world(x, z).f <= lot.pad.maxFill, `pad ${t}: within the limits`);
    }
  }
  const world = worldOf({ seed: 'steep' });
  await assert.rejects(planInline((ctx) => {
    const r = region(ctx);
    r.part('p').lot('l', { at: [40, 40], size: [20, 20], floor: 200, pad: { maxCut: 2, maxFill: 2 } });
    return r;
  }, { world }), /lot l: the pad needs a cut of \d+ and a fill of \d+ \(max 2 \/ 2\) at floorY 200/);
});

test('ring: gates clear (width x height) over walk thresholds; the wall follows the surface', async () => {
  const world = worldOf({ seed: 'ring' });
  let gates;
  const { ir } = await planInline((ctx) => {
    const r = region(ctx);
    gates = r.part('w').ring([96, 96], 60, 63.5, { height: 6, gates: [{ angle: 0, width: 3, height: 4 }, { angle: 135, width: 4, height: 5 }, { dir: [1, 0], width: 5, height: 3 }] });
    anchors(r, ctx.claim);
    return r;
  }, { world });
  const cells = realiseAll(ir, world);
  for (const g of gates) {
    const [gx, ty, gz] = g.at;
    let n = 0;
    for (let x = gx - 10; x <= gx + 10; x++) for (let z = gz - 10; z <= gz + 10; z++) {
      if (polygonDistance(g.polygon, x, z) > 0) continue;
      n++;
      assert.ok(at(cells, x, ty, z)?.walk, `gate threshold at ${x},${ty},${z}`);
      for (let y = ty + 1; y <= ty + g.height; y++) assert.equal(at(cells, x, y, z)?.state, AIR, `gate clear at ${x},${y},${z}`);
    }
    assert.ok(n >= g.width * 4, `gate ${g.at}: ${n} threshold columns`);
  }
  // away from the gates the wall stands on the frozen ground, height + 1 cells
  for (const [x, z] of [[96, 96 + 62], [96 - 62, 96], [96 - 44, 96 - 44]]) {
    const g = world(x, z).g;
    for (let y = g; y <= g + 6; y++) assert.equal(at(cells, x, y, z)?.state, 'minecraft:stone_bricks', `wall at ${x},${y},${z}`);
    assert.equal(at(cells, x, g + 7, z), undefined);
  }
});

test('pillar: reaches the first solid cell under the frozen surface (the floor under water)', async () => {
  const world = (x, z) => (x < 100 ? { g: 70, h: 70, f: 70, flags: 0 } : { g: 62, h: 62, f: 50, flags: 1 });
  const { ir } = await planInline((ctx) => {
    const r = region(ctx);
    const p = r.part('p');
    p.pillar([50, 90, 50], { size: 2 });
    p.pillar([150, 90, 150], { size: 3 });
    p.pillar([60, 90, 60], { bottom: 40 });
    anchors(r, ctx.claim);
    return r;
  }, { world });
  const cells = realiseAll(ir, world);
  for (let y = 71; y <= 90; y++) for (const [x, z] of [[50, 50], [51, 51]]) assert.ok(at(cells, x, y, z), `pillar 1 at ${y}`);
  assert.equal(at(cells, 50, 70, 50), undefined);
  for (let y = 51; y <= 90; y++) for (const [x, z] of [[149, 149], [151, 151]]) assert.ok(at(cells, x, y, z), `pillar 2 at ${y}`);
  assert.ok(at(cells, 60, 40, 60) && at(cells, 60, 40, 60).cond === COND.IF_AIR_OR_FLUID, 'bottom reaches below the floor');
});

test('conditions, last-op-wins, later stages and claim clipping', async () => {
  const world = worldOf({ flat: 64 });
  const claim = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: 0, maxY: 200 };
  const { ir } = await planInline((ctx) => {
    const r = region(ctx);
    r.stages(['one', 'two']);
    const a = r.part('a', { stage: 'one' });
    a.carve({ kind: 'box', min: [10, 60, 10], max: [20, 70, 20] }, { lining: 'rubble' });
    a.add({ kind: 'box', min: [30, 65, 30], max: [35, 66, 35] }, 'structure');
    a.fill({ kind: 'box', min: [40, 70, 40], max: [45, 71, 45] }, 'minecraft:stone');
    a.fill({ kind: 'box', min: [43, 70, 43], max: [48, 71, 48] }, 'minecraft:oak_planks');
    // outside the claim on two sides
    a.fill({ kind: 'box', min: [120, 190, 60], max: [135, 210, 61] }, 'minecraft:glass');
    r.part('b', { stage: 'two' }).fill({ kind: 'box', min: [50, 70, 50], max: [51, 70, 51] }, 'minecraft:dirt');
    anchors(r, ctx.claim);
    return r;
  }, { world, claim });
  const cells = realiseAll(ir, world);
  assert.equal(at(cells, 15, 64, 15).cond, COND.IF_NATURAL);
  assert.equal(at(cells, 15, 64, 15).state, AIR);
  assert.equal(at(cells, 15, 65, 15), undefined, 'a carve never writes air into air (clipped to the column top)');
  assert.equal(at(cells, 15, 59, 15).cond, COND.IF_SOLID_NATURAL, 'lining');
  assert.equal(at(cells, 15, 59, 15).state, 'minecraft:cobblestone');
  assert.equal(at(cells, 32, 65, 32).cond, COND.IF_AIR_OR_FLUID, 'add');
  assert.equal(at(cells, 41, 70, 41).state, 'minecraft:stone');
  assert.equal(at(cells, 44, 70, 44).state, 'minecraft:oak_planks', 'the last op wins');
  assert.equal(at(cells, 50, 70, 50).cond, COND.ALWAYS_OURS, 'IF_NATURAL becomes ALWAYS_OURS after the first stage');
  for (const c of cells.values()) assert.ok(c.x <= 127 && c.y <= 200 && c.y >= 0, `clipped: ${c.x},${c.y},${c.z}`);
  assert.equal([...cells.values()].filter((c) => c.state === 'minecraft:glass').length, 8 * 11 * 2);
  // cells above the claim in an evaluated tile are counted; tiles wholly outside the claim are never evaluated
  assert.equal(cells.clipped, 8 * 10 * 2);
});

test('road: ground roads split at 2048 centre cells / 256 points; converted to graded when 4e would refuse; graded grade <= 1 in 4, cut/fill <= 12; optional drops', async () => {
  const flat = worldOf({ flat: 70 });
  const claim = { minX: 0, minZ: 0, maxX: 999, maxZ: 999, minY: -64, maxY: 319 };
  const zig = [[5, 5], [995, 5], [995, 20], [5, 20], [5, 40], [995, 40]];
  let res;
  const p1 = await planInline((ctx) => {
    const r = region(ctx);
    res = r.part('r', { set: 'path' }).road(zig, { id: 'long' });
    anchors(r, ctx.claim);
    return r;
  }, { world: flat, claim });
  assert.equal(res.mode, 'ground');
  const roads = p1.ir.roads;
  assert.ok(roads.length >= 2, `split (${roads.length})`);
  assert.deepEqual(roads.map((x) => x.id), roads.map((_, i) => `long_${i + 1}`));
  let total = 0;
  for (let i = 0; i < roads.length; i++) {
    const pts = roads[i].points;
    assert.ok(pts.length >= 2 && pts.length <= 256);
    let n = 1;
    for (let k = 1; k < pts.length; k++) n += Math.abs(pts[k][0] - pts[k - 1][0]) + Math.abs(pts[k][2] - pts[k - 1][2]);
    assert.ok(n <= 2048, `road ${i}: ${n} centre cells`);
    total += n - (i ? 1 : 0);
    if (i) assert.deepEqual(roads[i][0] ?? roads[i].points[0], roads[i - 1].points[roads[i - 1].points.length - 1], 'consecutive pieces share a point');
    for (const q of pts) assert.equal(q[1], 70, 'y is the survey ground (the 4e hint)');
    assert.equal(roads[i].width, 3); assert.equal(roads[i].lanterns, true); assert.equal(roads[i].stage, 'main');
  }
  assert.equal(total, 990 + 15 + 990 + 20 + 990 + 1);
  assert.equal(p1.ir.budget.cells, 0, 'ground roads are 4e items, not cells');

  // conversions: width 6, water
  const wet = (x, z) => (x > 50 && x < 60 ? { g: 62, h: 62, f: 58, flags: 1 } : { g: 62, h: 62, f: 62, flags: 0 });
  const p2 = await planInline((ctx) => {
    const r = region(ctx);
    const part = r.part('r', { set: 'path' });
    assert.equal(part.road([[10, 10], [40, 10]], { width: 6, id: 'wide' }).mode, 'graded');
    assert.equal(part.road([[10, 30], [100, 30]], { id: 'wet' }).mode, 'graded');
    anchors(r, ctx.claim);
    return r;
  }, { world: wet });
  assert.ok(p2.notes.some((n) => /road wide: converted to graded \(width 6 > 5\)/.test(n)));
  assert.ok(p2.notes.some((n) => /road wet: converted to graded \(water at 51,30\)/.test(n)));
  assert.equal(p2.ir.roads.length, 0);
  assert.equal(p2.ir.paths.filter((x) => x.kind === 'graded').length, 2);

  // graded on hilly land, pinned at the end: walk surface along the centre
  const hilly = worldOf({ seed: 'graded' });
  for (let t = 0; t < 4; t++) {
    const pts = [[20, 20 + 40 * t], [170, 30 + 40 * t]];
    let end;
    const p3 = await planInline((ctx) => {
      const r = region(ctx);
      end = ctx.survey.heightAt(170, 30 + 40 * t) + 3;
      r.part('r', { set: 'path' }).road([pts[0], [pts[1][0], end, pts[1][1]]], { mode: 'graded', width: 3, id: `g${t}` });
      anchors(r, ctx.claim);
      return r;
    }, { world: hilly });
    const cells = realiseAll(p3.ir, hilly);
    const centre = [];
    for (const c of cells.values()) if (c.walk) centre.push(c);
    const byX = new Map();
    for (const c of centre) { const l = byX.get(`${c.x},${c.z}`) ?? []; l.push(c.y); byX.set(`${c.x},${c.z}`, l); }
    for (const [k, l] of byX) assert.equal(l.length, 1, `one surface cell per column (${k})`);
    // walk the 4-connected centre line from the start
    const line = [];
    const [sx, sz] = pts[0], [ex, ez] = pts[1];
    const { line4 } = await import('../lib/region/geom.mjs');
    for (const [x, z] of line4(sx, sz, ex, ez)) line.push(byX.get(`${x},${z}`)[0]);
    for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i] - line[i - 1]) <= 1);
    for (let i = 4; i < line.length; i++) assert.ok(Math.abs(line[i] - line[i - 4]) <= 1, `graded ${t}: grade at ${i}`);
    assert.equal(line[line.length - 1], end, 'the pinned end');
    line4(sx, sz, ex, ez).forEach(([x, z], i) => assert.ok(Math.abs(line[i] - hilly(x, z).g) <= 12, `cut/fill at ${x},${z}`));
  }
  // impossible: optional drops with a note, otherwise the plan fails
  const imp = (optional) => planInline((ctx) => {
    const r = region(ctx);
    r.part('r', { set: 'path' }).road([[20, 20], [60, 20, 250]], { mode: 'graded', optional, id: 'nope' });
    anchors(r, ctx.claim);
    return r;
  }, { world: hilly });
  const dropped = await imp(true);
  assert.ok(dropped.notes.some((n) => /road nope: dropped \(.*needs a cut or fill of \d+/.test(n)));
  await assert.rejects(imp(false), /needs a cut or fill of \d+ at .* \(at most 12\)/);
});
