// (slice PL2) A one-ended port link: the region ladder (CL's connector.ladder) with one end at a site lot's walk port and the other the
// ground under it, or a region-made form (catalogue `ladder.port`). Routed at plan time to the site's port (recorded in the IR's portLinks,
// no op), written at realise against the bound entry's port in site_links (IR v2), its rungs re-checked by the region checker's M10:climb
// (each rung a ladder against a sturdy face). Plans without one are unchanged (lp.test, cn.test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld, tree, planWorld } from './lp-world.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { LinkError, PORT_LADDER, replayDiff } from '../lib/region/links.mjs';
import { canonicalJson } from '../lib/region/pack.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { run, svOf } from './plan-p0-shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = 64;
const walk = (name, at, facing) => ({ name, kind: 'architect:walk', at, facing, width: 2, height: 2 });
const PORTS = [walk('walk_w', [0, 2, 4], 'west')];
/** A canopy lot on one tree (its floor `y0` over the ground), its walk port on the west edge at row 2, and a ladder from the ground. */
const body = ({ y0 = 13, to, ports = PORTS, mound = false } = {}) => (r) => {
  if (mound) {
    // (a region-made form under the port: a 3x3 block of stone 4 high, written by the plan in stage ground)
    const m = r.part('mound', { stage: 'ground' });
    const cols = [];
    for (let x = 1023; x <= 1027; x++) for (let z = 2038; z <= 2042; z++) if (x < 1026) cols.push(x, z, G + 1, G + 4, 0);
    m.columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:stone']);
  }
  r.siteLot('a', { fit: 'wrap_trunk', box: [1026, G + y0, 2036, 1034, G + y0 + 7, 2044], stage: 'lots', ports });
  return r.portLink('up', { kind: 'ladder', from: { lot: 'a' }, ...(to ? { to } : {}) });
};
const world = (edits = []) => makeWorld({ ground: G, edits: [...tree(1030, 2040, G), ...edits] });
const links = (ports = PORTS) => ({ links: { lots: { a: { entry: 'ea', ports } } } });
const report = (w, L) => checkRegion({ ir: L.res.ir, survey: w.survey, blobs: (s) => L.res.blobs.get(s), volumes: [w.vol], meta: L.res.meta });
const bad = (rep) => rep.findings.filter((f) => f.severity === 'error' || /^(M10|M6|M1:site|M8:climb|M5:climb)/.test(f.rule)).map((f) => `${f.rule}: ${f.message}`);

test('a ladder from the ground to a walk port: plan time records it (to: ground, no op); the realise writes post and rungs in site_links; IR v2 = IR v1 plus the link; M10:climb clean', async () => {
  const w = world();
  const P = await planWorld(w, body());
  assert.deepEqual(P.res.ir.portLinks, [{ id: 'up', kind: 'ladder', from: { lot: 'a', port: 'walk_w', facing: 'west' }, to: { ground: true } }]);
  assert.ok(P.res.ir.stages.includes('site_links'));
  assert.equal(P.res.ir.parts.filter((p) => p.stage === 'site_links').length, 0, 'plan time writes nothing');
  assert.equal(P.out.rise, 14);
  const L = await planWorld(w, body(), links());
  const row = L.out.row;
  assert.deepEqual(row.from, { lot: 'a', port: 'walk_w', at: [1026, G + 15, 2040], out: [1025, G + 15, 2040], facing: 'west' });
  assert.deepEqual(row.to, { ground: true, foot: [1025, G + 1, 2040] });
  assert.equal(row.kind, 'ladder');
  const c = L.res.meta.climbs.find((q) => q.link === 'up');
  assert.deepEqual(c.detail[0].flights, [{ x: 1025, z: 2040, y0: G + 1, y1: G + 15 }], 'the rungs from over the ground to the port\'s feet y');
  assert.equal(c.detail[0].facing, 'east', 'facing the lot: its face the post west of it');
  assert.deepEqual([c.post.at, c.post.y0, c.post.y1], [[1024, 2040], G + 1, G + 15]);
  assert.ok(c.lamp, 'a lamp on the post\'s top');
  assert.equal(c.bom['minecraft:ladder'], 15);
  assert.equal(replayDiff(P.res.ir, L.res.ir, canonicalJson), null, 'IR v2 = IR v1 plus the links');
  assert.deepEqual(Object.keys(L.res.ir.linked.lots), ['a']);
  const rep = report(w, L);
  assert.deepEqual(bad(rep), []);
  const m = rep.metrics.climbs.per.find((q) => q.id === 'ladder_up');
  assert.ok(m && m.rungs === 15 && m.faceBad === 0 && m.notLadder === 0 && m.longFlights === 0, JSON.stringify(m));
  // (K5) nothing inside the lot's box
  const box = L.res.ir.lots.find((l) => l.id === 'a').box;
  for (const p of L.res.ir.parts.filter((q) => q.stage === 'site_links')) for (const op of p.ops) for (let t = 0; t < op.cols.length; t += 5) {
    const [x, z, y0, y1] = op.cols.slice(t, t + 4);
    for (let y = y0; y <= y1; y++) assert.ok(!(x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ), `${x},${y},${z} in the lot's box`);
  }
  const again = await planWorld(w, body(), links());
  assert.equal(again.res.irSha, L.res.irSha, 'deterministic');
});

test('the refusals: NO_CLIMB under 2, SPAN past PORT_LADDER.rungsMax rungs, ANCHOR on leaves, WATER; at realise an entry without the port NO_PORT (nothing written)', async () => {
  const code = async (w, o) => { const e = await planWorld(w, body(o)).then(() => null, (x) => x); assert.ok(e instanceof LinkError, String(e)); return e.code; };
  assert.equal(await code(world(), { y0: 0 }), 'NO_CLIMB', 'the port\'s feet 2 over the ground: rise 1');
  assert.equal(await code(makeWorld({ ground: G }), { y0: PORT_LADDER.rungsMax }), 'SPAN', 'no tree: the column clear to the ground, 25 rungs');
  assert.equal(await code(world(), { y0: PORT_LADDER.rungsMax }), 'ANCHOR', 'over the tree\'s leaves: the foot on leaves');
  assert.equal(await code(world([{ box: [1025, G, 2040, 1025, G, 2040], class: 'LEAVES' }]), {}), 'ANCHOR');
  assert.equal(await code(world([{ box: [1025, G, 2040, 1025, G, 2040], class: 'WATER' }]), {}), 'WATER');
  const w = world();
  const e = await planWorld(w, body(), links([walk('walk_e', [8, 2, 4], 'east')])).then(() => null, (x) => x);
  assert.ok(e instanceof LinkError && e.code === 'NO_PORT' && e.lot === 'a' && e.port === 'walk_w', String(e));
  // (the record's input: a ladder is 1 wide, its far end the ground or a form)
  const bad2 = await planWorld(w, body({ to: { lot: 'b' } })).then(() => null, (x) => x);
  assert.ok(bad2 && !(bad2 instanceof LinkError) && /ground: true\} or \{form/.test(bad2.message), String(bad2));
});

test('a ladder to a region-made form: its foot on the plan\'s own written cells (the land after the forms); without them it refuses ANCHOR', async () => {
  const w = world();
  const L = await planWorld(w, body({ mound: true, to: { form: 'mound' } }), links());
  assert.deepEqual(L.out.row.to, { form: 'mound', foot: [1025, G + 5, 2040] }, 'the foot on the mound\'s top (G + 4)');
  assert.equal(L.res.meta.climbs.find((q) => q.link === 'up').detail[0].flights[0].y0, G + 5);
  assert.deepEqual(bad(report(w, L)), []);
  const e = await planWorld(w, body({ to: { form: 'mound' } })).then(() => null, (x) => x);
  assert.ok(e instanceof LinkError && e.code === 'ANCHOR', String(e));
  // (the ground end over the same mound: the foot is the mound's top too, the land after the writes)
  const G2 = await planWorld(w, body({ mound: true }), links());
  assert.deepEqual(G2.out.row.to, { ground: true, foot: [1025, G + 5, 2040] });
});

const fx = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan', ...n.split('/')) + '.json', 'utf8'));
for (const [n, lot, port, facing] of [['valid/v7c_pl2_tree_ladder', 'treehouse', 'walk_w', 'west'], ['pl2/x02_hatch_ladder', 'home_a', 'hatch', 'down']]) {
  test(`plan/0 ${n}: READY, the ladder fits (to the site's ${port}); realised against the entry's port: IR v2, its row, the checker clean`, async () => {
    const f = fx(n);
    const r = await run(f);
    assert.equal(r.check.overall, 'READY');
    const a = r.check.parts.find((q) => q.part === 'up');
    assert.equal(a.class, 'fits', JSON.stringify(a));
    assert.deepEqual([a.geometry.link.from, a.geometry.link.to], [{ lot, port, facing }, { ground: true }]);
    assert.ok(a.geometry.link.rise >= 2);
    const site = r.res.ir.lots.find((l) => l.id === lot).site;
    const L = await run(f, { links: { lots: { [lot]: { entry: `${lot}_e`, ports: site.ports } } } });
    assert.equal(L.check.overall, 'READY');
    assert.equal(replayDiff(r.res.ir, L.res.ir, canonicalJson), null);
    const row = L.res.meta.links.find((q) => q.id === 'up');
    assert.equal(row.from.port, port);
    assert.ok(row.to.ground === true && row.to.foot[1] < row.from.at[1]);
    const s = svOf(f);
    const rep = checkRegion({ ir: L.res.ir, survey: s.bytes, blobs: (sha) => L.res.blobs.get(sha) ?? null, meta: L.res.meta, volumes: (L.volumes ?? []).map((v) => v.decoded) });
    assert.deepEqual(bad(rep), []);
    assert.equal(rep.metrics.climbs.per.find((q) => q.part === 'link_up').faceBad, 0);
  });
}

test('plan/0: a ladder to a form part whose top is not under the port refuses ANCHOR; villager movers MOVER; in survival unsupported (as every link at a site lot)', async () => {
  const f = fx('pl2/x02_hatch_ladder');
  f.plan.connectors[0].to = { part: 'isle' };
  const r = await run(f);
  const a = r.check.parts.find((q) => q.part === 'up');
  assert.equal(a.class, 'refused');
  assert.equal(a.reasons[0].code, 'ANCHOR');
  assert.equal(a.reasons[0].evidence.link, 'ANCHOR');
  const m = fx('valid/v7c_pl2_tree_ladder');
  m.plan.connectors[0].movers = ['villager'];
  const rm = await run(m);
  assert.equal(rm.check.parts.find((q) => q.part === 'up').reasons[0].code, 'MOVER');
  const sv = await run(fx('valid/v7c_pl2_tree_ladder'), { survival: true });
  const u = sv.check.parts.find((q) => q.part === 'up');
  assert.equal(u.class, 'unsupported', JSON.stringify(u));
});

test('the catalogue: ladder.port, supported, its limits the kit\'s', () => {
  const e = planCatalogue().entries.find((x) => x.id === 'ladder.port');
  assert.ok(e && e.state === 'supported');
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
  assert.deepEqual([e.limits.rise[0], e.limits.rungs], [PORT_LADDER.riseMin, PORT_LADDER.rungsMax]);
  const golden = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(golden.entries.find((x) => x.id === 'ladder.port'), e);
});
