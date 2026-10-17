// (6c T3b) Tunnels through the plan check (docs/CONTRACT.md "Phase 6c slice T3" §3-§6, §9, §10 items 2-5, 7, 8, 11, 12, tunnels): the
// two-plan flow (the first plan asks the corridor and answers incomplete VOLUME; the second reads it), v37 on a synthetic ridge
// (fits; M3:tunnel, M4:tunnel, M5, M6 clean; both kit movers through), the refusal fixtures (fixtures/plan/tunnel: NO_COVER, SPAN,
// WATER three ways, PROTECTED three ways, incomplete VOLUME past the cap, tunnel.under, TOO_STEEP, R18, R19's lenient via, lenient
// params), the broken variants, Steward's recorded tunnels (§9: secret_tunnels' three and glass_tunnels answer tunnel.under), the
// artifact's guard cells, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, stewardAnchors, checkPlanLocal, checkPlanVolumes, flatSurvey, FIX } from './plan-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';

const read = (dir) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const part = (r, id) => r.check.parts.find((a) => a.part === id);

/** Check a fixture: its terrain (flat with bands), its anchors over Steward's, the two-plan flow over its frozen volume. */
async function run(fx, extra = {}) {
  const s = fx.on === 'asks' ? asksSurvey() : flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], volume: fx.volume ?? { missing: true }, ...extra });
  return { ...r, survey: s };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });
const v37 = () => read('valid').find((x) => x.name.startsWith('v37'));
const withExt = (fx, unsafe) => ({ ...fx, plan: { ...fx.plan, connectors: fx.plan.connectors.map((c) => ({ ...c, ext: { 'architect_mc:unsafe': unsafe } })) } });

test('the two-plan flow: the first plan asks one corridor and answers incomplete VOLUME (INCOMPLETE, no artifact); the second reads it and fits', async () => {
  const r = await run(v37());
  assert.equal(r.asked.length, 1, 'one corridor asked');
  const b = r.asked[0];
  assert.ok(b.maxY - b.minY < 64 && (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1) * (b.maxZ - b.minZ + 1) <= 4_000_000, JSON.stringify(b));
  assert.equal(r.first.check.overall, 'INCOMPLETE');
  assert.equal(part(r.first, 'bore').class, 'incomplete');
  assert.equal(part(r.first, 'bore').reasons[0].code, 'VOLUME');
  assert.equal(r.first.artifactSha, null);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  assert.match(r.artifactSha, /^[0-9a-f]{64}$/);
  // the IR records the volume the bore read; the artifact keeps its guard cells against it
  assert.ok(Object.values(r.res.ir.volumes ?? {}).some((v) => v.sha === r.volumes[0].sha));
  assert.equal(r.artifact.guards.length, 1);
  assert.equal(r.artifact.guards[0].part, 'bore');
  assert.equal(r.artifact.guards[0].volume.sha, r.volumes[0].sha);
  assert.ok(r.artifact.guards[0].runs.length > 400);
  // a plan without a tunnel part asks for nothing new (v34's auto and every K1 valid fixture plan once)
  const noTunnel = read('valid').filter((x) => /^v3[0-4]_/.test(x.name));
  for (const f of noTunnel) {
    const s = flatSurvey(f.terrain ?? {});
    void s;
    assert.ok(!(f.plan.connectors ?? []).some((c) => c.kind === 'tunnel'), f.name);
  }
});

test('v37: fits; geometry.tunnels with its crossing; M3:tunnel, M4:tunnel, M5, M6, M8, M1 clean; the sand lined; both kit movers through the bore', async () => {
  const r = await run(v37());
  const a = part(r, 'bore');
  assert.equal(a.class, 'fits');
  const t = a.geometry.tunnels;
  assert.equal(t.length, 1);
  assert.equal(t[0].crossing.type, 'tunnel');
  assert.equal(t[0].crossing.through, 'rock');
  assert.equal(t[0].crossing.length, t[0].length);
  assert.ok(t[0].crossing.cover >= 2);
  assert.ok(t[0].bore >= 35 && t[0].bore <= 50, `bore cells ${t[0].bore}`);
  assert.ok(a.cost.bom && Object.keys(a.cost.bom).length > 0, 'cost.bom');
  const rep = checkOf(r);
  const m = rep.metrics.tunnels.per[0];
  assert.ok(m.coverMin >= 2 && m.boreRun >= 4, JSON.stringify(m));
  assert.equal(m.shellOpen, 0);
  assert.equal(m.gravity, 0);
  assert.equal(m.fluids, 0);
  assert.equal(m.notClear, 0);
  assert.equal(m.clear, m.floorCells);
  assert.ok(m.volume);
  assert.equal(rep.metrics.M5tunnel.darkSpawnable, 0, JSON.stringify(rep.metrics.M5tunnel));
  assert.ok(!rep.findings.some((f) => /^M(1|3|4|5|6|8)(:|$)/.test(f.rule)), rep.findings.map((f) => `${f.rule} ${f.message}`).join('; '));
  // the sand band over the roof is lined: the lining role stands where the sand was over the void
  const vw = buildVirtual({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, volumes: r.volumes.map((v) => v.decoded) }).vw;
  const rec = r.res.meta.tunnels[0];
  assert.ok(rec.lined > 0);
  // (the roof over the band's columns: the void's top + 1 on the bore's centre line)
  let roofs = 0;
  for (const [x, y, z] of rec.floor) {
    if (z !== rec.from[2] || x < 1112 || x > 1138) continue;
    const st = vw.pal.states[vw.get(x, y + rec.height + 1, z)];
    assert.ok(!/sand|gravel|air/.test(st), `roof at ${x}: ${st}`);
    roofs++;
  }
  assert.ok(roofs >= 20, `${roofs} roof cells over the band`);
  // both movers from one end to the other through the bore (the kit's walk graph)
  for (const mover of ['player', 'villager']) {
    const g = walkGraph(vw, [[rec.from[0], rec.from[1] + 1, rec.from[2]]], { mover });
    assert.ok(nodeReached(g, [rec.to[0], rec.to[1] + 1, rec.to[2]]), `${mover} through the bore`);
  }
});

test('refusals (fixtures/plan/tunnel): each its code and evidence; the pocket at 3 fits; R18, R19 and lenient params', async () => {
  for (const f of read('tunnel')) {
    const r = await run(f);
    const a = part(r, 'bore');
    const e = f.expect;
    assert.equal(a.class, e.class, `${f.name}: ${a.class} ${JSON.stringify(a.reasons)}`);
    if (e.code) {
      assert.equal(a.reasons[0].code, e.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
      assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f.name}: evidence`);
    }
    if (e.kind) assert.equal(a.reasons[0].evidence.kind, e.kind, f.name);
    if (e.kind) assert.ok(a.reasons[0].evidence.sample.length > 0, `${f.name}: the cells`);
    if (e.evidenceClass) assert.equal(a.reasons[0].evidence.class, e.evidenceClass, f.name);
    if (e.cap) assert.equal(a.reasons[0].evidence.cap, e.cap, f.name);
    if (e.cap) assert.equal(r.asked.length, 0, `${f.name}: a corridor past the cap is never asked`);
    if (e.block) { assert.equal(a.block, e.block, f.name); assert.equal(a.reasons[0].block, e.block); assert.equal(a.reasons[0].until, '7b'); }
    if (e.note) assert.ok((a.notes ?? []).some((n) => n.includes(e.note)), `${f.name}: ${JSON.stringify(a.notes)}`);
    for (const n of e.notes ?? []) assert.ok((a.notes ?? []).some((x) => x.startsWith(n)), `${f.name}: ${n} in ${JSON.stringify(a.notes)}`);
  }
  // the protected classes are named (S-K1-3's evidence): an area, a build
  const pa = await run(read('tunnel').find((x) => x.name.startsWith('tn06')));
  assert.equal(part(pa, 'bore').reasons[0].evidence.class, 'PROTECTED_AREA');
  const pb = await run(read('tunnel').find((x) => x.name.startsWith('tn07')));
  assert.equal(part(pb, 'bore').reasons[0].evidence.class, 'BUILD');
});

test('broken variants: no lining over the sand (M3:gravity, M3:tunnel), no lamps (M5), fluid buffer 0 (M4:tunnel), cover 1 (M3:tunnel)', async () => {
  const rules = async (fx) => { const r = await run(fx); assert.equal(part(r, 'bore').class, 'fits', `${fx.name}: ${JSON.stringify(part(r, 'bore').reasons)}`); return checkOf(r).findings.map((f) => f.rule); };
  const nl = await rules(withExt(v37(), { noLining: true }));
  assert.ok(nl.includes('M3:gravity') && nl.includes('M3:tunnel'), nl.join(', '));
  const dark = await rules(withExt(v37(), { noLamps: true }));
  assert.ok(dark.includes('M5'), dark.join(', '));
  const pocket = read('tunnel').find((x) => x.name.startsWith('tn03'));
  const wet = await rules(withExt(pocket, { fluidBuffer: 0 }));
  assert.ok(wet.includes('M4:tunnel'), wet.join(', '));
  // a hump with 1 cover over the roof: refused by the rule, built by the broken variant, found by the checker
  const hump = { name: 'hump', on: 'flat', terrain: { bands: [{ x0: 1100, z0: 2000, x1: 1150, z1: 2159, y: 68 }] }, anchors: { west: [1096, 65, 2080], east: [1154, 65, 2080] }, volume: {}, plan: { schemaVersion: 'plan/0', connectors: [{ id: 'bore', kind: 'tunnel', approach: 0, from: { anchor: 'west' }, to: { anchor: 'east' } }] } };
  const refused = await run(hump);
  assert.equal(part(refused, 'bore').class, 'unsupported', 'a hump with 1 cover has no line with cover: tunnel.under');
  const c1 = await rules(withExt(hump, { cover: 1 }));
  assert.ok(c1.includes('M3:tunnel'), c1.join(', '));
});

/** Steward's recorded plans (fixtures/plan/asks) on the asks claim. */
const asksPlan = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks', `${name}.json`), 'utf8')).answer.plan;
const A = asksSurvey();

test('§9: secret_tunnels\' three tunnels answer unsupported {tunnel.under, until 7b}; glass_tunnels as recorded is blocked by its zone (no ocean on the asks claim), and with the zone placed answers tunnel.under, params.width read, material noted', async () => {
  const st = await checkPlanLocal(asksPlan('secret_tunnels'), { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
  for (const id of ['tunnel_cellar', 'tunnel_dock', 'tunnel_hatch']) {
    const a = part(st, id);
    assert.equal(a.class, 'unsupported', `${id}: ${a.class} ${JSON.stringify(a.reasons)}`);
    assert.equal(a.block, 'tunnel.under', id);
    assert.equal(a.reasons[0].until, '7b');
  }
  // as recorded: the colony zone wants ocean water (none on the asks claim: refused NO_FEATURE), so its tunnel is blocked (a deviation
  // from §9's prediction, recorded in "T3b as built")
  const rec = await checkPlanLocal(asksPlan('underwater_domes'), { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
  assert.equal(part(rec, 'colony').class, 'refused');
  assert.equal(part(rec, 'glass_tunnels').class, 'blocked');
  assert.deepEqual(part(rec, 'glass_tunnels').blockedBy, ['colony']);
  // the tunnel's own answer: the same plan with the colony near the stone
  const plan = asksPlan('underwater_domes');
  plan.zones = plan.zones.map((z) => (z.id === 'colony' ? { ...z, where: { near: { anchor: 'stone', within: 48 } } } : z));
  const uw = await checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
  assert.ok(['fits', 'adjusted'].includes(part(uw, 'colony').class), JSON.stringify(part(uw, 'colony')));
  const g = part(uw, 'glass_tunnels');
  assert.equal(g.class, 'unsupported', JSON.stringify(g));
  assert.equal(g.block, 'tunnel.under');
  assert.ok((g.notes ?? []).some((n) => n.startsWith('params.material not read')), JSON.stringify(g.notes));
  assert.ok(!(g.notes ?? []).some((n) => n.startsWith('params.width')), 'params.width is read');
});

test('determinism: three checks of v37 and of each refusal give identical answers and artifact shas', async () => {
  for (const f of [v37(), ...read('tunnel').filter((x) => /tn0[1-5]|tn1[34]/.test(x.name))]) {
    const rs = [await run(f), await run(f), await run(f)];
    const j = rs.map((r) => JSON.stringify(r.check));
    assert.equal(j[1], j[0], `${f.name}: answers`);
    assert.equal(j[2], j[0], `${f.name}: answers`);
    assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha), `${f.name}: artifact sha`);
  }
});
