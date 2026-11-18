// (8c SE) The settle step (8c contract §2.5, §2.6; slice SE): the bounds and caps of a wm body (rounds: settleBound x 4 in game ticks;
// 4,096 predicted flowing cells; 64 chunks of its watch set), the region's two (32,768 flowing cells, 8 river bodies), the typed
// UNSETTLED (flowing.mjs's shape: the cap hit, say, wouldFit), the breach per bank segment (a superset of its single breaches, each
// segment against BREACH_CAP), the breach from the settled state equal to a fresh one, and the water lint's W3 per bank segment over a
// stepped current. Every non-wm body is simulated exactly as before (the corpus shards and the byte-identity check cover that).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, steady, reach, mapWorld, settleBound, wmMaxTick, watchChunks, bankSegments, BANK_SEGMENT, PATH_CAP, BREACH_CAP, WM_MODEL, FACE } from '../lib/fluids/sim.mjs';
import { LIMITS, unsettledAnswer } from '../lib/fluids/flowing.mjs';
import { unsettledRefusal, regionCapOf } from '../lib/fluids/body.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const k3 = (x, y, z) => `${x},${y},${z}`;
const WM = { order: 'yxz', onCap: 'result' };

/**
 * A pure stepped current (§2.6's shape): `width` lanes at z 0..width-1 between walls, a head reach of 3 sources at x -3..-1 on y H, then
 * `runs` runs of `run` cells, run k's water at H - k over its bed, each ending in a 1-block step; past the last run a flat bed (the flow
 * spreads its last 7 there, between the walls).
 */
function stepped({ runs, run = 6, width = 3, H = 200, z0 = 0 }) {
  const bed = (x) => (x < 0 ? H - 1 : H - 1 - Math.min(runs, Math.floor(x / run)));
  const at = (x, y, z) => (z < z0 || z >= z0 + width || x <= -4 || x > run * runs + 12 || y <= bed(x) ? 'stop' : 'open');
  const cells = [];
  for (let x = -3; x <= -1; x++) for (let z = z0; z < z0 + width; z++) cells.push([x, H, z]);
  return { world: mapWorld(new Map(), at), cells, at };
}

test('SE rounds: a wm body\'s cap is settleBound(min(PATH_CAP, reach)) x 4 game ticks; steady\'s maxTick makes it a typed cap; H keeps its throw', () => {
  assert.equal(PATH_CAP, 512);
  assert.equal(wmMaxTick('water', 10), settleBound('water', 10) * 4);
  assert.equal(wmMaxTick('water', 100000), settleBound('water', 512) * LIMITS.roundsFactor);
  assert.equal(wmMaxTick('water', 100000), 10360);
  const { at, cells } = stepped({ runs: 4 });
  const done = steady(at, cells, 'water', WM);
  assert.equal(done.unsettled, undefined);
  const cut = steady(at, cells, 'water', { ...WM, maxTick: 40 });
  assert.equal(cut.unsettled.cap, 'rounds');
  assert.equal(cut.unsettled.limit, 40);
  assert.ok(cut.ticks <= 40, `no tick past the cap (${cut.ticks})`);
  // (the default rounds cap, as WM left it, for any body; H's steady still throws)
  assert.throws(() => steady(at, cells, 'water', { maxTicks: 2 }), /did not settle/);
  // a wm body settles well inside its cap: its last tick within settleBound(path), its cap 4 times that or more
  const b = simulate({ at }, [{ id: 'b', fluid: 'water', level: 200, cells, model: WM_MODEL }]).bodies[0];
  assert.equal(b.unsettled, undefined);
  assert.ok(b.settleTicks * 4 <= wmMaxTick('water', b.reached.length));
});

test('SE cells: past 4,096 predicted flowing cells a wm body is UNSETTLED {cap: cells}; at 4,095 it settles; an H body has no cap', () => {
  // 5 lanes at z 3..7 (one z chunk) x 7 cells a run, plus the flat's: 114 runs just under the cap, 118 over it
  const under = stepped({ runs: 114, width: 5, z0: 3 });
  const u = simulate(under.world, [{ id: 'u', fluid: 'water', level: 200, cells: under.cells, model: WM_MODEL }]);
  const ub = u.bodies[0];
  assert.ok(ub.predicted.length <= LIMITS.cellsPerBody && ub.predicted.length > 3900, `${ub.predicted.length}`);
  assert.equal(ub.unsettled, undefined);
  assert.ok(!u.findings.some((f) => f.rule === 'UNSETTLED'));
  const over = stepped({ runs: 118, width: 5, z0: 3 });
  const o = simulate(over.world, [{ id: 'o', part: 'river', fluid: 'water', level: 200, cells: over.cells, model: WM_MODEL }]);
  const ob = o.bodies[0];
  assert.equal(ob.unsettled.cap, 'cells');
  assert.equal(ob.unsettled.limit, 4096);
  assert.ok(ob.unsettled.cells > 4096 && ob.unsettled.sample.length === 16);
  const f = o.findings.find((q) => q.rule === 'UNSETTLED');
  assert.equal(f.cap, 'cells');
  assert.equal(f.part, 'river');
  const h = simulate(over.world, [{ id: 'h', fluid: 'water', level: 200, cells: over.cells }]);
  assert.ok(h.bodies[0].predicted.length > 4096 && h.bodies[0].unsettled === undefined && !h.findings.some((q) => q.rule === 'UNSETTLED'), 'H, HY and IRR bodies: no cap');
});

test('SE chunks: a watch set meeting more than 64 chunks is UNSETTLED {cap: chunks}; chunks floor negative coordinates (x >> 4)', () => {
  assert.equal(watchChunks([[[0, 0, 0]]]), 4, 'x -2..2, z -2..2: chunks -1 and 0 each way');
  assert.equal(watchChunks([[[8, 0, 8]]]), 1);
  assert.equal(watchChunks([[[-14, 0, 8]]]), 1, '-16 >> 4 = -1, -12 >> 4 = -1');
  assert.equal(watchChunks([[[-15, 0, 8]]]), 2, '-17 >> 4 = -2');
  // a 1-wide current at z 0 (z chunks -1 and 0): 100 runs, 600 cells long (about 38 x chunks, 2 z chunks each): 76 chunks, 707 cells
  const s = stepped({ runs: 100, width: 1 });
  const b = simulate(s.world, [{ id: 'c', fluid: 'water', level: 200, cells: s.cells, model: WM_MODEL }]).bodies[0];
  assert.ok(b.predicted.length < LIMITS.cellsPerBody);
  assert.ok(b.chunks > 64, `${b.chunks}`);
  assert.equal(b.unsettled.cap, 'chunks');
  const short = stepped({ runs: 40, width: 1 });
  const sb = simulate(short.world, [{ id: 'c', fluid: 'water', level: 200, cells: short.cells, model: WM_MODEL }]).bodies[0];
  assert.ok(sb.chunks <= 64 && sb.unsettled === undefined, `${sb.chunks}`);
});

test('SE region: more than 8 river bodies, or more than 32,768 flowing cells over them, is UNSETTLED regionBodies / regionCells; H bodies don\'t count', () => {
  const wm = (n) => ({ model: WM_MODEL, predicted: Array.from({ length: n }, (_, i) => [i, 0, 0, 1]) });
  const r = { _fluidBodies: [wm(4000), wm(4000), { predicted: Array.from({ length: 9000 }, () => [0, 0, 0, 1]) }] };
  assert.equal(regionCapOf(r, 4000), null);
  assert.equal(regionCapOf({ _fluidBodies: Array.from({ length: 7 }, () => wm(10)) }, 10), null, '8 river bodies fit');
  const b9 = regionCapOf({ _fluidBodies: Array.from({ length: 8 }, () => wm(10)) }, 10);
  assert.equal(b9.cap, 'regionBodies');
  assert.equal(b9.limit, 8);
  const c2 = regionCapOf({ _fluidBodies: Array.from({ length: 7 }, () => wm(4096)) }, 4096);
  assert.equal(c2, null, 'exactly 32,768');
  const c3 = regionCapOf({ _fluidBodies: Array.from({ length: 7 }, () => wm(4096)) }, 4097);
  assert.equal(c3.cap, 'regionCells');
  assert.equal(c3.cells, 32769);
});

test('SE UNSETTLED: the refusal carries flowing.mjs\'s answer shape (code, say, evidence {body, cap, limit, regionWide, cells, rounds, sample}, wouldFit)', () => {
  const e = unsettledRefusal('river_r1', { cap: 'cells', limit: 4096, cells: 4200, rounds: 900, sample: [[1, 2, 3]] }, { part: 'river' });
  assert.match(e.message, /^UNSETTLED: body river_r1: /);
  const want = unsettledAnswer({ part: 'river', body: 'river_r1', cap: 'cells', cells: 4200, rounds: 900, sample: [[1, 2, 3]] }).reasons[0];
  assert.deepEqual(e.evidence, want.evidence);
  assert.equal(e.say, 'The river was too long to settle here; it waits');
  assert.equal(e.wouldFit, undefined);
  const r = unsettledRefusal('river_r1', { cap: 'rounds', limit: 10360, cells: 50, rounds: 2073, sample: [] }, { part: 'river', wouldFit: [{ fragment: { flow: 'pools' }, why: 'source', cells: 0 }] });
  assert.deepEqual([r.evidence.cap, r.evidence.limit, r.evidence.regionWide], ['rounds', 10360, false]);
  assert.equal(r.say, 'The river was too long to settle here; a shorter one fits');
  assert.deepEqual(r.wouldFit, [{ part: 'river', fragment: { flow: 'pools' }, why: 'source', cells: 0 }]);
  const g = unsettledRefusal('river_r1', { cap: 'regionBodies', limit: 8, cells: 100, rounds: 0, sample: [] }, { part: 'river' });
  assert.equal(g.evidence.regionWide, true);
});

// ------------------------------------------------------------------ the breach per bank segment

/** A seeded LCG (no clock, no Math.random). */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** A small wm scene: a 2-deep basin of sources in a raised box shell on a stepped floor, wl blocks and walls around. */
function basinScene(seed) {
  const rnd = lcg(seed);
  const floor = new Map();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) floor.set(`${x},${z}`, 60 + Math.floor(rnd() * 3) - (x > 3 ? 1 : 0));
  const extra = new Map(), wls = new Map();
  const cells = [];
  const bx = Math.floor(rnd() * 4) - 2, bz = Math.floor(rnd() * 4) - 2, w = 2 + Math.floor(rnd() * 3), d = 2 + Math.floor(rnd() * 3);
  const top = 66;
  for (let x = bx; x < bx + w; x++) for (let z = bz; z < bz + d; z++) for (let y = top - 1; y <= top; y++) cells.push([x, y, z]);
  const own = new Set(cells.map((c) => k3(...c)));
  const shell = [];
  for (const [x, y, z] of cells) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const k = k3(x + dx, y + dy, z + dz);
    if (own.has(k) || extra.has(k)) continue;
    extra.set(k, 'stop');
    shell.push([x + dx, y + dy, z + dz]);
  }
  // the shell stands on a pillar of fill to the floor (raised: its breaches fall onto the floor)
  for (const [x, y, z] of shell) for (let yy = floor.get(`${x},${z}`) + 1; yy < y; yy++) if (!own.has(k3(x, yy, z))) extra.set(k3(x, yy, z), 'stop');
  for (let i = 0; i < 4; i++) { const x = Math.floor(rnd() * 25) - 12, z = Math.floor(rnd() * 25) - 12; const k = k3(x, floor.get(`${x},${z}`) + 1, z); if (!extra.has(k) && !own.has(k)) { extra.set(k, 'stop'); if (rnd() < 0.5) wls.set(k, rnd() < 0.5 ? 0 : FACE.down); } }
  const at = (x, y, z) => extra.get(k3(x, y, z)) ?? (Math.abs(x) > 12 || Math.abs(z) > 12 ? 'stop' : y <= floor.get(`${x},${z}`) ? 'stop' : 'open');
  return { at, cells, shell, wl: (x, y, z) => wls.get(k3(x, y, z)) ?? null };
}

test('SE breach: bank segments are the shell at or under the surface in (x, z, y) order, 32 at a time; a segment\'s reach holds each of its single breaches', () => {
  const sh = [];
  for (let x = 0; x < 40; x++) for (const y of [63, 64, 65]) sh.push([x, y, 0]);
  const segs = bankSegments(sh, 64);
  assert.equal(BANK_SEGMENT, 32);
  assert.deepEqual(segs.map((s) => s.length), [32, 32, 16]);
  assert.deepEqual(segs[0].slice(0, 3), [[0, 63, 0], [0, 64, 0], [1, 63, 0]]);
  assert.ok(segs.flat().every((c) => c[1] <= 64));
  let scenes = 0, bigger = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const S = basinScene(seed);
    const sim = simulate({ at: S.at, wl: S.wl }, [{ id: 'b', fluid: 'water', level: 66, cells: S.cells, shell: S.shell, model: WM_MODEL }], { breach: true });
    const b = sim.bodies[0];
    const got = new Set([...b.reached, ...(b.breach ?? [])].map((c) => k3(...c)));
    // each single breach (H's reach per opened cell, with the wl sources it wakes)
    const own = new Set(S.cells.map((c) => k3(...c)));
    const union = new Set();
    for (const c of S.shell) {
      if (c[1] > 66) continue;
      const oc = k3(...c);
      const atO = (x, y, z) => { const k = k3(x, y, z); return own.has(k) ? 'water' : k === oc ? 'open' : S.at(x, y, z); };
      const r = reach(atO, S.cells, 'water', { cap: BREACH_CAP, wl: (x, y, z) => (atO(x, y, z) === 'stop' ? S.wl(x, y, z) : null) });
      for (const k of r.amt.keys()) union.add(k);
    }
    const missing = [...union].filter((k) => !got.has(k));
    assert.deepEqual(missing, [], `seed ${seed}: the segment reach misses single-breach cells`);
    assert.equal(b.segments, bankSegments(S.shell, 66).length);
    scenes++;
    if (got.size > union.size) bigger++;
  }
  assert.equal(scenes, 60);
  void bigger; // (the segment reach is a superset; often larger: several cells open at once)
});

test('SE breach: the flow from the settled state with a segment opened equals the fresh steady state of the opened world (random wm scenes)', () => {
  let n = 0, wet = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const S = basinScene(seed);
    const wlf = (at) => (x, y, z) => (at(x, y, z) === 'stop' ? S.wl(x, y, z) : null);
    const own = new Set(S.cells.map((c) => k3(...c)));
    const at = (x, y, z) => (own.has(k3(x, y, z)) ? 'water' : S.at(x, y, z));
    const base = steady(at, S.cells, 'water', { ...WM, wl: wlf(at) });
    for (const seg of bankSegments(S.shell, 66)) {
      // one cell, then the whole segment
      for (const open of [seg.slice(0, 1), seg]) {
        const o = new Set(open.map((c) => k3(...c)));
        const atB = (x, y, z) => (o.has(k3(x, y, z)) ? 'open' : at(x, y, z));
        const fresh = steady(atB, S.cells, 'water', { ...WM, wl: wlf(atB) });
        const inc = steady(atB, S.cells, 'water', { ...WM, wl: wlf(atB), init: base.cells, wake: open });
        assert.deepEqual([...inc.cells].sort(), [...fresh.cells].sort(), `seed ${seed}, ${open.length} opened at ${k3(...open[0])}`);
        n++;
        if (fresh.cells.size > base.cells.size) wet++;
      }
    }
  }
  assert.ok(n > 150 && wet > 20, `${n} openings, ${wet} that let water out`);
});

// ------------------------------------------------------------------ the water lint over a stepped current (the 8c lane's shards)

test('SE lint: river_se plans clean (W2 settle covers the fixed point, W3 per bank segment); its watch dropped breaches outside what is recorded', async () => {
  const { planEntry, lintPlanned, WM_ENTRIES } = await import('../lint/water.mjs');
  const e = { ...WM_ENTRIES.find((q) => q.name === 'wm/river_se'), kind: 'wm', lane: '8c' };
  const p = await planEntry(e);
  const l = lintPlanned({ ...p, name: e.name });
  assert.deepEqual(l.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
  assert.deepEqual(l.checker.filter((f) => f.severity === 'error'), []);
  assert.ok(l.breaches.segments > 5 && l.breaches.skipped === 0, JSON.stringify(l.breaches));
  const ops = p.ir.parts.flatMap((q) => (q.ops ?? []).filter((o) => o.op === 'fluid'));
  const head = ops.find((o) => o.id === 'river_r1');
  assert.equal(head.model, 'wm');
  assert.equal(head.predicted.length, 8 * 7 * 3, 'eight runs of 6 cells and the overhang, 3 lanes');
  assert.equal(ops.find((o) => o.id === 'river_r2').model, undefined);
  const q = { ...p, ir: JSON.parse(JSON.stringify(p.ir)) };
  for (const o of q.ir.parts.flatMap((x) => (x.ops ?? []).filter((y) => y.op === 'fluid' && y.model === 'wm'))) o.watch = [];
  const rules = new Set(lintPlanned({ ...q, name: e.name }).findings.map((f) => f.rule));
  assert.ok(rules.has('W3:breach') && rules.has('W3:watch'), [...rules].join(' '));
  // (the lint's shards: the 8c lane runs in its own two)
  for (const i of [0, 1]) assert.match(fs.readFileSync(path.join(HERE, '..', 'lint', `corpus-8c-${i}.lint.mjs`), 'utf8'), new RegExp(`runShard\\(${i}, 2, \\{ lane: '8c' \\}\\)`));
});
