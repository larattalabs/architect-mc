// (6c T3a) Bridges through the plan check (docs/CONTRACT.md "Phase 6c slice T3" §1, §3, §4, §8, §9, §10 items 7, 8, 10, 12; Steward's
// review S-T3-2, S-T3-3, S-T3-7, S-T3-8): v35 (a beam over a dry ravine), v36 (an arch over a water channel), v38's auto bridge, the
// street fallback (t3a/v39), the refusal fixtures (fixtures/plan/t3a: NO_GAP, SPAN 33 and an arch of 25, ANCHOR on sand and a pier 25
// tall, WATER (after H-b: kind deep, flowing or lava) with the arch's and a rope's wouldFit, HEADROOM, TOO_STEEP, MOVER, the self-loop, lenient params), a bridge landing
// at a K1 gate (`lands`), Steward's recorded bridge parts (§9) and the gap tables, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, stewardAnchors, checkPlanLocal, checkPlanVolumes, flatSurvey, FIX } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { encodeArvx, decodeArvx, VC } from '../lib/region/volume.mjs';
import { surveyApi } from '../lib/region/survey.mjs';

const read = (dir, re = /./) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && re.test(f)).sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const part = (r, id) => r.check.parts.find((a) => a.part === id);

/** A fixture's frozen volume (as plan-k1b.test.mjs's): soil to the ground, rock 4 under it, air above, LOOSE in `loose`. */
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

/** Check a fixture: its terrain (flat with bands) or the asks claim, its anchors over Steward's, its protected areas, its volume. */
async function run(fx, extra = {}) {
  const s = fx.on === 'asks' ? asksSurvey() : flatSurvey(fx.terrain ?? {});
  // ((6c T3 batch) a fixture with T3b's `volume.given` (v38_auto_crossings: the auto edge that tunnels) runs T3b's two-plan harness)
  // ((6c H-b) a fixture the wet fallback answers (`wet`): the two-plan flow, the water's frozen volume synthesized from the survey)
  if (fx.volume?.given || fx.wet) {
    const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], volume: fx.volume ?? {}, ...extra });
    return { ...r, survey: s };
  }
  const volumes = fx.volume ? [volumeOf(fx.volume, s.bytes, s.claim)] : [];
  const r = await checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], volumes, ...extra });
  return { ...r, survey: s, volumes };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });

test('v35, v36, v38: the bridges fit; the checker clean on the virtual world (M10:bridge, M8, M6, M5, M3, M1), both movers across', async () => {
  for (const f of read('valid', /^v3[568]_/)) {
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons]))}`);
    const rep = checkOf(r);
    const per = rep.metrics.bridges?.per ?? [];
    assert.ok(per.length >= 1, `${f.name}: a bridge`);
    for (const q of per) {
      assert.ok(q.ok, `${f.name}: M10:bridge ${JSON.stringify(q)}`);
      assert.equal(q.railed, q.n);
      assert.equal(q.headroom, q.n);
    }
    assert.equal(rep.metrics.M5bridge.darkSpawnable, 0, `${f.name}: ${JSON.stringify(rep.metrics.M5bridge)}`);
    assert.ok(!rep.findings.some((x) => /^M(1|3|6|10)(:|$)/.test(x.rule) || x.rule === 'M8'), `${f.name}: ${rep.findings.map((x) => `${x.rule} ${x.message}`).join('; ')}`);
    for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, `${f.name}: ${e.id} ${JSON.stringify(e)}`);
  }
  const v35 = await run(read('valid', /^v35_/)[0]);
  const b35 = part(v35, 'ravine_road').geometry.bridges;
  assert.deepEqual(b35.map((b) => [b.form, b.n, b.piers]), [['beam', 28, 3]], 'auto takes the beam where the arch can\'t (28 > 24)');
  assert.deepEqual(b35[0].crossing, { type: 'bridge', form: 'beam', over: 'gap', depth: 12, clearance: 0, span: 28 });
  assert.ok(Object.keys(part(v35, 'ravine_road').cost.bom).some((k) => /_wall$/.test(k)), 'the rails are wall blocks');
  // the IR graph types a bridge connector's edge (§8) with its crossing
  assert.ok(v35.res.ir.graph.edges.some((e) => e.type === 'bridge' && e.crossing?.form === 'beam' && e.crossing.span === 28));
  const v36 = await run(read('valid', /^v36_/)[0]);
  const b36 = part(v36, 'channel_arch').geometry.bridges[0];
  assert.equal(b36.form, 'arch', 'auto takes the arch where it fits');
  assert.equal(b36.crossing.over, 'water');
  assert.equal(b36.crossing.clearance, 2);
  // the siteplan's bridges (§8)
  const { sitePlan } = await import('../lib/region/siteplan.mjs');
  const sp = sitePlan({ ir: v36.res.ir, meta: v36.res.meta });
  assert.deepEqual(sp.bridges.map((b) => [b.form, b.span, b.piers.length, b.landings.length]), [['arch', 20, 0, 2]]);
  // (6c T3 batch) v38_auto_crossings: one auto edge bridges, one tunnels (T3b's half, in the caller's volume), one walks
  const v38 = await run(read('valid', /^v38_/)[0]);
  assert.equal(part(v38, 'across').geometry.bridges.length, 1, 'across crosses the ditch on a bridge');
  assert.equal(part(v38, 'across').geometry.tunnels, undefined, 'across bores nothing');
  assert.equal(part(v38, 'pass').geometry.tunnels?.length, 1, 'pass tunnels through the ridge');
  assert.equal(part(v38, 'pass').geometry.bridges, undefined, 'pass spans nothing');
  assert.equal(part(v38, 'stroll').geometry.bridges, undefined, 'stroll walks');
  assert.equal(part(v38, 'stroll').geometry.tunnels, undefined, 'stroll walks');
  // rope.mjs's note (T3a's shared edit): only the edge that crossed on nothing says walking is cheaper
  assert.deepEqual(['across', 'pass', 'stroll'].filter((id) => (part(v38, id).notes ?? []).some((n) => /walking is cheaper/.test(n))), ['stroll']);
});

test('the street fallback (S-T3-2): a road whose every route crosses water takes a bridge, adjusted with a `crossing` deviation', async () => {
  const f = read('t3a', /^v39_/)[0];
  const r = await run(f);
  const a = part(r, 'r');
  assert.equal(a.class, 'adjusted', JSON.stringify(a));
  const dv = a.deviations.find((d) => d.what === 'crossing');
  assert.ok(dv && dv.kind === 'crossing' && dv.value === 1, JSON.stringify(a.deviations));
  assert.equal(a.geometry.bridges[0].crossing.over, 'water');
  // the graph edge stays a road; its bridged segment carries the crossing
  const ge = r.res.ir.graph.edges.find((e) => e.segments?.some((g) => g.kind === 'bridge'));
  assert.ok(ge && ge.type !== 'bridge' && ge.segments.find((g) => g.kind === 'bridge').crossing?.type === 'bridge', JSON.stringify(ge));
  // the checker on it: the bridge clean, its clearance over the stream as asked
  const rep = checkOf(r);
  assert.ok(rep.metrics.bridges.per.every((q) => q.ok && q.under && q.under.have >= 2), JSON.stringify(rep.metrics.bridges));
  // without the grove the road goes round the lake (no water crossed): no bridge, its answer as before
  const r2 = await run({ ...f, protected: [] });
  assert.equal(part(r2, 'r').geometry?.bridges, undefined);
});

test('the refusal fixtures (fixtures/plan/t3a): each answers its code with evidence; (H-b) r06 and r07 re-answered on wet piers, r06b WATER deep; the wouldFits fit re-checked alone', async () => {
  const fx = read('t3a', /^r\d/);
  assert.ok(fx.length >= 12, `${fx.length} fixtures`);
  for (const f of fx) {
    const r = await run(f);
    const a = part(r, f.expect.part);
    if (f.expect.class) {
      assert.equal(a.class, f.expect.class, `${f.name}: ${JSON.stringify(a)}`);
      for (const n of f.expect.notes ?? []) assert.ok(a.notes?.includes(n), `${f.name}: note '${n}' in ${JSON.stringify(a.notes)}`);
      if (f.expect.form) assert.equal(a.geometry.bridges[0].form, f.expect.form);
      if (f.expect.wet) assert.ok(a.geometry.bridges[0].wet?.cells > 0, `${f.name}: wet piers ${JSON.stringify(a.geometry.bridges[0])}`);
      continue;
    }
    assert.equal(a.class, 'refused', `${f.name}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f.name}: evidence`);
    if (f.expect.until) assert.equal(a.reasons[0].until, f.expect.until, `${f.name}: until`);
    if (f.expect.code === 'WATER') assert.equal(a.reasons[0].until, undefined, `${f.name}: WATER never carries until after H`);
    if (f.expect.kind) assert.equal(a.reasons[0].evidence.kind, f.expect.kind, `${f.name}: ${JSON.stringify(a.reasons[0].evidence)}`);
    if (f.expect.message) assert.match(a.reasons[0].message, new RegExp(f.expect.message));
    if (f.expect.depth) assert.ok(a.reasons[0].evidence.depth > 24, `${f.name}: evidence.depth ${JSON.stringify(a.reasons[0].evidence)}`);
    if (f.expect.under) assert.ok(a.reasons[0].evidence.under && a.reasons[0].evidence.under.have < a.reasons[0].evidence.under.need, `${f.name}: ${JSON.stringify(a.reasons[0].evidence)}`);
    if (f.expect.code === 'ANCHOR' && f.volume) assert.ok(a.reasons[0].evidence.found.some((c) => c.class === 'LOOSE'), `${f.name}: the classes found`);
    if (f.expect.wouldFit) {
      assert.equal(a.wouldFit?.length, 1, `${f.name}: wouldFit ${JSON.stringify(a.wouldFit)}`);
      const frag = a.wouldFit[0].fragment;
      assert.equal(frag.kind, f.expect.wouldFit, `${f.name}: ${JSON.stringify(frag)}`);
      if (f.expect.wouldForm) assert.equal(frag.form, f.expect.wouldForm);
      // re-checked alone
      const r2 = await run({ ...f, plan: { ...f.plan, connectors: [frag] } });
      assert.equal(part(r2, frag.id).class, 'fits', `${f.name}: the wouldFit alone ${JSON.stringify(part(r2, frag.id))}`);
    }
  }
});

test('a bridge landing at a K1 gate: the gate move ends outside the wall, the span starts there; `lands` names the gate (S-T3-8)', async () => {
  // a wall along the lip of a 20-wide ravine (z 2036..2055), a bridge from inside the wall across it
  const terrain = { W: 160, D: 96, x0: 1000, z0: 2000, bands: [{ x0: 1000, z0: 2036, x1: 1159, z1: 2055, y: 52 }] };
  const plan = { schemaVersion: 'plan/0', connectors: [
    { id: 'lip_wall', kind: 'wall', from: { anchor: 'w_w' }, to: { anchor: 'w_e' }, height: 4 },
    { id: 'over', kind: 'bridge', from: { anchor: 'a' }, to: { anchor: 'b' }, width: 3 },
  ] };
  const r = await run({ terrain, plan, anchors: { w_w: [1004, 65, 2032], w_e: [1155, 65, 2032], a: [1080, 65, 2022], b: [1080, 65, 2066] } });
  const a = part(r, 'over'), w = part(r, 'lip_wall');
  assert.ok(['fits', 'adjusted'].includes(w.class), JSON.stringify(w));
  assert.ok(['fits', 'adjusted'].includes(a.class), JSON.stringify(a));
  const b = a.geometry.bridges[0];
  assert.ok(b && typeof b.crossing.lands === 'string', `the crossing names its gate: ${JSON.stringify(b)}`);
  // the deck and rails never over a wall cell
  const wallCells = new Set((r.res.meta.walls ?? []).flatMap((x) => x.cells.map((c) => `${c[0]},${c[1]}`)));
  for (const c of r.res.meta.bridges[0].cells) assert.ok(!wallCells.has(`${c[0]},${c[2]}`), `deck over the wall at ${c}`);
});

/** Steward's recorded plans (fixtures/plan/asks) on the asks claim. */
const asksPlan = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks', `${name}.json`), 'utf8')).answer.plan;
const A = asksSurvey();
const asks = (plan) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });

test('§9: end_city_ruins\' dwelling bridges are a self-loop (NO_GAP); redstone_gate\'s drawbridge is unsupported {connector.drawbridge}', async () => {
  const ec = await asks(asksPlan('end_city_ruins'));
  const d = part(ec, 'dwelling_bridges');
  assert.equal(d.class, 'refused');
  assert.equal(d.reasons[0].code, 'NO_GAP');
  assert.match(d.reasons[0].message, /one place/);
  const rg = await asks(asksPlan('redstone_gate'));
  const db = part(rg, 'drawbridge');
  assert.equal(db.class, 'unsupported');
  assert.equal(db.block, 'connector.drawbridge');
  assert.equal(db.reasons[0].until, 'mechanism');
});

test('§9: the gap tables (committed before and after); no recorded part changes class but the bridge and tunnel parts', async () => {
  // (6c T3 batch) the combined table after both halves (fixtures/plan/t3); the slices' own tables (t3a/, t3b/) stay as records
  const after = fs.readFileSync(path.join(FIX, 't3', 'asks-gap-after-t3.txt'), 'utf8');
  const before = fs.readFileSync(path.join(FIX, 't3a', 'asks-gap-before.txt'), 'utf8');
  assert.match(before, /connector\.bridge\s+2/);
  assert.match(before, /connector\.tunnel\s+4/);
  assert.doesNotMatch(after.split('parts whose answer changed')[0], /connector\.bridge\s+\d/);
  assert.match(after, /connector\.drawbridge\s+1/);
  assert.match(after.split('parts whose answer changed')[0], /tunnel\.under\s+3\n/);
  assert.doesNotMatch(after.split('parts whose answer changed')[0], /connector\.tunnel\s+\d/);
  assert.match(after, /underwater_domes\/glass_tunnels: .* -> blocked DEPENDENCY/);
  // the changed parts are exactly the six recorded bridge and tunnel parts; no street, road or path refused WATER (until T3) before
  const changed = after.split('\n').filter((l) => /^ {2}\S+\/\S+: /.test(l)).map((l) => l.trim().split(':')[0]).sort();
  assert.deepEqual(changed, ['end_city_ruins/dwelling_bridges', 'redstone_gate/drawbridge', 'secret_tunnels/tunnel_cellar', 'secret_tunnels/tunnel_dock', 'secret_tunnels/tunnel_hatch', 'underwater_domes/glass_tunnels']);
  assert.match(after, /WATER \(until T3\) before \(0\): none/);
  // and the table is today's: the gap per block over the 59 asks
  const dir = path.join(FIX, 'asks');
  const gaps = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json')) {
    const r = await asks(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).answer.plan);
    for (const a of r.check.parts) if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
  }
  for (const [block, n] of Object.entries(gaps)) assert.match(after, new RegExp(`${block.replace('.', '\\.')}\\s+${n}\\n`), `${block} ${n}`);
  assert.equal(gaps['connector.bridge'], undefined);
  assert.equal(gaps['connector.tunnel'], undefined);
  assert.equal(gaps['tunnel.under'], 3);
});

test('determinism: 3 checks of v35, v36, v39 and each refusal fixture give identical answers, IR and artifact shas', async () => {
  for (const f of [...read('valid', /^v3[56]_/), ...read('t3a', /^(v39|r0[1-6])/)]) {
    const runs = [await run(f), await run(f), await run(f)];
    const key = (r) => JSON.stringify(r.check.parts);
    assert.equal(key(runs[1]), key(runs[0]), `${f.name}: answers 2`);
    assert.equal(key(runs[2]), key(runs[0]), `${f.name}: answers 3`);
    assert.equal(runs[1].artifactSha, runs[0].artifactSha, `${f.name}: artifact 2`);
    assert.equal(runs[2].res.irSha, runs[0].res.irSha, `${f.name}: IR 3`);
  }
});
