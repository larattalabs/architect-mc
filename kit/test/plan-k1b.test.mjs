// (7a K1b) Rope bridges and `connector.auto` through the plan check (docs/CONTRACT.md "Phase 7a slice K1" §9, §10 items 5, 6, 7, 10,
// 11): v33 and v34 on rift_city (fits, the checker's rope rules clean, both movers across), the refusal fixtures (fixtures/plan/rope:
// NO_GAP, SPAN 7 and 41, ANCHOR, HEADROOM, TOO_STEEP, MOVER and the whole-block broken variant), Steward's recorded rope parts (§9:
// treetop's 9 NO_GAP with a `path` wouldFit that fits alone, swamp_stilts, upside_down's self-loop), determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, stewardAnchors, checkPlanLocal, flatSurvey, FIX, asksFirstPath } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { encodeArvx, decodeArvx, VC } from '../lib/region/volume.mjs';
import { surveyApi } from '../lib/region/survey.mjs';

const read = (dir) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const part = (r, id) => r.check.parts.find((a) => a.part === id);

/** A fixture's frozen volume: soil to the ground, rock 4 under it, air above, LOOSE in `loose` [x0, z0, x1, z1, y0, y1]. */
function volumeOf(spec, survey, claim) {
  const [x0, y0, z0, x1, y1, z1] = spec.box;
  const box = { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 };
  const W = x1 - x0 + 1, H = y1 - y0 + 1, D = z1 - z0 + 1;
  const S = surveyApi(survey, claim);
  const classes = new Uint8Array(W * H * D);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const g = S.groundAt(x, z);
    for (let y = y0; y <= y1; y++) {
      const L = spec.loose;
      const loose = L && x >= L[0] && x <= L[2] && z >= L[1] && z <= L[3] && y >= L[4] && y <= L[5] && y <= g;
      classes[((x - x0) * D + (z - z0)) * H + (y - y0)] = y > g ? VC.AIR : loose ? VC.LOOSE : y >= g - 3 ? VC.SOIL : VC.ROCK;
    }
  }
  const bytes = encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  return { box, bytes, sha: decoded.sha, decoded };
}

/** Check a fixture: its terrain (flat with bands), its anchors over Steward's, its frozen volume. */
async function run(fx, extra = {}) {
  const s = fx.on === 'asks' ? asksSurvey() : flatSurvey(fx.terrain ?? {});
  const volumes = fx.volume ? [volumeOf(fx.volume, s.bytes, s.claim)] : [];
  const r = await checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, volumes, ...extra });
  return { ...r, survey: s, volumes };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });

test('v33 and v34 on rift_city: every part fits; the deck follows the profile, railed and clear, its posts 2 deep, 0 dark deck cells, both movers across', async () => {
  for (const f of read('valid').filter((x) => /^v3[34]_/.test(x.name))) {
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons]))}`);
    const rep = checkOf(r);
    const ropes = rep.metrics.ropes?.per ?? [];
    assert.equal(ropes.length, 1, `${f.name}: one bridge`);
    for (const q of ropes) {
      assert.ok(q.ok, `${f.name}: M10:rope ${JSON.stringify(q)}`);
      assert.equal(q.railed, q.n, `${f.name}: rails on both sides of every deck cell`);
      assert.equal(q.headroom, q.n, `${f.name}: 2 clear over every deck cell`);
    }
    assert.equal(rep.metrics.M5rope.darkSpawnable, 0, `${f.name}: dark deck cells ${JSON.stringify(rep.metrics.M5rope)}`);
    assert.ok(rep.metrics.M5rope.deckCells > 0, `${f.name}: the deck is reached from the entrance`);
    assert.ok(!rep.findings.some((f2) => /^M(1|3|6|10)(:|$)/.test(f2.rule) || f2.rule === 'M8'), `${f.name}: ${rep.findings.map((x) => `${x.rule} ${x.message}`).join('; ')}`);
    for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, `${f.name}: ${e.id} ${JSON.stringify(e)}`);
    const span = r.check.parts.find((a) => (a.geometry?.spans ?? []).length);
    assert.ok(span.cost.bom['minecraft:iron_chain'] > 0 && Object.keys(span.cost.bom).some((k) => /_slab$/.test(k)), `${f.name}: the BOM ${JSON.stringify(span.cost.bom)}`);
    assert.equal(span.geometry.spans[0].crossing.over, 'gap');
    assert.ok(span.geometry.spans[0].crossing.depth > 20);
    // the IR's graph types a rope_bridge connector's edge (§8) with its crossing
    if (f.name.startsWith('v33')) assert.ok(r.res.ir.graph.edges.some((e) => e.type === 'rope_bridge' && e.crossing?.over === 'gap'));
  }
  // v34: `stroll` walks (no span), `across` spans
  const v34 = await run(read('valid').find((x) => x.name.startsWith('v34')));
  assert.equal(part(v34, 'across').geometry.spans.length, 1);
  assert.equal(part(v34, 'stroll').geometry.spans.length, 0);
  assert.ok(part(v34, 'stroll').notes.some((n) => /walking is cheaper/.test(n)));
});

test('the refusal fixtures (fixtures/plan/rope): each answers its code with evidence', async () => {
  const fx = read('rope');
  assert.ok(fx.length >= 8);
  for (const f of fx) {
    const r = await run(f);
    const a = part(r, f.expect.part);
    if (f.expect.class) { assert.equal(a.class, f.expect.class, `${f.name}: ${JSON.stringify(a)}`); continue; }
    assert.equal(a.class, 'refused', `${f.name}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f.name}: evidence`);
    for (const [k, v] of Object.entries(f.expect.evidence ?? {})) assert.deepEqual(a.reasons[0].evidence[k], v, `${f.name}: evidence.${k}`);
    if (f.expect.code === 'ANCHOR') assert.ok(a.reasons[0].evidence.found.some((c) => c.class === 'LOOSE'), `${f.name}: the classes found`);
  }
});

test('auto: walking round a short ditch is cheaper than a span; across a long ravine the span wins', async () => {
  const anchors = { a: [1030, 65, 2040], b: [1070, 65, 2040] };
  // a 12-cell ditch only 20 long (z 2030..2049): the walk round it is shorter than 300 + 30n
  const ditch = { terrain: { W: 160, D: 96, x0: 1000, z0: 2000, bands: [{ x0: 1045, z0: 2030, x1: 1056, z1: 2049, y: 40 }] }, anchors, plan: { schemaVersion: 'plan/0', connectors: [{ id: 'go', kind: 'auto', from: { anchor: 'a' }, to: { anchor: 'b' } }] } };
  const r1 = await run(ditch);
  assert.equal(part(r1, 'go').class, 'fits');
  assert.equal(part(r1, 'go').geometry.spans.length, 0);
  // the same ditch across the whole claim: no walk round, it spans
  const r2 = await run({ ...ditch, terrain: { ...ditch.terrain, bands: [{ x0: 1045, z0: 2000, x1: 1056, z1: 2095, y: 40 }] } });
  assert.equal(part(r2, 'go').class, 'fits');
  assert.equal(part(r2, 'go').geometry.spans.length, 1);
});

/** Steward's recorded plans (fixtures/plan/asks) on the asks claim. */
const asksPlan = (name) => JSON.parse(fs.readFileSync(asksFirstPath(`${name}.json`), 'utf8')).answer.plan; // ((6c close-out A) the first recordings)
const A = asksSurvey();
const asks = (plan) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });

test('§9: treetop_village\'s 9 rope bridges refuse NO_GAP, each with a `path` wouldFit that fits re-checked alone', async () => {
  const plan = asksPlan('treetop_village');
  const r = await asks(plan);
  const ropes = r.check.parts.filter((a) => a.block === 'connector.rope_bridge');
  assert.equal(ropes.length, 9);
  for (const a of ropes) {
    assert.equal(a.class, 'refused', `${a.part}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, 'NO_GAP', `${a.part}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence, `${a.part}: evidence`);
    assert.equal(a.wouldFit?.length, 1, `${a.part}: wouldFit`);
    assert.equal(a.wouldFit[0].fragment.kind, 'path');
    // re-checked alone: the plan's zones and this connector, as a path
    const alone = { ...plan, connectors: [a.wouldFit[0].fragment] };
    const r2 = await asks(alone);
    assert.equal(part(r2, a.part).class, 'fits', `${a.part} alone: ${JSON.stringify(part(r2, a.part))}`);
  }
});

test('§9: swamp_stilts\' rope bridges refuse NO_GAP (no water across their approach); upside_down\'s chain bridges are a self-loop (NO_GAP)', async () => {
  const sw = await asks(asksPlan('swamp_stilts'));
  const swr = sw.check.parts.filter((a) => a.block === 'connector.rope_bridge');
  assert.ok(swr.length >= 1);
  for (const a of swr) { assert.equal(a.class, 'refused'); assert.equal(a.reasons[0].code, 'NO_GAP', JSON.stringify(a.reasons)); }
  const ud = await asks(asksPlan('upside_down'));
  const udr = ud.check.parts.filter((a) => a.block === 'connector.rope_bridge');
  assert.ok(udr.length >= 1);
  for (const a of udr) { assert.equal(a.class, 'refused'); assert.equal(a.reasons[0].code, 'NO_GAP'); assert.match(a.reasons[0].message, /one place/); }
});

test('determinism: 3 checks of v33 and of each refusal fixture give identical answers and artifact shas', async () => {
  for (const f of [...read('valid').filter((x) => /^v3[34]_/.test(x.name)), ...read('rope')]) {
    const runs = [await run(f), await run(f), await run(f)];
    const key = (r) => JSON.stringify(r.check.parts);
    assert.equal(key(runs[1]), key(runs[0]), `${f.name}: answers 2`);
    assert.equal(key(runs[2]), key(runs[0]), `${f.name}: answers 3`);
    assert.equal(runs[1].artifactSha, runs[0].artifactSha, `${f.name}: artifact 2`);
    assert.equal(runs[2].artifactSha, runs[0].artifactSha, `${f.name}: artifact 3`);
    assert.equal(runs[1].res.irSha, runs[0].res.irSha, `${f.name}: IR 2`);
  }
});
