// (7a RK) Rock stairs (docs/CONTRACT.md "Phase 7a slice RK" §2-§8, items 1, 2's kit half, 5's plan half, 7b, 10): the flight profile
// (landings every 8, built from the lower end), cut and bore per tread, the tread rule, the two-plan flow over v7a_rk_ridge (fits: the
// crossing, the graph edge, the guards named rock_stair, the BOM, the siteplan row; M3:tunnel, M3:gravity, M4:tunnel, M5, M6 and
// M10:rock_stair clean; both kit movers both ways), a flight routed down, a 1-wide one, every refusal with its evidence (NO_CLIMB,
// SPAN 49, ANCHOR over a ravine, WATER at 2 and a fit at 3, PROTECTED under a build, incomplete VOLUME past the cap and unread), the KC
// row (WATER {kind: body}; at 3 it fits, M25:clear 0), the broken variants caught (M3:gravity, M5), the catalogue flip, determinism,
// rockstairs_demo flat and natural, and Noah's look (joined parapets on something, every block themed in three bibles).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPlanVolumes, flatSurvey, stewardAnchors, fixtureVolume, FIX, ROOT } from './plan-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { ROCK, flightLength, flightProfile, landingsOf, lampReach, rockStairGeom } from '../lib/connectors/rockStairGeom.mjs';
import { tunnelLand } from '../lib/connectors/tunnelGeom.mjs';
import { joins, splitState } from '../lib/connectors/climbGeom.mjs';
import { BLOCKS, isCube } from '../lib/blocks.mjs';

const read = (dir, re = /./) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && re.test(f)).sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const ridge = () => read('valid', /^v7a_rk_ridge/)[0];
const part = (r, id) => r.check.parts.find((a) => a.part === id);
async function run(fx, extra = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], volume: fx.volume ?? { missing: true }, ...extra });
  return { ...r, survey: s };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });
const worldOf = (r) => buildVirtual({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded) }).vw;

test('§2 the profile: steps of 1 a cell, 2 flat cells after every 8 steps while steps remain, built from the lower end', () => {
  assert.deepEqual([2, 8, 9, 16, 17, 20, 48].map((n) => [n, landingsOf(n), flightLength(n)]), [[2, 0, 2], [8, 0, 8], [9, 1, 11], [16, 1, 18], [17, 2, 21], [20, 2, 24], [48, 5, 58]]);
  const up = flightProfile(64, 20);
  assert.equal(up.L, 24);
  assert.deepEqual(up.ys.slice(0, 12), [64, 65, 66, 67, 68, 69, 70, 71, 72, 72, 72, 73]);
  assert.equal(up.ys[24], 84);
  assert.equal(up.ys[25], 84);
  assert.deepEqual(up.kinds.slice(1).map((k) => (k === 'landing' ? 'L' : 's')).join(''), 'ssssssssLLssssssssLLssss');
  // the same flight routed down (from the top walk cell) writes the same treads
  const down = flightProfile(84, -20);
  for (let i = 1; i <= 24; i++) { assert.equal(down.ys[i], up.ys[25 - i]); assert.equal(down.kinds[i], up.kinds[25 - i]); }
  // a landing every `landing` steps (4..12)
  assert.deepEqual(flightProfile(0, 10, 4).kinds.slice(1).map((k) => (k === 'landing' ? 'L' : 's')).join(''), 'ssssLLssssLLss');
  // the lamps' reach: every tread within it of a lamp is lit (a 2-wide, 3-high flight: 5 treads either side)
  assert.equal(lampReach(15, 2, 3), 5);
  assert.equal(ROCK.cost + ROCK.costStep * 20 + ROCK.costLanding * 4, 1320);
});

/** A land over a flat survey with a ridge (v7a_rk_ridge's) and a full-claim volume (fixtureVolume's classes). */
async function ridgeLand(edits = []) {
  const fx = ridge();
  const s = flatSurvey(fx.terrain);
  const box = { minX: 1060, minY: 40, minZ: 2040, maxX: 1160, maxY: 100, maxZ: 2120 };
  const v = await fixtureVolume(box, { edits: [...fx.volume.edits, ...edits] }, s.bytes, s.claim);
  const { surveyApi } = await import('../lib/region/survey.mjs');
  const { VOXEL_CLASSES, classAt } = await import('../lib/region/volume.mjs');
  return tunnelLand(surveyApi(s.bytes, s.claim), { volumes: [v.decoded], classOfVolume: (q, x, y, z) => VOXEL_CLASSES[classAt(q, x, y, z)] });
}

test('§2 the geometry: flush on the slope, bored under the cliff, cut near the top; the tread rule; the fill of 1; the shell lined; the sand lined; lamps on every landing', async () => {
  const land = await ridgeLand();
  const g = rockStairGeom(land, [1094, 64, 2080], [1, 0], 20, { width: 2 });
  assert.ok(g.ok, JSON.stringify(g.evidence));
  assert.equal(g.length, 24);
  const b = g.bore.slice(1).map((x) => (x ? 1 : 0)).join('');
  assert.match(b, /^0+1{6,}0+$/, `cut, then bored, then cut: ${b}`);
  assert.ok(g.cover.slice(1).filter((c, i) => g.bore[i + 1]).every((c) => c >= 2));
  // every tread on site-solid ground (no fill needed here) and facing up the flight (east)
  assert.equal(g.floor.filter((c) => c[3] === 'bed').length, 0);
  assert.equal(g.facing, 'east');
  // the sand band over the bored roofs is lined (gravity) and every lamp's tread lit by the rule: one at each landing
  assert.ok(g.lined.some((c) => c[3] === 'gravity'), 'the sand over the roof lined');
  for (let i = 1; i <= g.length; i++) if (g.kinds[i] === 'landing' && g.kinds[i - 1] !== 'landing') assert.ok(g.lamps.some((l) => l[4] === i), `a lamp at the landing ${i}`);
  // portals at both ends of the bore run, arched (height 3)
  assert.equal(g.portals.length, 2);
  assert.ok(g.portals.every((p) => p.cells.some((c) => c[3] === 'arch')));
  // the same flight routed down writes the same cells
  const d = rockStairGeom(land, [1119, 84, 2080], [-1, 0], -20, { width: 2 });
  assert.ok(d.ok);
  const key = (c) => c.slice(0, 3).join(',');
  assert.deepEqual(new Set(d.floor.map(key)), new Set(g.floor.map(key)));
  assert.deepEqual(new Set(d.voids.map(key)), new Set(g.voids.map(key)));
  assert.equal(d.facing, 'east', 'the treads face up the flight either way');
  // the tread rule: a tread over air deeper than 1 is ANCHOR {why: tread}; 1 cell over the ground is a fill (a bed of lining)
  const a = rockStairGeom(land, [1080, 64, 2080], [1, 0], 20, { width: 2 });
  assert.equal(a.code, 'ANCHOR');
  assert.equal(a.evidence.why, 'tread');
  const f = rockStairGeom(land, [1092, 64, 2080], [1, 0], 20, { width: 2 });
  assert.ok(f.ok && f.floor.some((c) => c[3] === 'bed'), `a tread 1 over the ground stands on a bed of lining: ${JSON.stringify(f.evidence ?? null)}`);
  assert.equal(rockStairGeom(land, [1092, 64, 2080], [1, 0], 20, { width: 2, _unsafe: { noFill: true } }).code, 'ANCHOR', 'without the fill it is ANCHOR');
  // NO_CLIMB and SPAN in §4's order
  assert.equal(rockStairGeom(land, [1094, 64, 2080], [1, 0], 1, {}).code, 'NO_CLIMB');
  assert.equal(rockStairGeom(land, [1094, 64, 2080], [1, 0], 49, {}).code, 'SPAN');
  assert.equal(rockStairGeom(land, [1094, 64, 2080], [1, 0], 20, { rise: { max: 12 } }).code, 'SPAN');
});

test('v7a_rk_ridge: the two-plan flow; fits; the crossing, the graph edge, the guards (connector rock_stair), the BOM, the siteplan row; the checker clean; both kit movers both ways', async () => {
  const r = await run(ridge());
  assert.equal(r.asked.length, 1, 'one corridor asked');
  assert.equal(r.first.check.overall, 'INCOMPLETE');
  assert.equal(part(r.first, 'flight').reasons[0].code, 'VOLUME');
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  const a = part(r, 'flight');
  assert.equal(a.class, 'fits');
  const rs = a.geometry.rockStairs;
  assert.equal(rs.length, 1);
  assert.equal(rs[0].crossing.type, 'rock_stair');
  assert.ok(rs[0].crossing.rise >= 2 && rs[0].crossing.steps === Math.abs(rs[0].crossing.rise));
  assert.ok(rs[0].crossing.cover >= 2, 'a bored part');
  assert.ok(rs[0].bore >= 4 && rs[0].cut >= 4, `part cut and part bored: ${rs[0].bore} bored, ${rs[0].cut} cut`);
  assert.ok(a.notes.some((n) => /read 1 frozen volume/.test(n)));
  // the graph edge typed rock_stair with its crossing
  const ge = r.res.ir.graph.edges.find((e) => e.type === 'rock_stair');
  assert.ok(ge && ge.crossing.type === 'rock_stair', JSON.stringify(r.res.ir.graph.edges.map((e) => e.type)));
  // the artifact's guards: one, named rock_stair, against the volume read
  assert.equal(r.artifact.guards.length, 1);
  assert.equal(r.artifact.guards[0].connector, 'rock_stair');
  assert.equal(r.artifact.guards[0].volume.sha, r.volumes[0].sha);
  assert.ok(r.artifact.guards[0].runs.length > 400);
  // the BOM: the stairs, the lining, the portal and the lamps, exactly the emitted cells' items
  const bom = a.cost.bom;
  assert.ok(Object.keys(bom).some((k) => /_stairs$/.test(k)) && Object.keys(bom).some((k) => /lantern/.test(k)), JSON.stringify(bom));
  const rec = r.res.meta.rockStairs[0];
  for (const [k, n] of Object.entries(rec.bom)) assert.ok(bom[k] >= n, `${k}: ${bom[k]} >= ${n}`);
  // the siteplan row
  const { siteplanOf } = await import('../lib/region/siteplan.mjs').catch(() => ({}));
  if (siteplanOf) { const sp = siteplanOf({ ir: r.res.ir, meta: r.res.meta }); if (sp?.rockStairs) assert.deepEqual(Object.keys(sp.rockStairs[0]).sort(), ['carved', 'id', 'landings', 'lined', 'part', 'steps']); }
  // the checker on the virtual world
  const c = checkOf(r);
  const bad = c.findings.filter((f) => /^(M3|M4|M6|M10)/.test(f.rule) || (f.rule === 'M5' && /rock stair/.test(f.message)));
  assert.deepEqual(bad.map((f) => [f.rule, f.message]), []);
  assert.equal(c.metrics.M5rockStair.darkSpawnable, 0);
  const row = c.metrics.rockStairs.per[0];
  assert.equal(row.badRise + row.badLanding + row.unanchored + row.notClear, 0, JSON.stringify(row));
  assert.equal(row.tunnel.shellOpen, 0);
  assert.equal(row.tunnel.gravity, 0);
  // the kit movers up and down the flight
  const vw = worldOf(r);
  const foot = [rec.from[0], rec.from[1] + 1, rec.from[2]], top = [rec.to[0], rec.to[1] + 1, rec.to[2]];
  for (const m of ['player', 'villager']) {
    assert.ok(nodeReached(walkGraph(vw, [foot], { mover: m }), top), `${m} up`);
    assert.ok(nodeReached(walkGraph(vw, [top], { mover: m }), foot), `${m} down`);
  }
});

test('a flight routed down (the ends swapped) and a 1-wide villager flight: both fit, the checker clean, the movers through', async () => {
  const fx = ridge();
  const down = { ...fx, plan: { ...fx.plan, connectors: [{ ...fx.plan.connectors[0], from: { anchor: 'top' }, to: { anchor: 'foot' } }] } };
  const narrow = { ...fx, plan: { ...fx.plan, connectors: [{ ...fx.plan.connectors[0], width: 1 }] } };
  for (const [name, f] of [['down', down], ['narrow', narrow]]) {
    const r = await run(f);
    assert.equal(part(r, 'flight').class, 'fits', `${name}: ${JSON.stringify(part(r, 'flight').reasons)}`);
    const c = checkOf(r);
    assert.deepEqual(c.findings.filter((q) => /^(M3|M4|M6|M10)/.test(q.rule)).map((q) => q.message), [], name);
    assert.equal(c.metrics.M5rockStair.darkSpawnable, 0, name);
    const rec = r.res.meta.rockStairs[0];
    if (name === 'down') assert.ok(rec.rise < 0, `${name}: routed down (${rec.rise})`);
    if (name === 'narrow') assert.equal(rec.width, 1);
    const vw = worldOf(r);
    const a = [rec.from[0], rec.from[1] + 1, rec.from[2]], b = [rec.to[0], rec.to[1] + 1, rec.to[2]];
    assert.ok(nodeReached(walkGraph(vw, [a], { mover: 'villager' }), b) && nodeReached(walkGraph(vw, [b], { mover: 'villager' }), a), `${name}: the villager mover both ways`);
  }
});

test('§4 the refusals with their evidence (rk/): NO_CLIMB, SPAN 49, ANCHOR over a ravine, WATER at 2 (fits at 3), PROTECTED, incomplete VOLUME (cap, unread)', async () => {
  for (const fx of read('rk', /^r\d/)) {
    const r = await run(fx);
    const a = part(r, 'flight');
    if (fx.expect.class === 'fits') { assert.equal(a.class, 'fits', `${fx.name}: ${JSON.stringify(a.reasons)}`); continue; }
    assert.equal(a.class, fx.expect.class, `${fx.name}: ${a.class} ${JSON.stringify(a.reasons)}`);
    assert.equal(a.reasons[0].code, fx.expect.code, fx.name);
    const ev = a.reasons[0].evidence;
    if (fx.expect.why) assert.equal(ev.why, fx.expect.why, fx.name);
    if (fx.expect.kind) assert.equal(ev.kind, fx.expect.kind, fx.name);
    if (fx.expect.cap) assert.equal(ev.cap, fx.expect.cap, fx.name);
    if (fx.expect.code === 'NO_CLIMB') assert.deepEqual([ev.rise, ev.need], [0, 2]);
    if (fx.expect.code === 'SPAN') assert.deepEqual([ev.rise, ev.max], [49, 48]);
    if (fx.expect.code === 'WATER') assert.ok(ev.sample.length >= 1 && ev.buffer === 2);
    if (fx.expect.code === 'PROTECTED') assert.equal(ev.class, 'BUILD');
    // a refused flight writes nothing
    assert.ok(!(r.res?.meta?.rockStairs ?? []).length, `${fx.name}: no flight written`);
  }
});

test('7b KC: a flight within 2 of a pond\'s shell is refused WATER {kind: body}; at 3 both fit and M25:clear is 0', async () => {
  const [k1, k2] = read('rk', /^k0[12]/);
  const r1 = await run(k1);
  const a1 = part(r1, 'flight');
  assert.equal(a1.class, 'refused');
  assert.equal(a1.reasons[0].code, 'WATER');
  assert.equal(a1.reasons[0].evidence.kind, 'body');
  const r2 = await run(k2);
  assert.equal(part(r2, 'flight').class, 'fits', JSON.stringify(part(r2, 'flight').reasons));
  assert.equal(part(r2, 'pool').class, 'fits');
  const c = checkOf(r2);
  assert.equal(c.findings.filter((f) => f.rule === 'M25:clear').length, 0, JSON.stringify(c.findings.filter((f) => /^M25/.test(f.rule))));
});

test('the broken variants: the lining off (M3:gravity: the sand over the roof falls) and the lamps off (M5: dark treads) are caught', async () => {
  const [u1, u2] = read('rk', /^u0[12]/);
  const c1 = checkOf(await run(u1));
  assert.ok(c1.findings.some((f) => f.rule === 'M3:gravity'), JSON.stringify(c1.findings.map((f) => f.rule)));
  const c2 = checkOf(await run(u2));
  assert.ok(c2.metrics.M5rockStair.darkSpawnable > 0);
  assert.ok(c2.findings.some((f) => f.rule === 'M5' && /rock stair/.test(f.message)));
});

test('item 10: the catalogue flip (connector.rock_stair reserved -> supported, limits.volume), e15 off it; three checks identical (determinism)', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const e = golden.entries.find((x) => x.id === 'connector.rock_stair');
  assert.equal(e.state, 'supported');
  assert.equal(e.limits.volume, true);
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi));
  const pre = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7a.json'), 'utf8'));
  const d = diffCatalogues(pre, golden, {});
  assert.ok(d.reservedToSupported.includes('connector.rock_stair') || d.reservedToSupported.some((x) => x.id === 'connector.rock_stair'));
  const e15 = JSON.parse(fs.readFileSync(path.join(FIX, 'extension', 'e15_every_reserved_a.json'), 'utf8'));
  assert.ok(!JSON.stringify(e15.plan).includes('rock_stair'));
  const shas = [];
  for (let k = 0; k < 3; k++) { const r = await run(ridge()); shas.push(`${r.artifactSha} ${r.volumes[0].sha}`); }
  assert.equal(new Set(shas).size, 1, shas.join(' / '));
});

/** Noah's look: every fence or wall the flights wrote joins its neighbours and stands on something. */
function connectableFaults(ir, vw) {
  const parts = new Set((ir.parts ?? []).map((q, i) => (/^links/.test(q.id) ? i : -1)).filter((i) => i >= 0));
  const st = (x, y, z) => { const s = vw.pal.states[vw.get(x, y, z)]; return s && !/^minecraft:(cave_|void_)?air$/.test(splitState(s).name) ? splitState(s) : null; };
  const bad = { sides: [], floating: [], n: 0 };
  vw.eachWritten((x, y, z, idx, f, p) => {
    if (!parts.has(p)) return;
    const s = splitState(vw.pal.states[idx]), fam = BLOCKS[s.name]?.family;
    if (fam !== 'fence' && fam !== 'wall' && fam !== 'pane') return;
    bad.n++;
    let joinedCube = false;
    for (const [d, [dx, dz]] of Object.entries({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] })) {
      const n = st(x + dx, y, z + dz), want = joins(fam, n, d), got = fam === 'wall' ? s.props[d] !== 'none' : s.props[d] === 'true';
      if (want !== got) bad.sides.push([x, y, z, d, s.name, n?.name ?? 'air']);
      if (want && n && isCube(n)) joinedCube = true;
    }
    const below = st(x, y - 1, z);
    const holds = (b) => b && (isCube(b) || ['slab', 'stairs', 'fence', 'wall'].includes(BLOCKS[b.name]?.family));
    if (!holds(below) && !joinedCube) bad.floating.push([x, y, z, s.name]);
  });
  return bad;
}

/** rockstairs_demo flat over a flat survey, the two-plan flow (its corridor's volume built by fixtureVolume). */
async function demoFlat(bib = {}) {
  const s = flatSurvey({ W: 240, D: 128 });
  const o = { programFile: path.join(ROOT, 'kit', 'regions', 'rockstairs_demo.mjs'), survey: s.bytes, claim: s.claim, seed: '1', params: { variant: 'flat' }, roles: bib.roles ?? {}, connectors: bib.connectors ?? undefined };
  const first = await planRegion(o);
  const volumes = [];
  for (const b of first.needVolumes ?? []) volumes.push(await fixtureVolume(b, {}, s.bytes, s.claim));
  const p = await planRegion({ ...o, volumes });
  return { p, s, volumes };
}

test('rockstairs_demo flat: the ridge (cut, bored, cut) and the carved slope (cut the whole way); the checker clean; parapets joined and on something; every block themed in three bibles', async () => {
  const { themeOffenders } = await import('../lib/lint/theme.mjs');
  const seen = {};
  for (const b of [null, 'g7ak1_coastal', 'g7ak1_infernal']) {
    const bib = b ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${b}.json`), 'utf8')) : {};
    const { p, s, volumes } = await demoFlat(bib);
    const tag = b ?? 'default';
    const fl = p.meta.rockStairs ?? [];
    assert.equal(fl.length, 2, `${tag}: two flights (${p.notes.slice(-1)})`);
    const [rid, carv] = [fl.find((q) => /ridge/.test(q.id)), fl.find((q) => /carved/.test(q.id))];
    assert.ok(rid.bore.some(Boolean) && rid.bore.some((x) => !x), `${tag}: the ridge flight part cut and part bored`);
    assert.ok(carv.bore.every((x) => !x), `${tag}: the carved flight cut the whole way`);
    const c = checkRegion({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs.get(sha) ?? null, meta: p.meta, volumes: volumes.map((v) => v.decoded) });
    assert.deepEqual(c.findings.filter((f) => /^(M3|M4|M6|M10)/.test(f.rule)).map((f) => f.message), [], tag);
    assert.equal(c.metrics.M5rockStair.darkSpawnable, 0, tag);
    const { vw } = buildVirtual({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs.get(sha) ?? null, volumes: volumes.map((v) => v.decoded) });
    assert.deepEqual(themeOffenders(p.ir, vw).offenders, [], `${tag}: unthemed blocks`);
    const bad = connectableFaults(p.ir, vw);
    assert.ok(bad.n > 10, `${tag}: parapets checked: ${bad.n}`);
    assert.deepEqual(bad.sides, [], `${tag}: parapet sides that disagree with their neighbours`);
    assert.deepEqual(bad.floating, [], `${tag}: parapets on nothing`);
    seen[tag] = [...new Set(fl.map((q) => q.tread.replace(/\[.*$/, '')))].join(',');
  }
  assert.equal(new Set(Object.values(seen)).size, 3, `three bibles, three tread blocks: ${JSON.stringify(seen)}`);
});

test('rockstairs_demo natural (the pinned hill\'s survey, a volume of its classes): a flight found by the survey and passed by the rock; the checker clean', async () => {
  const dir = path.join(ROOT, 'kit', 'test', 'fixtures', 'lint', 'tunnel_hill');
  const survey = fs.readFileSync(path.join(dir, 'survey.bin'));
  const c0 = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8')).claim;
  const claim = { minX: c0.minX, minZ: c0.minZ, maxX: c0.maxX, maxZ: c0.maxZ, minY: -64, maxY: 319 };
  const o = { programFile: path.join(ROOT, 'kit', 'regions', 'rockstairs_demo.mjs'), survey, claim, seed: '1', params: { variant: 'natural' } };
  const first = await planRegion(o);
  assert.equal((first.needVolumes ?? []).length, 1, 'the claim\'s rock asked');
  const volumes = [await fixtureVolume(first.needVolumes[0], {}, survey, claim)];
  const p = await planRegion({ ...o, volumes });
  assert.equal((p.meta.rockStairs ?? []).length, 1, p.notes.slice(-1).join(' '));
  const c = checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha) ?? null, meta: p.meta, volumes: volumes.map((v) => v.decoded) });
  assert.deepEqual(c.findings.filter((f) => /^(M3|M4|M6|M10)/.test(f.rule) && f.part && /rock/.test(f.part)).map((f) => f.message), []);
  assert.equal(c.metrics.M5rockStair.darkSpawnable, 0);
});
