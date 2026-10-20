// Phase 6c slice F3-c (docs/CONTRACT.md "Phase 6c slice F3: forms II" §2, §3.4, §4, §5, §7, §10 items 1, 2, 7, 11): coral, a plan body's
// own cells. The generator's rules (bounded ops, live and waterlogged only, every block on a sturdy face, on the bed and 2 under the
// surface); every coral fixture's answer and check (v73 fits with M19, M25 and M27 clean, the decor in the body op, the census counts it
// as sources and the flow is unchanged by it; r01 NO_FEATURE; c01 1 pickle a cluster under the ice cap and M17 0, its 4-pickle control
// melting the cap; u04 caught by M25:clear, u05 by M19); a quay holds no bed; a moat does; determinism over 3 plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, checkPlanVolumes, flatSurvey, asksSurvey, stewardAnchors } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { coral, PRESETS, bedRoom } from '../lib/forms/coral.mjs';
import { ruleViolations } from '../lib/forms/rules.mjs';
import { decorCellsOf, fromRuns, shellOf } from '../lib/fluids/body.mjs';
import { KINDS_FORMAT2, staleReason, walkKinds } from '../lib/realise.mjs';
import { isLiveCoralBlock, isLiveCoralPlant } from '../lib/region/checkForms.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
const k3 = (x, y, z) => `${x},${y},${z}`;

async function run(fx, plan = fx.plan) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : flatSurvey();
  const r = await checkPlanVolumes(plan, { volume: fx.volume ?? {}, survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, ...(fx.biomes ? { biomes: fx.biomes } : {}) });
  const volumes = r.volumes.map((v) => v.decoded ?? v);
  const blobs = (sha) => r.res.blobs.get(sha) ?? null;
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs, volumes, meta: r.res.meta });
  return { r, rep, s, volumes, blobs, part: (id) => r.check.parts.find((p) => p.part === id) };
}
const cache = new Map();
const of = (rel) => { if (!cache.has(rel)) cache.set(rel, run(read(rel))); return cache.get(rel); };
const ruleOf = (rep, rule) => rep.findings.filter((f) => f.rule === rule || f.rule.startsWith(`${rule}:`));
const fluidOps = (ir) => ir.parts.flatMap((p) => p.ops.filter((o) => o.op === 'fluid').map((o) => ({ ...o, irPart: p.id })));

// a synthetic body: a 9 x 7 rect pond, 3 deep in its middle ring, 2 then 1 at the edge (pond.mjs's stepping), surface 63
function synthBody({ ice = false } = {}) {
  const cells = [];
  for (let x = 0; x < 9; x++) for (let z = 0; z < 7; z++) {
    const ring = Math.min(x + 1, 9 - x, z + 1, 7 - z);
    const d = Math.min(3, ring);
    for (let y = 63 - d + 1; y <= 63; y++) cells.push([x, y, z]);
  }
  const shell = shellOf(cells);
  return { cells, shell, level: 63, ice: ice ? cells.filter((c) => c[1] === 63) : [] };
}

test('item 1: the generator: bounded ops, live waterlogged coral only, on the bed and 2 under the surface, every block on a sturdy face', () => {
  for (const ice of [false, true]) {
    const body = synthBody({ ice });
    const own = new Set(body.cells.map((c) => k3(...c)));
    const shell = new Set(body.shell.map((c) => k3(...c)));
    const iceSet = new Set(body.ice.map((c) => k3(...c)));
    for (const preset of Object.keys(PRESETS)) {
      for (let seed = 1; seed <= 200; seed++) {
        const g = coral({ preset, seed: String(seed), cover: (seed % 10) / 10, count: 1 + (seed % 8), label: 'reef' }, body);
        const v = ruleViolations(g);
        assert.deepEqual(v.over, [], `${preset} ${seed}: an op over 32 primitives`);
        assert.ok(g.ops.length <= 8 && g.ops.length >= 1);
        const at = new Map(g.decor.map(([x, y, z, s]) => [k3(x, y, z), s]));
        for (const [x, y, z, s] of g.decor) {
          assert.ok(!/dead_/.test(s), `${s}: never a dead variant`);
          assert.ok(!iceSet.has(k3(x, y, z)), 'never an ice cap cell');
          if (isLiveCoralBlock(s)) {
            assert.ok(shell.has(k3(x, y, z)) && own.has(k3(x, y + 1, z)) && !iceSet.has(k3(x, y + 1, z)), `${s} at ${x},${y},${z}: a bed cell under the body's water`);
            continue;
          }
          assert.ok(own.has(k3(x, y, z)), `${s}: a body cell`);
          assert.ok(y <= body.level - 1, `${s}: 2 under the surface`);
          assert.match(s, /waterlogged=true/, `${s}: waterlogged`);
          assert.ok(isLiveCoralPlant(s) || /^minecraft:sea_pickle\[pickles=[1-4],waterlogged=true\]$/.test(s), s);
          if (/_wall_fan/.test(s)) {
            const f = /facing=(\w+)/.exec(s)[1];
            const [dx, dz] = { west: [1, 0], east: [-1, 0], north: [0, 1], south: [0, -1] }[f];
            assert.ok(shell.has(k3(x + dx, y, z + dz)), `${s} at ${x},${y},${z}: hangs on a side wall behind it`);
          } else {
            const below = k3(x, y - 1, z);
            assert.ok(shell.has(below) || isLiveCoralBlock(at.get(below) ?? ''), `${s} at ${x},${y},${z}: stands on the bed`);
          }
          if (ice && s.startsWith('minecraft:sea_pickle')) assert.match(s, /pickles=1,/, 'under an ice cap: 1 pickle a cluster');
        }
        // seeded: the same params give the same cells
        if (seed % 50 === 0) assert.deepEqual(coral({ preset, seed: String(seed), cover: (seed % 10) / 10, count: 1 + (seed % 8), label: 'reef' }, body).decor, g.decor);
      }
    }
  }
  // the room: a 1-deep body has bed cells but no water cell 2 under the surface
  const shallow = { cells: [[0, 63, 0], [1, 63, 0]], level: 63, ice: [] };
  shallow.shell = shellOf(shallow.cells);
  assert.equal(bedRoom(shallow).length, 2);
  assert.ok(bedRoom(shallow).every((c) => !c.plant));
  const g1 = coral({ seed: '7', label: 'x' }, shallow);
  assert.ok(g1.decor.length > 0 && g1.decor.every((c) => isLiveCoralBlock(c[3])), 'coral blocks in the bed only');
  // capped all over at 1 deep: no room at all
  assert.equal(coral({ seed: '7', label: 'x' }, { ...shallow, ice: shallow.cells }).decor.length, 0);
});

test('item 2, §3.4: v73 fits: each coral compiles into its body (decor), M19, M25, M27 and M17 clean', async () => {
  const { r, rep } = await of('valid/v73_f3_coral_pond.json');
  assert.equal(r.check.overall, 'READY');
  for (const a of r.check.parts) assert.equal(a.class, 'fits', `${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? [])}`);
  for (const rule of ['M19', 'M25', 'M27', 'M17', 'M20', 'M1', 'M13']) assert.deepEqual(ruleOf(rep, rule).map((f) => [f.rule, f.part, f.count]), [], rule);
  assert.deepEqual(rep.metrics.M25.clear, { hard: 0, watch: 0, exempt: 0 });
  assert.ok(rep.metrics.M19.corals > 0 && rep.metrics.M19.dead === 0);
  const ir = r.res.ir;
  assert.ok(ir.requires.includes('coralDecor') && walkKinds(ir).includes('coralDecor'));
  assert.equal(staleReason(ir), null, 'this kit reads it');
  // no part of the plan is the coral's: its cells are the bodies' own
  assert.ok(!ir.parts.some((p) => /reef|fount_coral/.test(p.id)), 'no IR part of the coral');
  const ops = fluidOps(ir);
  const pond = ops.find((o) => o.id === 'w_pond'), basin = ops.find((o) => o.id === 'w_fount'), spout = ops.find((o) => o.id === 'w_fount_spout');
  assert.ok(pond.decor.length && basin.decor.length && spout.decor === undefined);
  for (const o of [pond, basin]) {
    const own = new Set(fromRuns(o.cells).map((c) => k3(...c))), shell = new Set(fromRuns(o.shell).map((c) => k3(...c)));
    for (const [x, y, z, s] of decorCellsOf(o.decor)) {
      if (isLiveCoralBlock(s)) assert.ok(shell.has(k3(x, y, z)), `${o.id}: a coral block in a bed (shell) cell`);
      else assert.ok(own.has(k3(x, y, z)) && /waterlogged=true/.test(s), `${o.id}: ${s} in a body cell, waterlogged`);
    }
  }
  // the fountain's basin is 1 deep: coral blocks in its bed only (answered with a note)
  assert.ok(decorCellsOf(basin.decor).every((c) => isLiveCoralBlock(c[3])));
  assert.ok(r.check.parts.find((p) => p.part === 'fount_coral').notes.some((n) => /bed only/.test(n)));
  // the answers' geometry: the coral's rect and patch sites
  const a = r.check.parts.find((p) => p.part === 'reef');
  assert.ok(Array.isArray(a.geometry?.rect) && a.geometry.sites.length === 4, JSON.stringify(a.geometry));
});

test('§3.4: the census counts waterlogged decor as sources; the flow and its prediction are the body\'s as without coral', async () => {
  const fx = read('valid/v73_f3_coral_pond.json');
  const { r, s, volumes, blobs } = await of('valid/v73_f3_coral_pond.json');
  const ir = r.res.ir;
  const { vw } = buildVirtual({ ir, survey: s.bytes, blobs, volumes });
  const P = vw.pal;
  let decorSources = 0;
  for (const o of fluidOps(ir)) {
    const decor = new Map(decorCellsOf(o.decor).map(([x, y, z, st]) => [k3(x, y, z), st]));
    for (const [x, y, z] of fromRuns(o.cells)) {
      const st = P.states[vw.get(x, y, z)];
      // what the mod's census reads as the body's source there: water, or a waterlogged block (its fluid state a water source)
      assert.ok(st === 'minecraft:water' || /waterlogged=true/.test(st), `${o.id} ${x},${y},${z}: ${st}`);
      if (decor.has(k3(x, y, z))) { assert.equal(st, decor.get(k3(x, y, z)), 'the realised decor is the op\'s'); decorSources++; }
    }
    for (const [k, st] of decor) if (isLiveCoralBlock(st)) { const [x, y, z] = k.split(',').map(Number); assert.equal(P.states[vw.get(x, y, z)], st, 'a bed coral block written'); }
  }
  assert.ok(decorSources > 0);
  // the same plan without its coral: every body's cells, shell, spill and predicted flow identical (decor never moves the water)
  const bare = { ...fx.plan, forms: fx.plan.forms.filter((f) => f.kind !== 'coral') };
  const b = await run(fx, bare);
  const strip = (o) => ({ cells: o.cells, shell: o.shell, spill: o.spill, watch: o.watch, predicted: o.predicted, settleTicks: o.settleTicks, ice: o.ice });
  assert.deepEqual(fluidOps(ir).map(strip), fluidOps(b.r.res.ir).map(strip));
  assert.ok(!b.r.res.ir.requires.includes('coralDecor') && fluidOps(b.r.res.ir).every((o) => o.decor === undefined), 'no coral, no decor and no kind');
});

test('r01: coral inside no plan body, or a lava pit: refused NO_FEATURE {why: no plan water}; a quay holds no bed (NO_ROOM); a moat grows it', async () => {
  const { r } = await of('f3/r01_coral_dry.json');
  for (const id of ['reef', 'pit_coral']) {
    const a = r.check.parts.find((p) => p.part === id);
    assert.equal(a.class, 'refused', id);
    assert.equal(a.reasons[0].code, 'NO_FEATURE');
    assert.equal(a.reasons[0].evidence.why, 'no plan water');
  }
  assert.equal(r.check.parts.find((p) => p.part === 'pit').class, 'fits');
  // a quay (natural water: no body of its own)
  const q = read('valid/v46_quay.json');
  q.plan.forms = [...(q.plan.forms ?? []), { id: 'reef', kind: 'coral', where: { inside: { part: 'landing' } } }];
  const rq = await run(q);
  assert.equal(rq.part('reef').class, 'refused');
  assert.equal(rq.part('reef').reasons[0].code, 'NO_ROOM');
  assert.equal(rq.part('landing').class, 'fits');
  // a moat (channel.moat): fits, its body's decor
  const m = read('valid/v45_moat.json');
  m.plan.forms = [...(m.plan.forms ?? []), { id: 'reef', kind: 'coral', where: { inside: { part: 'moat' } }, count: 2 }];
  const rm = await run(m);
  assert.equal(rm.part('reef').class, 'fits', JSON.stringify(rm.part('reef').reasons));
  assert.ok(fluidOps(rm.r.res.ir).find((o) => o.id === 'w_moat').decor.length > 0);
  assert.deepEqual(ruleOf(rm.rep, 'M19'), []);
  assert.deepEqual(ruleOf(rm.rep, 'M25:clear'), []);
});

test('c01: the frozen site\'s coral pond under its ice cap: 1 pickle a cluster, M17 0; four to a cluster melt the cap (the control)', async () => {
  const { r, rep } = await of('f3/c01_cold_coral.json');
  assert.equal(r.check.overall, 'READY');
  assert.equal(r.check.parts.find((p) => p.part === 'reef').class, 'fits');
  const pond = fluidOps(r.res.ir).find((o) => o.id === 'w_pond');
  assert.ok(pond.ice.length > 0, 'capped');
  const pickles = decorCellsOf(pond.decor).filter((c) => c[3].startsWith('minecraft:sea_pickle'));
  assert.ok(pickles.length > 0, 'pickles under the cap');
  assert.ok(pickles.every((c) => /pickles=1,/.test(c[3])), 'every pickle 1 to a cluster');
  assert.deepEqual(ruleOf(rep, 'M17'), []);
  assert.deepEqual(ruleOf(rep, 'M19'), []);
  assert.deepEqual(ruleOf(rep, 'M25'), []);
  // the control: pickles 4 to a cluster (light 15) under the same cap melt it (M17 names the ice)
  const fx = read('f3/c01_cold_coral.json');
  const plan = structuredClone(fx.plan);
  plan.forms.find((f) => f.id === 'reef').ext = { 'architect_mc:unsafe': { fullPickles: true } };
  const c = await run(fx, plan);
  const cp = decorCellsOf(fluidOps(c.r.res.ir).find((o) => o.id === 'w_pond').decor).filter((q) => q[3].startsWith('minecraft:sea_pickle'));
  assert.ok(cp.length && cp.every((q) => /pickles=4,/.test(q[3])));
  assert.ok(ruleOf(c.rep, 'M17').length > 0, 'M17 guards the cap');
});

test('item 7 (KC) and §4: u04 (coral as another part\'s op) is named by M25:clear; u05 (a live coral dry) by M19', async () => {
  const u4 = await of('f3/u04_coral_other_part.json');
  assert.equal(u4.part('pond').class, 'fits');
  const clear = ruleOf(u4.rep, 'M25:clear');
  assert.ok(clear.length > 0 && clear.every((f) => f.part === 'f_reef'), JSON.stringify(clear.map((f) => [f.part, f.count])));
  assert.ok(clear.some((f) => /plan part reef/.test(f.message)));
  assert.equal(fluidOps(u4.r.res.ir).find((o) => o.id === 'w_pond').decor, undefined, 'the body op holds no decor');
  const u5 = await of('f3/u05_live_coral_dry.json');
  assert.equal(u5.part('pond').class, 'fits');
  const m19 = ruleOf(u5.rep, 'M19');
  assert.equal(m19.length, 1);
  assert.equal(m19[0].part, 'w_pond');
  assert.deepEqual(ruleOf(u5.rep, 'M25:clear'), [], 'only M19 names it: the cell is the pond\'s own shell');
});

test('item 11: determinism: v73 and c01 plan to the same IR three times', async () => {
  for (const rel of ['valid/v73_f3_coral_pond.json', 'f3/c01_cold_coral.json']) {
    const shas = [];
    for (let i = 0; i < 3; i++) { const x = await run(read(rel)); shas.push(crypto.createHash('sha256').update(JSON.stringify(x.r.res.ir)).digest('hex')); }
    assert.equal(new Set(shas).size, 1, rel);
  }
  assert.ok(KINDS_FORMAT2.includes('coralDecor'));
  assert.match(staleReason({ format: 2, requires: ['fluid', 'coralDecor-v2'] }) ?? '', /coralDecor-v2/);
});
