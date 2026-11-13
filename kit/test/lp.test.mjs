// (7b LP, docs/CONTRACT.md "Phase 7b" slice LP row 10, changes 3 and 4, "Slice LP as built") The link pass: port links between site
// lots (r.portLink, plan/0's connectors to an elevated zone's lots), routed at plan time to the sites' ports and written at realise
// (ctx.links: the bound entries' ports) in the stage site_links after the lots (IR v2); every connector's guarantees re-checked by the
// region checker against the port endpoints (catwalk M10:catwalk, branch_walk M10:branch_walk, tunnel.under M3/M4:tunnel); no link cell
// in any lot's box (K5) and each end the cell outside its port; NO_LINK {lot, port} before any write; the replay guard; determinism;
// change 4 (a plan without port links has no site_links stage, no portLinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { makeWorld, tree, planWorld } from './lp-world.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { LINK_STAGE, LinkError, lotPortsWorld, replayDiff } from '../lib/region/links.mjs';
import { canonicalJson } from '../lib/region/pack.mjs';
import { Site } from '../lib/site.mjs';
import { read, run } from './plan-p0-shared.mjs';

const G = 64;
const walk = (name, at, facing) => ({ name, kind: 'architect:walk', at, facing, width: 2, height: 2 });
const door = (name, at, facing) => ({ name, kind: 'door', at, facing, width: 1, height: 2 });
const inBox = (b, [x, y, z]) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;

/** Every cell a part writes (columns ops, absolute y). */
function cellsOf(ir, partId) {
  const out = [];
  for (const p of ir.parts.filter((q) => q.id === partId)) for (const op of p.ops) {
    assert.equal(op.op, 'columns', `${partId}: a link writes columns ops only`);
    for (let t = 0; t < op.cols.length; t += 5) for (let y = op.cols[t + 2]; y <= op.cols[t + 3]; y++) out.push([op.cols[t], y, op.cols[t + 1]]);
  }
  return out;
}

/** The link's guarantees: K5 (no cell in any lot box), each end the out cell of its port, and the region checker clean of `rules`. */
function guarantees(world, L, rules) {
  const ir = L.res.ir;
  assert.deepEqual(ir.stages.slice(ir.stages.indexOf('lots'), ir.stages.indexOf('lots') + 2), ['lots', LINK_STAGE]);
  assert.ok(ir.linked && Object.keys(ir.linked.lots).length === 2, 'IR v2 records the entries it was linked from');
  for (const row of L.res.meta.links) {
    const cells = cellsOf(ir, row.part);
    assert.ok(cells.length > 0, `${row.id}: writes cells`);
    for (const l of ir.lots) for (const c of cells) assert.ok(!inBox(l.box, c), `${row.id}: cell ${c} inside lot ${l.id}'s box (K5)`);
    for (const end of [row.from, row.to]) {
      const l = ir.lots.find((q) => q.id === end.lot);
      assert.ok(inBox(l.box, end.at), `${row.id}: port ${end.lot}.${end.port} in its lot's box`);
      assert.ok(!inBox(l.box, end.out), `${row.id}: ${end.lot}.${end.port}'s end cell outside its box`);
      const d = Math.abs(end.out[0] - end.at[0]) + Math.abs(end.out[2] - end.at[2]);
      assert.equal(d, 1, `${row.id}: the end cell is next to the port in its facing`);
      assert.equal(end.out[1], end.at[1], `${row.id}: at the port's feet y`);
    }
  }
  const c = checkRegion({ ir, survey: world.survey, blobs: (s) => L.res.blobs.get(s), volumes: [world.vol], meta: L.res.meta });
  const bad = c.findings.filter((f) => rules.some((r) => f.rule.startsWith(r)));
  assert.deepEqual(bad.map((f) => `${f.rule}: ${f.message}`), []);
  return c;
}

// ------------------------------------------------------------------ worlds

const trees = () => makeWorld({ ground: G, edits: [...tree(1030, 2040, G), ...tree(1050, 2040, G)] });
const canopy = (cx, cz) => [cx - 4, G + 13, cz - 4, cx + 4, G + 20, cz + 4];
const walkBody = (portsA = null) => (r) => {
  r.siteLot('a', { fit: 'wrap_trunk', box: canopy(1030, 2040), stage: 'lots', ...(portsA ? { ports: portsA } : {}) });
  r.siteLot('b', { fit: 'wrap_trunk', box: canopy(1050, 2040), stage: 'lots' });
  return r.portLink('ab', { kind: 'branch_walk', from: { lot: 'a' }, to: { lot: 'b' } });
};
const cliff = () => makeWorld({ ground: G, edits: [{ box: [1005, 49, 2050, 1085, 95, 2055], class: 'ROCK' }] });
const catBody = (r) => {
  r.siteLot('a', { fit: 'on_pad', box: [1010, 80, 2042, 1018, 87, 2049], stage: 'lots', ports: [walk('walk_e', [8, 2, 7], 'east')] });
  r.siteLot('b', { fit: 'on_pad', box: [1040, 80, 2042, 1048, 87, 2049], stage: 'lots', ports: [walk('walk_w', [0, 2, 7], 'west')] });
  return r.portLink('cw', { kind: 'catwalk', from: { lot: 'a' }, to: { lot: 'b' } });
};
const hill = () => makeWorld({ ground: G, edits: [{ box: [1005, 49, 2005, 1085, 92, 2035], class: 'ROCK' }] });
const cellarBody = (r) => {
  r.siteLot('a', { fit: 'carve_into', box: [1012, 70, 2016, 1020, 77, 2024], stage: 'lots', ports: [door('door_e', [8, 0, 4], 'east')] });
  r.siteLot('b', { fit: 'carve_into', box: [1040, 70, 2016, 1048, 77, 2024], stage: 'lots', ports: [door('door_w', [0, 0, 4], 'west')] });
  return r.portLink('tu', { kind: 'tunnel', from: { lot: 'a' }, to: { lot: 'b' } });
};

// ------------------------------------------------------------------ tests

test('ports in the world: lotPortsWorld turns design cells and facings as lib/site.mjs Site does, in all four rotations', async () => {
  const w = trees();
  const ports = [walk('p1', [0, 2, 1], 'west'), walk('p2', [6, 1, 8], 'south'), walk('p3', [3, 0, 0], 'north'), { name: 'h', kind: 'architect:walk', at: [2, 0, 3], facing: 'down', width: 1, height: 1 }];
  for (const rotation of ['none', 'clockwise_90', 'clockwise_180', 'counterclockwise_90']) {
    let lot;
    const box = [1026, G + 13, 2036, 1034, G + 20, 2044];
    const { res } = await planWorld(w, (r) => { lot = r.siteLot('a', { fit: 'wrap_trunk', box, rotation, stage: 'lots', ports }); });
    const blob = res.ir.blobs?.site_a;
    const site = new Site(zlib.gunzipSync(res.blobs.get(blob.sha)), lot.site);
    const got = lotPortsWorld(lot);
    for (const [i, p] of ports.entries()) {
      assert.deepEqual(got[i].cell, site.toWorld(...p.at), `${rotation} ${p.name}`);
      assert.equal(got[i].facing, site.worldFacing(p.facing), `${rotation} ${p.name} facing`);
    }
  }
});

test('branch_walk: plan time records the link (the sites\' ports, an empty site_links stage, no op); the realise writes it, every guarantee met', async () => {
  const w = trees();
  const east = [walk('walk_e', [8, 2, 4], 'east')];
  const P = await planWorld(w, walkBody(east));
  assert.deepEqual(P.res.ir.portLinks, [{ id: 'ab', kind: 'branch_walk', from: { lot: 'a', port: 'walk_e', facing: 'east' }, to: { lot: 'b', port: 'walk_w', facing: 'west' } }]);
  assert.deepEqual(P.res.ir.stages, ['ground', 'lots', LINK_STAGE, 'props']);
  assert.deepEqual(P.res.ir.parts.filter((p) => p.stage === LINK_STAGE), []);
  assert.equal(P.res.ir.linked, undefined);
  const links = { lots: { a: { entry: 'ea', ports: east }, b: { entry: 'eb', ports: [walk('walk_w', [0, 2, 3], 'west')] } } };
  const L = await planWorld(w, walkBody(east), { links });
  const c = guarantees(w, L, ['M10:branch_walk', 'M6', 'M8', 'M1:site']);
  const m = c.metrics.branchWalks.per[0];
  assert.ok(m.ok && m.hangers >= 1 && m.maxSpan <= 8 && m.maxLampGap <= 12 && m.inLots === 0, JSON.stringify(m));
  assert.deepEqual(L.res.meta.links[0].to.out, [1045, G + 15, 2039], 'the realise follows the entry\'s port (one cell north of the site\'s)');
  assert.equal(replayDiff(P.res.ir, L.res.ir, canonicalJson), null, 'IR v2 = IR v1 plus the links');
  const again = await planWorld(w, walkBody(east), { links });
  assert.equal(again.res.irSha, L.res.irSha, 'deterministic');
});

test('branch_walk routed round a lot (both ports facing west): the walk keeps out of every lot\'s columns, hangers at most 8 apart', async () => {
  const w = trees();
  const L = await planWorld(w, walkBody(), { links: { lots: { a: { entry: 'ea', ports: [walk('walk_w', [0, 2, 4], 'west')] }, b: { entry: 'eb', ports: [walk('walk_w', [0, 2, 4], 'west')] } } } });
  const bw = L.res.meta.branchWalks[0];
  assert.ok(bw.path.length > 20, `a walk round lot a (${bw.path.length})`);
  guarantees(w, L, ['M10:branch_walk', 'M6', 'M8', 'M1:site']);
});

test('catwalk to a port: a straight level deck along the rock face between two ports facing each other; M10:catwalk clean', async () => {
  const w = cliff();
  const P = await planWorld(w, catBody);
  assert.equal(P.res.ir.portLinks[0].kind, 'catwalk');
  const L = await planWorld(w, catBody, { links: { lots: { a: { entry: 'a', ports: [walk('walk_e', [8, 2, 7], 'east')] }, b: { entry: 'b', ports: [walk('walk_w', [0, 2, 7], 'west')] } } } });
  const c = guarantees(w, L, ['M10:catwalk', 'M6', 'M8', 'M1:site']);
  const cw = L.res.meta.catwalks[0];
  assert.equal(cw.n, 21);
  assert.equal(cw.side, 'right', 'the face (the rock to the south) on the heading\'s right');
  assert.ok(c.metrics.catwalks.per[0].ok, JSON.stringify(c.metrics.catwalks.per[0]));
});

test('tunnel.under: a bore between two cellar doors (door ports facing each other) under the hill; M3/M4:tunnel clean', async () => {
  const w = hill();
  const P = await planWorld(w, cellarBody);
  assert.equal(P.res.ir.portLinks[0].kind, 'tunnel');
  const L = await planWorld(w, cellarBody, { links: { lots: { a: { entry: 'a', ports: [door('door_e', [8, 0, 4], 'east')] }, b: { entry: 'b', ports: [door('door_w', [0, 0, 4], 'west')] } } } });
  assert.equal(L.res.meta.links[0].kind, 'tunnel.under');
  guarantees(w, L, ['M3:tunnel', 'M4:tunnel', 'M6', 'M1:site']);
  // walk ports are not cellar doors
  await assert.rejects(planWorld(w, (r) => {
    r.siteLot('a', { fit: 'carve_into', box: [1012, 70, 2016, 1020, 77, 2024], stage: 'lots', ports: [walk('w_e', [8, 0, 4], 'east')] });
    r.siteLot('b', { fit: 'carve_into', box: [1040, 70, 2016, 1048, 77, 2024], stage: 'lots', ports: [walk('w_w', [0, 0, 4], 'west')] });
    r.portLink('tu', { kind: 'tunnel', from: { lot: 'a' }, to: { lot: 'b' } });
  }), (e) => e instanceof LinkError && e.code === 'NO_PORT');
});

test('NO_LINK at realise, named {lot, port}: no entry bound, the port missing, another facing, the route failing at the entry\'s cell', async () => {
  const w = trees();
  const east = [walk('walk_e', [8, 2, 4], 'east')];
  const bOk = { entry: 'eb', ports: [walk('walk_w', [0, 2, 4], 'west')] };
  const cases = [
    [{ a: { entry: 'ea', ports: east } }, 'NO_PORT', 'b', 'walk_w'],
    [{ a: { entry: 'ea', ports: east }, b: { entry: 'eb', ports: [walk('door', [0, 2, 4], 'west')] } }, 'NO_PORT', 'b', 'walk_w'],
    [{ a: { entry: 'ea', ports: [walk('walk_e', [8, 2, 4], 'south')] }, b: bOk }, 'FACING', 'a', 'walk_e'],
    // a feet row with no head room under the leaf layer: the walk can't stand there
    [{ a: { entry: 'ea', ports: [walk('walk_e', [8, 7, 4], 'east')] }, b: bOk }, 'LEVEL', 'b', 'walk_w'],
  ];
  for (const [lots, code, lot, port] of cases) {
    await assert.rejects(planWorld(w, walkBody(east), { links: { lots } }), (e) => {
      assert.ok(e instanceof LinkError, String(e));
      assert.deepEqual([e.code, e.lot, e.port], [code, lot, port], e.message);
      return true;
    });
  }
});

test('plan time: a link that can\'t reach its sites\' ports throws for a program; the replay guard names what moved', async () => {
  const w = trees();
  await assert.rejects(planWorld(w, walkBody([walk('walk_e', [8, 7, 4], 'east')])), (e) => e instanceof LinkError && e.code === 'LEVEL' && e.lot === 'b');
  const P = await planWorld(w, walkBody([walk('walk_e', [8, 2, 4], 'east')]));
  const L = await planWorld(w, walkBody([walk('walk_e', [8, 2, 4], 'east')]), { links: { lots: { a: { entry: 'ea', ports: [walk('walk_e', [8, 2, 4], 'east')] }, b: { entry: 'eb', ports: [walk('walk_w', [0, 2, 4], 'west')] } } } });
  const t = JSON.parse(JSON.stringify(L.res.ir));
  t.lots[0].floorY += 1;
  assert.match(replayDiff(P.res.ir, t, canonicalJson), /lots/);
  const u = JSON.parse(JSON.stringify(L.res.ir));
  u.parts.push({ ...JSON.parse(JSON.stringify(u.parts.find((p) => p.stage === LINK_STAGE))), id: 'stray', stage: 'props' });
  assert.match(replayDiff(P.res.ir, u, canonicalJson), /parts stray/);
});

// ------------------------------------------------------------------ plan/0 (Steward's path)

const V7B = read('valid').find((f) => f.name === 'v7b_sl_canopy.json');
const withConn = (c) => ({ ...V7B, plan: { ...V7B.plan, connectors: [c] } });

test('plan/0: a branch_walk between the two canopy huts fits (READY), routed to their sites\' walk_w ports; the realise\'s replay links it', async () => {
  const r = await run(withConn({ id: 'walk', kind: 'branch_walk', from: { part: 'hut_a' }, to: { part: 'hut_b' } }));
  assert.equal(r.check.overall, 'READY');
  const a = r.check.parts.find((p) => p.part === 'walk');
  assert.equal(a.class, 'fits');
  assert.deepEqual([a.geometry.link.from.port, a.geometry.link.to.port], ['walk_w', 'walk_w']);
  assert.ok(r.res.ir.stages.includes(LINK_STAGE));
  assert.equal(r.res.ir.portLinks[0].planPart, 'walk');
  const links = { lots: Object.fromEntries(['hut_a', 'hut_b'].map((id) => [id, { entry: `e_${id}`, ports: r.res.ir.lots.find((l) => l.id === id).site.ports }])) };
  const L = await run(withConn({ id: 'walk', kind: 'branch_walk', from: { part: 'hut_a' }, to: { part: 'hut_b' } }), { volumes: r.volumes, links });
  assert.equal(replayDiff(r.res.ir, L.res.ir, canonicalJson), null);
  assert.deepEqual(L.res.ir.parts.filter((p) => p.stage === LINK_STAGE).map((p) => p.id), ['link_walk']);
  assert.equal(L.check.parts.find((p) => p.part === 'walk').class, 'fits');
});

test('plan/0: the zone-and-lot endpoint form, a named site port, a rope bridge (unsupported), a catwalk whose ports face away (refused FACING)', async () => {
  const z = await run(withConn({ id: 'walk', kind: 'branch_walk', from: { part: 'canopy', port: 'hut_a' }, to: { part: 'hut_b', port: 'walk_w' } }));
  assert.equal(z.check.parts.find((p) => p.part === 'walk').class, 'fits');
  const np = await run(withConn({ id: 'walk', kind: 'branch_walk', from: { part: 'hut_a', port: 'walk_x' }, to: { part: 'hut_b' } }));
  const anp = np.check.parts.find((p) => p.part === 'walk');
  assert.deepEqual([anp.class, anp.reasons[0].code, anp.reasons[0].evidence.link, anp.reasons[0].evidence.lot, anp.reasons[0].evidence.port], ['refused', 'NO_FEATURE', 'NO_PORT', 'hut_a', 'walk_x']);
  const rb = await run(withConn({ id: 'b1', kind: 'rope_bridge', from: { part: 'hut_a' }, to: { part: 'hut_b' } }));
  const ab = rb.check.parts.find((p) => p.part === 'b1');
  assert.equal(ab.class, 'unsupported');
  assert.equal(ab.reasons[0].until, undefined);
  assert.ok(!rb.res.ir.stages.includes(LINK_STAGE), 'no port link: no site_links stage');
  const cw = await run(withConn({ id: 'cw', kind: 'catwalk', from: { part: 'hut_a' }, to: { part: 'hut_b' } }));
  const ac = cw.check.parts.find((p) => p.part === 'cw');
  assert.deepEqual([ac.class, ac.reasons[0].code, ac.reasons[0].evidence.link], ['refused', 'ANCHOR', 'FACING']);
  assert.equal(cw.res.ir.portLinks, undefined, 'a refused link is not recorded');
  // a branch walk with an end that isn't a site lot
  const off = await run(withConn({ id: 'bw', kind: 'branch_walk', from: { part: 'hut_a' }, to: { anchor: 'grove' } }));
  assert.equal(off.check.parts.find((p) => p.part === 'bw').class, 'unsupported');
});

test('change 4: a plan without port links keeps its stages and IR (no site_links stage, no portLinks, no linked)', async () => {
  const r = await run(V7B);
  assert.ok(!r.res.ir.stages.includes(LINK_STAGE));
  assert.equal(r.res.ir.portLinks, undefined);
  assert.equal(r.res.ir.linked, undefined);
  for (const f of read('valid').filter((x) => /^v(1|2)/.test(x.name)).slice(0, 4)) {
    const q = await run(f);
    assert.ok(!q.res.ir.stages.includes(LINK_STAGE), f.name);
  }
});

test('the catalogue: connector.branch_walk (schemaVersion 1) and tunnel.under flip reserved -> supported, sinceApi NEXT, no until; nothing else of LP\'s', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { planCatalogue } = await import('../lib/plan/catalogue.mjs');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const golden = JSON.parse(fs.readFileSync(path.join(here, '..', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const before = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'plan', 'catalogue-pre7b.json'), 'utf8'));
  assert.ok(golden.catalogueVersion >= before.catalogueVersion, 'catalogueVersion is the coordinator\'s at merge (at least the snapshot\'s)');
  const changed = golden.entries.filter((e) => JSON.stringify(e) !== JSON.stringify(before.entries.find((x) => x.id === e.id))).map((e) => e.id);
  assert.deepEqual(changed.filter((id) => !['form.hidden_room', 'rule.suspended', 'layout.elevated', 'program.authored', 'form.hollow_mountain', 'form.crater', 'form.floating_island'].includes(id)).sort(), ['connector.branch_walk', 'tunnel.under']); // ((7c BF) its three flips: bf.test.mjs)
  for (const id of ['connector.branch_walk', 'tunnel.under']) {
    const e = golden.entries.find((x) => x.id === id);
    assert.equal(e.state, 'supported', id);
    assert.equal(e.until, undefined, id);
    assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), id);
  }
  assert.equal(golden.entries.find((x) => x.id === 'connector.branch_walk').schemaVersion, 1);
});
