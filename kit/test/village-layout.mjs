// The flat village's layout properties over seeded synthetic claims (kit/test/village.test.mjs item 1), shared by
// village-layout-1..4.test.mjs: each runs a quarter of the 500 claims, so the suite's files stay short (housekeeping 2: the one
// 500-claim test took 91-138 s and set the kit suite's wall time). Not a test file itself (no .test.mjs).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { STREET_RULES } from '../lib/region/village.mjs';

const PROGRAM = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'regions', 'flat_village.mjs');
const plan = (o) => planRegion({ programFile: PROGRAM, node: 'test', ...o });
const box = (l) => l.box;
const meet = (a, b, g = 0) => a.minX - g <= b.maxX && b.minX - g <= a.maxX && a.minZ - g <= b.maxZ && b.minZ - g <= a.maxZ;

/** A seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (l) => l[Math.floor(f() * l.length)];
  return f;
}

/** A flat survey (ground y) with optional water rects [[x0, z0, x1, z1]] and per-column bumps of +-1. */
export function flatSurvey(claim, { y = 64, water = [], bumps = null } = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W, x = claim.minX + i, z = claim.minZ + j;
    const wet = water.some((r) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]);
    const g = y + (bumps ? bumps(x, z) : 0);
    c.ground[k] = g; c.height[k] = g; c.floor[k] = wet ? g - 3 : g; c.flags[k] = wet ? 1 : 0;
  }
  return c;
}

/** Claims [from, to) of the 500 (seed 1000 + n): every per-claim property asserted; -> { planned, failed, placedTotal }. */
export async function layoutClaims(from, to) {
  const sizes = [[11, 14], [14, 17], [18, 20], [9, 9], [13, 13], [7, 12], [16, 11]];
  const villagers = ['dwelling', 'job', 'trading_hall', 'farm', 'none'];
  let planned = 0, failed = 0, placedTotal = 0;
  const fails = [];
  for (let n = from; n < to; n++) {
    const R = rng(1000 + n);
    const W = R.int(64, 160), D = R.int(64, 160);
    const claim = { minX: R.int(-300, 300), minZ: R.int(-300, 300), minY: -64, maxY: 319 };
    claim.maxX = claim.minX + W - 1; claim.maxZ = claim.minZ + D - 1;
    const water = R() < 0.4 ? [[claim.minX + R.int(0, W - 10), claim.minZ + R.int(0, D - 10), 0, 0]].map((r) => [r[0], r[1], r[0] + R.int(3, 12), r[1] + R.int(3, 12)]) : [];
    const keepOut = R() < 0.3 ? [[claim.minX + R.int(0, W - 20), claim.minZ + R.int(0, D - 20), 0, 0]].map((r) => [r[0], r[1], r[0] + R.int(4, 30), r[1] + R.int(4, 30)]) : [];
    const lots = Array.from({ length: R.int(1, 24) }, (_, i) => ({ id: `lot_${i}`, type: R.pick(['cottage', 'smithy', 'farm', 'hall', 'shop']), size: R.pick(sizes),
      villager: R.pick(villagers), ...(R() < 0.2 ? { placement: R.pick(['central', 'edge', 'near_water', 'high_ground']) } : {}), ...(R() < 0.1 ? { landmark: true } : {}) }));
    const survey = flatSurvey(claim, { water, bumps: R() < 0.5 ? (x, z) => ((x * 7 + z * 13) % 11 === 0 ? 1 : 0) : null });
    const params = { lots, squareSize: R.pick([9, 11, 13, 15]), laneWidth: R.int(1, 3), lamps: R.pick(['none', 'few', 'street']), apronLamps: R() < 0.1 };
    let p;
    try {
      p = await plan({ params, survey, claim, keepOut, seed: String(n + 1) });
    } catch (e) {
      // nothing is forced: a claim with no street or shared space fails the plan with its reason
      assert.match(e.message, /^flat village: (shared square|the street|no street|requireAll)/, `claim ${n}: ${e.message}`);
      failed++;
      continue;
    }
    planned++;
    const ir = p.ir, v = p.meta.village;
    placedTotal += ir.lots.length;
    const m = STREET_RULES.claimMargin;
    for (const l of ir.lots) {
      const b = box(l);
      assert.ok(b.minX >= claim.minX + m && b.maxX <= claim.maxX - m && b.minZ >= claim.minZ + m && b.maxZ <= claim.maxZ - m, `claim ${n}: lot ${l.id} inside the margin`);
      for (const o of ir.lots) if (o !== l && v.lots[l.id].slot === 'street' && v.lots[o.id].slot === 'street') assert.ok(!meet(b, box(o), STREET_RULES.lotGap), `claim ${n}: ${l.id} and ${o.id} keep the gap`);
      for (const o of ir.lots) if (o !== l) assert.ok(!meet(b, box(o)), `claim ${n}: ${l.id} and ${o.id} overlap`);
      for (const k of keepOut) assert.ok(!meet({ minX: b.minX - 1, maxX: b.maxX + 1, minZ: b.minZ - 1, maxZ: b.maxZ + 1 }, { minX: k[0], minZ: k[1], maxX: k[2], maxZ: k[3] }), `claim ${n}: lot ${l.id} meets keep-out`);
      // fronting: the entrance (the cell outside the front edge's middle) is a walk cell of the street's verge or the square
      const e = v.lots[l.id].entrance;
      const lc = v.lanes[l.id];
      assert.ok(lc && lc.some((c) => c[0] === e[0] && c[2] === e[2]), `claim ${n}: lot ${l.id}'s lane starts at its entrance`);
      for (const [x, , z] of lc) {
        for (const o of ir.lots) assert.ok(!(x >= o.box.minX && x <= o.box.maxX && z >= o.box.minZ && z <= o.box.maxZ), `claim ${n}: lane ${l.id} inside lot ${o.id}`);
        for (const k of keepOut) assert.ok(!(x >= k[0] && x <= k[2] && z >= k[1] && z <= k[3]), `claim ${n}: lane ${l.id} in keep-out`);
      }
    }
    // unplaced exact: placed + unplaced = the lot list, disjoint
    const placed = new Set(ir.lots.map((l) => l.id)), un = new Set(v.unplaced.map((u) => u.id));
    assert.equal(placed.size + un.size, lots.length, `claim ${n}: placed + unplaced`);
    for (const l of lots) assert.ok(placed.has(l.id) !== un.has(l.id), `claim ${n}: ${l.id} once`);
    if (un.size) assert.ok(p.notes.includes(`unplaced: ${v.unplaced.map((u) => u.id).join(', ')}`), `claim ${n}: the unplaced note`);
    // deterministic (every 25th claim planned again)
    if (n % 25 === 0) assert.equal((await plan({ params, survey, claim, keepOut, seed: String(n + 1) })).irSha, p.irSha, `claim ${n}: deterministic`);
  }
  fails.length = 0;
  return { planned, failed, placedTotal };
}

/** The 500-claim test's totals (at least 400 planned, over 3 lots a plan), held per quarter: each quarter plans at least 100. */
export function assertQuarter({ planned, failed, placedTotal }) {
  assert.ok(planned >= 100, `most claims plan (${planned} planned, ${failed} refused)`);
  assert.ok(placedTotal > planned * 3, `lots are placed (${placedTotal} over ${planned} plans)`);
}
