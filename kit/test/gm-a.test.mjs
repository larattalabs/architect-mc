// (7a GM-a) gm-unit (docs/CONTRACT.md "Slice GM" §10 item 1, under §12-§15): the mechanism in a gatehouse lot, the rungs, the
// envelope, the roles, the plan member, the artifact, the graph, the siteplan, S-THEME, the brief lines and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, part, svOf } from './plan-p0-shared.mjs';
import { gateLayout, settleLayout, lintLayout } from '../lib/connectors/gmCircuit.mjs';
import { mechanismPlan, gmMatsOf, gmBrief, gmFullOk, gmMovable, gmRoofMax, GM_ROOF_MIN } from '../lib/connectors/gmGate.mjs';
import { resolveRoles } from '../lib/region/plan.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { frameOf, gatehouseDesign } from '../lib/wallLotDesigns.mjs';
import { Blueprint, palette, variant } from '../lib/kit.mjs';
import { shapeOf, doorOf, UNTHEMED_OK } from '../lib/connectors/style.mjs';

const ROOT = path.join(FIX, '..', '..', '..', '..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, 'gm', `${n}.json`), 'utf8'));
const key = (c) => c.slice(0, 3).join(',');
const bibles = () => fs.readdirSync(path.join(ROOT, 'scenarios', 'bibles')).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', f), 'utf8')).roles ?? {}]);

test('mechanismPlan: base + rung R is the settled layout of roof R; the unused rungs below R are the structure block, none at or above R', () => {
  for (const kind of ['portcullis', 'slide']) for (const depth of [7, 11, 15]) {
    const p = mechanismPlan(kind, { depth });
    assert.equal(p.rungs.length, gmRoofMax(depth) - GM_ROOF_MIN + 1, `${kind} ${depth}: a rung per roof row 10..depth+7`);
    for (const g of p.rungs) {
      const lay = gateLayout(kind, { depth, roof: g.roof });
      const s = settleLayout(lay);
      const want = new Map([...lay.cells.values()].map((c) => [`${c.u},${c.d},${c.r}`, s.get(`${c.u},${c.d},${c.r}`) ?? c.state]));
      const got = new Map([...p.base, ...g.cells].map((c) => [key(c), c[3]]));
      for (const [k2, st] of want) {
        const g2 = got.get(k2);
        assert.ok(g2 !== undefined, `${kind} ${depth} R${g.roof}: ${k2} written`);
        // (the leaves' connections are settled by mechanismPlan; the rest is settleLayout's state)
        if (!/bars|fence|_wall/.test(st)) assert.equal(g2, st, `${kind} ${depth} R${g.roof}: ${k2}`);
      }
      for (const [k2, st] of got) if (!want.has(k2)) {
        assert.equal(st, gmMatsOf({}).structure, `${kind} ${depth} R${g.roof}: ${k2} an unused rung, the structure block`);
        assert.ok(Number(k2.split(',')[2]) < g.roof, `${kind} ${depth} R${g.roof}: ${k2} below the roof`);
      }
      assert.ok(g.cells.some((c) => /daylight_detector\[inverted=true/.test(c[3]) && key(c) === g.sensor.join(',')), `${kind} ${depth} R${g.roof}: the inverted sensor at its rung`);
    }
    assert.ok(!p.base.some((c) => /daylight/.test(c[3])), `${kind} ${depth}: levers-only (the base alone) has no sensor block`);
  }
});

test('mechanismPlan: the layouts behind every rung lint clean (design walls solid or the hall open); the envelope stays in the box', async () => {
  for (const kind of ['portcullis', 'slide']) for (const depth of [7, 11]) {
    for (let R = GM_ROOF_MIN; R <= gmRoofMax(depth); R++) for (const outside of ['solid', 'air']) assert.deepEqual(await lintLayout(gateLayout(kind, { depth, roof: R }), { half: 6, outside }), [], `${kind} ${depth} R${R} ${outside}`);
    const p = mechanismPlan(kind, { depth });
    for (const [u, d, r] of p.envelope) assert.ok(Math.abs(u) <= 5 && d >= 0 && d <= depth - 1 && r >= 0 && r <= gmRoofMax(depth), `${kind} ${depth}: ${u},${d},${r} in a 13 x ${depth} box`);
    // the inside detector's trapdoor (§15 item 4) and the lintel trigger cells are in the envelope
    const env = new Set(p.envelope.map((c) => c.join(',')));
    for (const c of [[1, depth - 2, 3], [-1, 0, 3], [1, depth - 1, 3], [-1, 0, 2], [1, depth - 1, 2]]) assert.ok(env.has(c.join(',')), `${kind} ${depth}: ${c} in the envelope`);
  }
});

test('levers-only (§15 item 3): the base settles with the S input unpowered by day (a fixed point), the latch open', () => {
  const lay = gateLayout('portcullis', { depth: 7, roof: 10 });
  lay.cells.delete('-4,1,10'); // no sensor
  const a = settleLayout(lay), b = settleLayout(lay);
  assert.deepEqual([...a], [...b]);
  assert.match(a.get('-4,1,9'), /power=0/);
  assert.match(a.get('-1,4,7'), /powered=false/); // RG: G off, the gate open
});

test('gmMatsOf: every bible gives a full, conductive structure block and a movable leaf; bars from the rail role (fence, wall) or iron bars; S-THEME traces them', () => {
  for (const [f, roles0] of [['(none)', {}], ...bibles()]) {
    const roles = resolveRoles(roles0);
    const M = gmMatsOf(roles);
    assert.ok(gmFullOk(M.structure), `${f}: structure ${M.structure}`);
    assert.ok(gmMovable(M.leaf), `${f}: an immovable leaf never (${M.leaf})`);
    assert.ok(/_fence$|_wall$|iron_bars$/.test(M.bar), `${f}: bar ${M.bar}`);
    for (const b of Object.values(M)) assert.ok(UNTHEMED_OK.has(b) || Object.values(roles).some((r) => { const n = String(r).replace(/\[.*$/, ''); return n === b || ['fence', 'wall', 'button', 'pressure_plate'].some((sh) => shapeOf(n, sh) === b); }), `${f}: ${b} traces to a role`);
  }
  assert.equal(gmMatsOf({ structure: 'minecraft:obsidian', trim: 'minecraft:stone_bricks' }).leaf, 'minecraft:stone_bricks', 'obsidian never becomes a leaf');
  assert.equal(gmMatsOf({ structure: 'minecraft:glass', trim: 'minecraft:stone_bricks' }).structure, 'minecraft:stone_bricks', 'glass carries no power');
});

test('gmBrief: the §4 and §5 lines word for word, §15 item 1 and item 6 (depth + 7); a swing has the first only', () => {
  const b = gmBrief('portcullis', 11);
  assert.equal(b.length, 5);
  assert.equal(b[0], 'keep 4 clear cells above the passage lintel for the winch room');
  assert.equal(b[1], 'give a sky-exposed roof or crenel cell for the daylight sensor');
  assert.equal(b[2], 'keep 5 cells of jamb a side of the passage clear of ladders and stairs');
  assert.match(b[3], /staircase .* empty or solid, with no redstone, light source or opening/);
  assert.match(b[4], /at or below row 18 above the passage floor so the gate can sense the sky; towers elsewhere on the lot may rise higher/);
  assert.equal(gmBrief('swing', 11).length, 1);
});

test('plan/0: mech and rest on a wall lot validate; an unknown kind does not', () => {
  const p = fx('gm_castle_13x7').plan;
  const wallOf = (v) => v.parts.find((q) => q.id === 'curtain_wall');
  assert.equal(validatePlan(p).malformed, null);
  assert.equal(wallOf(validatePlan(p)).verdict, 'compile');
  const bad = JSON.parse(JSON.stringify(p));
  bad.connectors[0].lots.find((q) => q.lot === 'gatehouse_1').mech = 'drawbridge';
  const v = validatePlan(bad);
  assert.ok(v.malformed || wallOf(v).verdict !== 'compile', JSON.stringify(wallOf(v)).slice(0, 200));
});

const cache = new Map();
const runOf = async (n) => { if (!cache.has(n)) cache.set(n, await run(fx(n))); return cache.get(n); };
const irOf = (r) => r.res.ir;

test('the mechanism in the plan: 13 x 7 and 17 x 15 fit; the artifact record, the envelope in the reserved cells, the IR write data, the graph, the siteplan', async () => {
  for (const [n, depth, along] of [['gm_castle_13x7', 7, 13], ['gm_castle_17x15', 15, 17]]) {
    const r = await runOf(n);
    assert.equal(r.check.overall, 'READY', n);
    const w = part(r, 'curtain_wall');
    assert.ok(['fits', 'adjusted'].includes(w.class) && !(w.deviations ?? []).some((d) => d.what === 'mechanism'), `${n}: ${w.class}`);
    assert.deepEqual(w.geometry.wallLots.find((q) => q.lot === 'gatehouse_1').passage.mechanism, { kind: 'portcullis', rest: 'open', who: 'player' });
    const l = r.artifact.lots.find((q) => q.id === 'gatehouse_1');
    const ps = l.onWall.passage, m = ps.mechanism;
    assert.equal(ps.width, 3, `${n}: pw 3`);
    assert.equal(m.kind, 'portcullis'); assert.equal(m.rest, 'open'); assert.equal(m.dayDriven, true); assert.equal(m.width, 3);
    assert.deepEqual(m.triggers.map((t) => [t.kind, t.side, t.who]), [['lever', 'front', 'player'], ['lever', 'back', 'player'], ['daylight', 'roof', 'sky']]);
    assert.equal(m.triggers[2].rungs.length, depth - 2);
    assert.equal(m.brief.length, 5);
    // the envelope (lot frame) is in the passage's lotCells (the reserved entry Steward forwards); the passage's own cells unchanged
    const cells = (runs) => { const o = new Set(); for (let i = 0; i + 3 < runs.length; i += 4) for (let y = runs[i + 2]; y <= runs[i + 3]; y++) o.add(`${runs[i]},${y},${runs[i + 1]}`); return o; };
    const lc = cells(ps.lotCells), mc = cells(m.lotCells);
    for (const c of mc) assert.ok(lc.has(c), `${n}: ${c} reserved`);
    assert.equal(cells(ps.cells).size, 3 * 3 * depth, `${n}: the passage itself is 3 lanes x 3 rows x the depth`);
    // the envelope inside the box
    const b = l.box;
    for (const c of cells(m.cells)) { const [x, y, z] = c.split(',').map(Number); assert.ok(x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5] && y >= b[1] && y <= b[4], `${n}: ${c} in the box`); }
    // the IR: the lot's write data (base, a rung per roof row), the graph edge
    const ir = irOf(r);
    const il = ir.lots.find((q) => q.id === 'gatehouse_1');
    assert.ok(il.mechanismWrite.base.length > 0 && il.mechanismWrite.rungs.length === depth - 2);
    assert.ok(il.mechanismWrite.rungs.every((g) => g.beside.length === 6 && g.sensor.length === 3));
    const e = ir.graph.edges.find((q) => q.id === 'pg_gatehouse_1');
    assert.deepEqual([e.state, e.closesAtNight, e.mechanism, e.movers], ['open', true, { kind: 'portcullis', toggle: 'player' }, ['player', 'villager']]);
    // siteplan: the edge's members and the wall lot's passage.mechanism; the schema holds
    const meta = r.res.meta ?? {};
    const sp = sitePlan({ ir, meta });
    assert.deepEqual(validateSchema(sp), [], `${n}: siteplan schema`);
    const se = sp.graph.edges.find((q) => q.id === 'pg_gatehouse_1');
    assert.equal(se.state, 'open'); assert.equal(se.closesAtNight, true);
    // S-THEME: the mechanism's write data traces to the roles or the functional set
    const { vw } = buildVirtual({ ir, survey: svOf(fx(n)).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    const th = themeOffenders(ir, vw).offenders.filter((o) => /^gm_/.test(o.part));
    assert.deepEqual(th, [], `${n}: S-THEME on the mechanism`);
    void along;
  }
});

test('the mechanism refused or adjusted: [11, 13] (11 along the wall) keeps the plain passage, deviation mechanism; on a required wall NO_ROOM', async () => {
  const r = await runOf('gm_castle_11x13');
  const w = part(r, 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  assert.deepEqual(w.deviations.filter((d) => d.what === 'mechanism'), [{ what: 'mechanism', kind: 'portcullis', lot: 'gatehouse_1', need: 13, side: 'along' }]);
  const l = r.artifact.lots.find((q) => q.id === 'gatehouse_1');
  assert.ok(l.onWall.passage && !l.onWall.passage.mechanism);
  assert.ok(!irOf(r).lots.find((q) => q.id === 'gatehouse_1').mechanismWrite);
  const q = await runOf('gm_castle_11x13_required');
  const wq = part(q, 'curtain_wall');
  assert.equal(wq.class, 'refused');
  assert.deepEqual(wq.reasons.map((x) => [x.code, x.evidence]), [['NO_ROOM', { kind: 'mechanism', lot: 'gatehouse_1', need: 13, side: 'along' }]]);
});

test('slide and swing: the slide\'s leaves the movable structure block; the swing rests closed, its edge player-only, no rung', async () => {
  const s = await runOf('gm_castle_slide');
  const ms = s.artifact.lots.find((q) => q.id === 'gatehouse_1').onWall.passage.mechanism;
  assert.equal(ms.kind, 'slide');
  const w = await runOf('gm_castle_swing');
  const m = w.artifact.lots.find((q) => q.id === 'gatehouse_1').onWall.passage.mechanism;
  assert.deepEqual([m.kind, m.rest, m.dayDriven], ['swing', 'closed', false]);
  assert.deepEqual(m.triggers.map((t) => t.kind), ['button', 'lever', 'plate']);
  const e = irOf(w).graph.edges.find((q) => q.id === 'pg_gatehouse_1');
  assert.deepEqual([e.state, e.movers, e.closesAtNight], ['closed', ['player'], undefined]);
  assert.equal(irOf(w).lots.find((q) => q.id === 'gatehouse_1').mechanismWrite.rungs.length, 0);
});

test('the GM stub gatehouse (roof option) binds: its frame\'s passage is the lanes only, its outer faces closed, its deck at the asked row', async () => {
  const r = await runOf('gm_castle_13x7');
  const l = r.artifact.lots.find((q) => q.id === 'gatehouse_1');
  const F = frameOf(l);
  assert.deepEqual([...new Set(F.passage.map(([u]) => u))].length, 3, 'three lane columns');
  assert.ok(F.reserved.length > F.passage.length);
  const K = { Blueprint, palette, variant, shapeOf, doorOf };
  const bp = gatehouseDesign(K, 'gm_probe', l, resolveRoles({}), { roof: 10 });
  for (const [u, y, v] of F.outer) assert.ok(!/air$|door$/.test(bp.nameAt(u, y + 1, v) ?? 'minecraft:air'), `outer ${u},${y},${v}`);
  for (const [u, y, v] of F.passage) assert.equal(bp.nameAt(u, y + 1, v) ?? 'minecraft:air', 'minecraft:air');
  assert.notEqual(bp.nameAt(2, 11, 3) ?? 'minecraft:air', 'minecraft:air', 'the deck at row 10 (design y 11)');
});

test('determinism: 3 checks of each GM fixture give one artifact sha', async () => {
  for (const n of ['gm_castle_13x7', 'gm_castle_swing']) {
    const a = await runOf(n), b = await run(fx(n)), c = await run(fx(n));
    assert.ok(a.artifactSha && a.artifactSha === b.artifactSha && b.artifactSha === c.artifactSha, n);
  }
});

test('item 7: KC (a fountain off the ring\'s corner, K3\'s fixture with a mechanism gatehouse) M25:clear 0; M2:wall closure with the mechanism passage a gate: 0 leaks, every node across', async () => {
  const { checkRegion } = await import('../lib/region/check.mjs');
  const f = JSON.parse(fs.readFileSync(path.join(FIX, 'k3', 'k01_castle_fountain.json'), 'utf8'));
  f.plan.connectors.find((c) => c.kind === 'wall').lots.find((q) => q.lot === 'gatehouse_1').mech = 'portcullis';
  for (const fxx of [f, fx('gm_castle_13x7'), fx('gm_castle_17x15')]) {
    const r = await run(fxx);
    const rep = checkRegion({ ir: r.res.ir, survey: svOf(fxx).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta });
    assert.deepEqual(rep.findings.filter((x) => x.rule === 'M25:clear').map((x) => x.message), [], fxx.plan.planId);
    const m = rep.metrics.walls.curtain_wall;
    for (const mv of ['player', 'villager']) assert.deepEqual([m.closure[mv].leaks, m.closure[mv].across], [0, m.closure[mv].nodes], `${fxx.plan.planId}: closure ${mv}`);
  }
  const r = await run(f);
  assert.ok(r.artifact.lots.find((l) => l.id === 'gatehouse_1')?.onWall?.passage?.mechanism, 'KC: the gatehouse keeps its mechanism');
});

// ------------------------------------------------------------------ (7a GM-a2, §16 items 1 and 3)

test('GM-a2: the mechanism\'s provisional bill (cost) bounds every case at bind: levers-only, each rung, each rung with any roof fill; the swing exact', async () => {
  const { gmCost } = await import('../lib/connectors/gmGate.mjs');
  const { bomOf } = await import('../lib/connectors/bom.mjs');
  for (const kind of ['portcullis', 'slide', 'swing']) for (const depth of [7, 11]) {
    const p = mechanismPlan(kind, { depth });
    const c = gmCost(p);
    const within = (cells, what) => {
      const b = bomOf(cells.map((x) => x[3]));
      for (const [i, n] of Object.entries(b)) assert.ok(n >= (c.bom.min[i] ?? 0) && n <= (c.bom.max[i] ?? -1), `${kind} ${depth} ${what}: ${i} ${n} in [${c.bom.min[i] ?? 0}, ${c.bom.max[i]}]`);
      for (const i of Object.keys(c.bom.min)) assert.ok((b[i] ?? 0) >= c.bom.min[i], `${kind} ${depth} ${what}: ${i} at least ${c.bom.min[i]}`);
      const n = cells.filter((x) => !/air$/.test(x[3])).length;
      assert.ok(n >= c.cells[0] && n <= c.cells[1], `${kind} ${depth} ${what}: ${n} cells in ${c.cells}`);
    };
    within(p.base, 'levers-only');
    for (const g of p.rungs) {
      const left = p.rungKeys.length - g.cells.length;
      for (const k of [0, 1, left]) within([...p.base, ...g.cells, ...Array.from({ length: k }, () => [0, 0, 0, p.structure])], `rung ${g.roof} + ${k} filled`);
    }
    if (kind === 'swing') assert.deepEqual(c.bom.min, c.bom.max, 'swing: one case, exact');
    else {
      assert.equal(c.rare['minecraft:slime_ball'], 6, `${kind}: 6 sticky pistons, 6 slime balls (§8)`);
      assert.ok(c.rare['minecraft:quartz'] >= 3, `${kind}: quartz for the sensor named`);
      assert.ok(!c.bom.min['minecraft:daylight_detector'] && c.bom.max['minecraft:daylight_detector'] === 1, `${kind}: the sensor only when a rung is bound`);
    }
  }
});

test('GM-a2: the artifact and IR carry the cost and the fill; the gatehouse lot\'s provisional range holds the mechanism; S-THEME judges the fill', async () => {
  for (const [n, depth] of [['gm_castle_13x7', 7], ['gm_castle_slide', 7]]) {
    const r = await runOf(n);
    const l = r.artifact.lots.find((q) => q.id === 'gatehouse_1');
    const m = l.onWall.passage.mechanism;
    assert.ok(m.cost && m.cost.cells[0] > 0 && m.cost.cells[1] >= m.cost.cells[0], `${n}: mechanism.cost.cells`);
    if (l.provisional) {
      const [x0, , z0, x1, , z1] = l.box;
      const cols = (x1 - x0 + 1) * (z1 - z0 + 1);
      const { PROVISIONAL_BAND } = await import('../lib/plan/compile.mjs');
      assert.deepEqual(l.costRange, [cols * PROVISIONAL_BAND[0] + m.cost.cells[0], cols * PROVISIONAL_BAND[1] + m.cost.cells[1]], `${n}: the lot's range holds the mechanism`);
    }
    const il = irOf(r).lots.find((q) => q.id === 'gatehouse_1');
    const w = il.mechanismWrite;
    assert.ok(Number.isInteger(w.fill) && /stone_bricks|bricks|planks|stone/.test(w.palette[w.fill]), `${n}: the fill is the structure block (${w.palette[w.fill]})`);
    const ir = JSON.parse(JSON.stringify(irOf(r)));
    const w2 = ir.lots.find((q) => q.id === 'gatehouse_1').mechanismWrite;
    w2.fill = w2.palette.push('minecraft:crimson_hyphae') - 1; // only the fill names it
    const { vw } = buildVirtual({ ir: irOf(r), survey: svOf(fx(n)).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    const bad = themeOffenders(ir, vw).offenders.filter((o) => /^gm_/.test(o.part) && o.block === 'minecraft:crimson_hyphae');
    assert.ok(bad.length >= 1, `${n}: an untraced fill block is an S-THEME offender`);
    void depth;
  }
});
