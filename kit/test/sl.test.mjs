// (7b SL, docs/CONTRACT.md "Phase 7b" slice SL and "Slice SL as built") Site lots: r.siteLot (the site wire, the frame, the volume
// read or cut, keep cells, default ports), the reserved box and the host exemption (the region checker's M1), layout.elevated in the
// plan compiler (fits, adjusted, refused, the first plan's incomplete VOLUME, connectors to site lots until LP), the artifact's
// lots[].site and .affordance, and the catalogue flip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { region } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns, encodeColumns, sha256Hex } from '../lib/region/pack.mjs';
import { decodeArvx, classAt, VC } from '../lib/region/volume.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { cropVolume, defaultPorts, FRONT_OF_ROTATION } from '../lib/region/siteLots.mjs';
import { siteSpecProblems } from '../lib/siteSpec.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { read, run } from './plan-p0-shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(HERE, 'fixtures', 'site');
const fixture = (id) => {
  const bytes = fs.readFileSync(path.join(FIX, id, 'volume.bin'));
  return { site: JSON.parse(fs.readFileSync(path.join(FIX, id, 'site.json'), 'utf8')), bytes, vol: decodeArvx(bytes) };
};

/** A plan over a fixture's volume: the survey flat at the volume's floor + 8, the claim the volume's box; `body(r, affordances)`. */
async function planOver(id, body, { volumes = true } = {}) {
  const { vol: v, bytes } = fixture(id);
  const b = v.box;
  const c = makeColumns(b.minX, b.minZ, v.width, v.depth, 1);
  for (let n = 0; n < v.width * v.depth; n++) { c.ground[n] = b.minY + 7; c.height[n] = b.minY + 7; c.floor[n] = b.minY + 7; }
  const claim = { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, minY: b.minY, maxY: b.maxY };
  let out;
  const program = { id: 'sl_t', default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'lots']);
    out = body(r, r.affordances(b));
    r.anchor('entrance', [b.minX + 1, b.minY + 8, b.minZ + 1]);
    r.anchor('spawn', [b.minX + 1, b.minY + 8, b.minZ + 1]);
    return r;
  } };
  const survey = encodeColumns(c);
  const res = await planRegion({ program, programSource: 'sl_t', survey, claim, seed: '1', roles: {}, ...(volumes ? { volumes: [{ sha: v.sha, box: v.box, bytes, decoded: v }] } : {}) });
  return { res, out, survey, claim, v };
}

test('r.siteLot over the trunk fixture with its box: the site is the fixture\'s spec (sha, frame, keep cells, ports), the IR lot carries it', async () => {
  const { site } = fixture('trunk');
  const { res, out } = await planOver('trunk', (r, aff) => r.siteLot('hut', { affordance: aff.find((a) => a.kind === 'trunk'), fit: 'wrap_trunk', box: site.lot, ports: site.spec.ports, stage: 'lots' }));
  const strip = ({ lotId, ...x }) => x;
  assert.equal(out.site.lotId, 'hut');
  assert.deepEqual(strip(out.site), strip(site.spec));
  assert.equal(out.site.volumeBlobId, `local:${site.spec.volumeSha}`);
  assert.deepEqual(siteSpecProblems(out.site), []);
  const l = res.ir.lots.find((x) => x.id === 'hut');
  assert.deepEqual(l.site, out.site);
  assert.deepEqual(l.affordance.kind, 'trunk');
  assert.equal(l.host, null);
  assert.equal(l.floorY, site.lot.minY);
  assert.deepEqual(l.max, [16, 20, 16]);
  assert.equal(l.front, 'south');
  assert.ok(!('pad' in l), 'a site lot writes no pad');
  assert.ok(!Object.keys(res.ir.blobs ?? {}).some((n) => n.startsWith('site_')), 'the exact volume read: no cut blob');
  assert.deepEqual(res.ir.parts.filter((p) => p.ops?.length).map((p) => p.id), [], 'no op at all');
});

test('r.siteLot from an affordance: the box under the canopy round the trunk, the volume cut from the one read (a gzip side blob of the raw ARVX\'s sha), keep cells the logs', async () => {
  const { vol } = fixture('trunk');
  const { res, out } = await planOver('trunk', (r, aff) => r.siteLot('hut', { affordance: aff.find((a) => a.kind === 'trunk'), fit: 'wrap_trunk', max: [13, 16, 13], y: 66, stage: 'lots' }));
  const b = out.box;
  const tr = res.affordances.find((a) => a.kind === 'trunk');
  assert.deepEqual([b.minX + 6, b.minY, b.minZ + 6, b.maxY - b.minY + 1], [tr.anchors[0][0], 66, tr.anchors[0][2], 16], 'centred on the trunk\'s axis, the floor given');
  const s = out.site;
  assert.deepEqual(s.volume, { minX: b.minX - 8, minY: b.minY - 8, minZ: b.minZ - 8, maxX: b.maxX + 8, maxY: b.maxY + 8, maxZ: b.maxZ + 8 });
  const blob = res.ir.blobs.site_hut;
  assert.equal(blob.kind, 'volume');
  const gz = res.blobs.get(blob.sha);
  assert.equal(sha256Hex(gz), blob.sha);
  assert.equal(gz[9], 255, 'the gzip OS byte pinned');
  const raw = zlib.gunzipSync(gz);
  assert.equal(sha256Hex(raw), s.volumeSha, 'the volume\'s sha is the raw ARVX\'s');
  const cut = decodeArvx(raw);
  assert.deepEqual(cut.box, s.volume);
  for (let x = cut.box.minX; x <= cut.box.maxX; x += 3) for (let z = cut.box.minZ; z <= cut.box.maxZ; z += 3) for (let y = cut.box.minY; y <= cut.box.maxY; y++) assert.equal(classAt(cut, x, y, z), classAt(vol, x, y, z));
  assert.ok(s.keepCritical.length > 0 && s.keepCritical.every((c) => classAt(vol, ...c) === VC.LOG && c[1] >= b.minY && c[1] <= b.maxY), 'the host logs in the box');
  assert.deepEqual(s.ports, defaultPorts('wrap_trunk', [13, 16, 13]));
  assert.ok(res.affordances.some((a) => a.id === out.affordance.id), 'plan.json lists the affordance it stands on');
  // a cut of a volume over its own box is that volume's bytes
  assert.equal(sha256Hex(cropVolume(vol, vol.box)), vol.sha);
});

test('r.siteLot: the first plan (no volume) asks it and places nothing; refusals', async () => {
  const { site } = fixture('trunk');
  const first = await planOver('trunk', (r) => r.siteLot('hut', { fit: 'wrap_trunk', box: site.lot, stage: 'lots' }), { volumes: false });
  assert.equal(first.out, null);
  assert.equal(first.res.ir.lots.length, 0);
  assert.ok(first.res.needVolumes.some((b) => b.minX === site.spec.volume.minX && b.maxY === site.spec.volume.maxY));
  const bad = async (o, re) => assert.rejects(planOver('trunk', (r, aff) => r.siteLot('hut', { stage: 'lots', ...(typeof o === 'function' ? o(aff) : o) })), re);
  await bad({ fit: 'hover', box: site.lot }, /fit must be one of/);
  await bad({ fit: 'wrap_trunk' }, /needs an affordance or a box/);
  await bad((aff) => ({ fit: 'wrap_trunk', affordance: aff.find((a) => a.kind === 'trunk') }), /max must be/);
  await bad({ fit: 'wrap_trunk', affordance: 'trunk_nope', max: [9, 9, 9] }, /no affordance 'trunk_nope'/);
  await bad({ fit: 'wrap_trunk', box: site.lot, ports: [{ name: 'p', kind: 'architect:walk', at: [40, 0, 0], facing: 'south', width: 1, height: 1 }] }, /outside the design's/);
  await bad({ fit: 'wrap_trunk', box: { ...site.lot, maxY: site.lot.minY + 70 } }, /child cap|outside the claim/);
  await bad({ fit: 'wrap_trunk', box: site.lot, host: 'nobody' }, /host must be a part id/);
  await bad({ fit: 'wrap_trunk', box: { ...site.lot, minX: site.lot.minX - 1 } }, /site volume \(the box \+ 8\) leaves the claim/);
  await assert.rejects(planOver('trunk', (r) => { r.siteLot('a', { fit: 'wrap_trunk', box: site.lot, stage: 'lots' }); r.siteLot('b', { fit: 'wrap_trunk', box: site.lot, stage: 'lots' }); }), /overlaps lot a/);
});

test('default ports per fit (frozen in the as-built, SV\'s fixtures\' names) and the frame\'s front', () => {
  assert.deepEqual(defaultPorts('on_pad', [9, 9, 9]), []);
  assert.deepEqual(defaultPorts('wrap_trunk', [9, 16, 7]), [{ name: 'walk_w', kind: 'architect:walk', at: [0, 2, 3], facing: 'west', width: 2, height: 2 }]);
  assert.deepEqual(defaultPorts('span', [16, 8, 9]).map((p) => [p.name, p.at, p.facing]), [['walk_w', [0, 0, 4], 'west'], ['walk_e', [15, 0, 4], 'east']]);
  assert.deepEqual(defaultPorts('suspend', [9, 8, 9]), [{ name: 'hatch', kind: 'architect:walk', at: [4, 0, 4], facing: 'down', width: 1, height: 1 }]);
  assert.deepEqual(defaultPorts('attach_to_cliff', [16, 22, 12]).map((p) => [p.name, p.at, p.facing]), [['walk_top', [7, 19, 1], 'north']]);
  assert.deepEqual(defaultPorts('carve_into', [16, 12, 16]), [{ name: 'door_s', kind: 'door', at: [7, 0, 15], facing: 'south', width: 1, height: 2 }]);
  // SV's examples find them: the trunk example's port by side, on a site whose ports are the defaults
  for (const [fit, fx] of [['wrap_trunk', 'trunk'], ['suspend', 'overhang'], ['span', 'rift_site'], ['attach_to_cliff', 'cliff_face']]) {
    const s = fixture(fx).site;
    const size = [s.lot.maxX - s.lot.minX + 1, s.lot.maxY - s.lot.minY + 1, s.lot.maxZ - s.lot.minZ + 1];
    const names = defaultPorts(fit, size).map((p) => p.name).sort();
    assert.deepEqual(names, s.spec.ports.map((p) => p.name).sort(), `${fit}: the fixture's port names`);
  }
  assert.deepEqual(FRONT_OF_ROTATION, { none: 'south', clockwise_90: 'west', clockwise_180: 'north', counterclockwise_90: 'east' });
});

test('the reserved box: no op writes inside a site lot but its host part (M1); a suspend lot\'s hang points', async () => {
  const { site } = fixture('trunk');
  const inside = [site.lot.minX + 1, site.lot.minY + 1, site.lot.minZ + 1];
  const plan = (host) => planOver('trunk', (r) => {
    const t = r.part('tree', { stage: 'ground' });
    t.fill({ kind: 'box', min: [inside[0], { abs: inside[1] }, inside[2]], max: [inside[0], { abs: inside[1] }, inside[2]] }, 'structure', { cond: 3 });
    r.part('other', { stage: 'ground' }).fill({ kind: 'box', min: [site.lot.maxX + 3, { abs: inside[1] }, inside[2]], max: [site.lot.maxX + 3, { abs: inside[1] }, inside[2]] }, 'structure', { cond: 3 });
    return r.siteLot('hut', { fit: 'wrap_trunk', box: site.lot, stage: 'lots', ...(host ? { host: 'tree' } : {}) });
  });
  const m1 = async (host) => {
    const { res, survey } = await plan(host);
    const rep = checkRegion({ ir: res.ir, survey, blobs: (sha) => res.blobs.get(sha) ?? null, meta: res.meta, volumes: [] });
    return rep.findings.filter((f) => f.rule === 'M1' && /site lot/.test(f.message));
  };
  const hit = await m1(false);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].part, 'tree');
  assert.equal(hit[0].severity ?? 'error', 'error');
  assert.match(hit[0].message, /inside site lot hut's reserved box/);
  assert.deepEqual(await m1(true), [], 'the host writes inside');
  // suspend: the first solid cell over each corner inset 2
  const o = fixture('overhang');
  const { out } = await planOver('overhang', (r) => r.siteLot('hang', { fit: 'suspend', box: o.site.lot, stage: 'lots' }));
  assert.equal(out.site.keepCritical.length, 4);
  for (const c of out.site.keepCritical) assert.ok(c[1] > o.site.lot.maxY && [o.site.lot.minX + 2, o.site.lot.maxX - 2].includes(c[0]) && [o.site.lot.minZ + 2, o.site.lot.maxZ - 2].includes(c[2]));
});

const elevated = (lots, extra = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'canopy', kind: 'standard', size: { preset: 'M' }, where: { near: { anchor: 'grove', within: 8 } }, program: { layout: 'elevated', lots }, ...extra }] });
const hut = (id) => ({ id, type: 'cabin', size: [9, 9] });
const V7B = read('valid').find((f) => f.name === 'v7b_sl_canopy.json');

test('layout.elevated: two canopy huts fit, each a wrap_trunk site lot on the artifact (site = SiteSpec wire, affordance, fitBox), stable', async () => {
  const r = await run(V7B);
  assert.equal(r.check.overall, 'READY');
  const a = r.check.parts.find((p) => p.part === 'canopy');
  assert.equal(a.class, 'fits');
  assert.equal(a.geometry.elevated, true);
  assert.equal(r.asked.length, 1, 'the first plan asked the zone\'s volume');
  assert.equal(r.first.check.parts.find((p) => p.part === 'canopy').class, 'incomplete');
  assert.equal(r.first.check.parts.find((p) => p.part === 'canopy').reasons[0].code, 'VOLUME');
  const lots = r.artifact.lots;
  assert.deepEqual(lots.map((l) => l.id).sort(), ['hut_a', 'hut_b']);
  for (const l of lots) {
    assert.deepEqual(siteSpecProblems(l.site), [], l.id);
    assert.equal(l.site.lotId, l.id);
    assert.equal(l.site.fit, 'wrap_trunk');
    assert.deepEqual(l.site.frame.origin, l.box.slice(0, 3));
    assert.deepEqual(l.fitBox, l.box);
    assert.equal(l.entrance, null);
    assert.equal(l.affordance.kind, 'canopy');
    assert.ok(l.site.keepCritical.length > 0);
    const ir = r.res.ir.lots.find((x) => x.id === l.id);
    assert.deepEqual(ir.site, l.site);
  }
  const again = await run(V7B);
  assert.equal(again.artifactSha, r.artifactSha, 'deterministic');
});

test('layout.elevated: count tolerance (adjusted), nothing to stand on (refused NO_FEATURE), connectors to its lots unsupported until LP', async () => {
  const three = { ...V7B, plan: elevated([hut('hut_a'), hut('hut_b'), hut('hut_c')]) };
  const r3 = await run(three);
  const a3 = r3.check.parts.find((p) => p.part === 'canopy');
  assert.equal(a3.class, 'adjusted');
  assert.deepEqual(a3.deviations, [{ what: 'count', value: 1, max: 0, exceeds: true }]);
  assert.deepEqual(r3.artifact.lots.map((l) => l.id).sort(), ['hut_a', 'hut_b']);
  const hard = await run({ ...V7B, plan: elevated([hut('hut_a'), hut('hut_b'), hut('hut_c')], { tolerance: { count: { max: 0, hard: true } } }) });
  const ah = hard.check.parts.find((p) => p.part === 'canopy');
  assert.equal(ah.class, 'refused');
  assert.equal(ah.reasons[0].code, 'NO_FEATURE');
  assert.deepEqual(ah.wouldFit[0].fragment.program.lots.map((l) => l.id), ['hut_a', 'hut_b']);
  // flat land, no tree
  const flat = await run({ ...V7B, terrain: {}, volume: { edits: [] } });
  const af = flat.check.parts.find((p) => p.part === 'canopy');
  assert.equal(af.class, 'refused');
  assert.equal(af.reasons[0].code, 'NO_FEATURE');
  // a rope bridge between the two huts: unsupported until LP; one depending on a refused zone: blocked
  const bridge = { id: 'b1', kind: 'rope_bridge', from: { part: 'hut_a' }, to: { part: 'hut_b' } };
  const rb = await run({ ...V7B, plan: { ...V7B.plan, connectors: [bridge] } });
  const ab = rb.check.parts.find((p) => p.part === 'b1');
  assert.equal(ab.class, 'unsupported');
  // ((7b LP) the link pass shipped: a rope bridge is not a port link kind, so it stays unsupported, with no `until`)
  assert.equal(ab.reasons[0].until, undefined);
  assert.equal(rb.check.parts.find((p) => p.part === 'canopy').class, 'fits');
  const fb = await run({ ...V7B, terrain: {}, volume: { edits: [] }, plan: { ...V7B.plan, connectors: [bridge], dependencies: [{ part: 'b1', after: ['canopy'] }] } });
  assert.equal(fb.check.parts.find((p) => p.part === 'b1').class, 'blocked');
});

test('catalogue: layout.elevated supported (sinceApi NEXT, schemaVersion 1); against catalogue-pre7b.json only 7bF\'s two ids and this flip', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const e = golden.entries.find((x) => x.id === 'layout.elevated');
  assert.equal(e.state, 'supported');
  assert.equal(e.until, undefined);
  assert.equal(e.schemaVersion, 1);
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi));
  const before = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan', 'catalogue-pre7b.json'), 'utf8'));
  assert.ok(golden.catalogueVersion >= before.catalogueVersion, 'catalogueVersion is the coordinator\'s at merge (at least the snapshot\'s)');
  const changed = golden.entries.filter((x) => JSON.stringify(x) !== JSON.stringify(before.entries.find((y) => y.id === x.id))).map((x) => x.id);
  // ((7b LP) connector.branch_walk's and tunnel.under's flips are lp.test.mjs's)
  assert.deepEqual(changed.filter((id) => !['connector.branch_walk', 'tunnel.under', 'program.authored', 'form.hollow_mountain', 'form.crater', 'form.floating_island', 'channel.aqueduct'].includes(id)).sort(), ['form.hidden_room', 'layout.elevated', 'rule.suspended']); // ((7c BF) its three flips: bf.test.mjs)
});
