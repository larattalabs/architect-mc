// (slice R2, 7c-region-2) Forms as land: an elevated zone standing on a form part of the plan (its locator `inside: {part}`) finds its lots
// on the land after the forms (the frozen volume with the plan's own writes so far), and each site volume is cut from that land: a hanging
// lot under a region-made floating island (x01), a treehouse round a region-made giant oak (x02). Plus the T3a/K1 moat re-check: a route
// from outside a moat into the walled town's auto gate leaves no M2:wall or M6 finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, svOf } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { formHostOf, landAfterForms } from '../lib/plan/elevated.mjs';
import { VC } from '../lib/region/volume.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (dir, n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan', dir, `${n}.json`), 'utf8'));
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const report = (f, r) => {
  const s = svOf(f);
  return checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded) });
};
const errors = (rep) => rep.findings.filter((x) => x.severity === 'error').map((x) => `${x.rule} ${x.part}: ${x.message}`);

test('formHostOf: inside or near a form part only; every other zone none (resolved as before)', () => {
  const byId = new Map([['isle', { family: 'form', kind: 'floating_island' }], ['town', { family: 'zone', kind: 'standard' }]]);
  assert.deepEqual(formHostOf({ part: { where: { inside: { part: 'isle' } } } }, byId), { id: 'isle', kind: 'floating_island' });
  assert.deepEqual(formHostOf({ part: { where: { near: { feature: { part: 'isle' } } } } }, byId), { id: 'isle', kind: 'floating_island' });
  assert.equal(formHostOf({ part: { where: { inside: { part: 'town' } } } }, byId), null);
  assert.equal(formHostOf({ part: { where: { near: { anchor: 'stone' } } } }, byId), null);
  assert.equal(formHostOf({ part: {} }, byId), null);
});

test('landAfterForms: written cells take their block\'s class, the rest the frozen volume\'s', () => {
  const box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 };
  const vol = { box, width: 2, height: 2, depth: 1, classes: new Uint8Array([VC.SOIL, VC.AIR, VC.SOIL, VC.AIR]), owners: [], ownerOf: new Map() };
  const states = ['minecraft:air', 'minecraft:oak_log', 'minecraft:stone'];
  const lw = { vw: { pal: { states }, flags: (x, y) => (x === 1 && y === 1 ? 1 : x === 0 && y === 0 ? 1 : 0), get: (x, y) => (x === 1 ? 1 : 2) } };
  const { land, changed } = landAfterForms(vol, lw);
  assert.deepEqual([...land.classes], [VC.ROCK, VC.AIR, VC.SOIL, VC.LOG]);
  assert.equal(changed, 2);
  assert.deepEqual([...vol.classes], [VC.SOIL, VC.AIR, VC.SOIL, VC.AIR], 'the frozen volume is not changed');
});

test('x01: a hanging lot under a region-made floating island: READY, the lot a suspend site lot hung inverted, its site cut from the land after the forms, the checker clean', async () => {
  const f = fx('r2', 'x01_island_hanging');
  const r = await run(f);
  assert.equal(r.check.overall, 'READY');
  const z = part(r, 'hanging');
  assert.equal(z.class, 'fits', JSON.stringify(z));
  assert.ok(z.notes.some((n) => /land after the forms/.test(n)));
  const lot = r.res.ir.lots.find((l) => l.id === 'home_a');
  assert.equal(lot.site.fit, 'suspend');
  assert.equal(lot.inverted, true);
  assert.equal(lot.host, 'f_isle');
  assert.ok(lot.site.keepCritical.length >= 1, 'its hang points are the island\'s rock (in the land after the forms only)');
  assert.ok(r.res.ir.blobs.site_home_a, 'the site volume is its own side blob');
  assert.deepEqual(errors(report(f, r)), []);
});

test('x02: a treehouse round a region-made giant oak: READY, a wrap_trunk site lot whose keep-critical cells are the oak\'s logs', async () => {
  const f = fx('r2', 'x02_tree_house');
  const r = await run(f);
  assert.equal(r.check.overall, 'READY');
  assert.equal(part(r, 'canopy').class, 'fits');
  const lot = r.res.ir.lots.find((l) => l.id === 'treehouse');
  assert.equal(lot.site.fit, 'wrap_trunk');
  assert.ok(lot.site.keepCritical.length > 0, 'the oak\'s logs');
  assert.deepEqual(errors(report(f, r)), []);
});

test('without the forms as land the same zone finds nothing: the island part removed, the zone answers blocked on it', async () => {
  const f = fx('r2', 'x01_island_hanging');
  f.plan.forms[0].where = { near: { anchor: 'nowhere_anchor' } };
  const r = await run(f);
  assert.ok(['blocked', 'refused'].includes(part(r, 'hanging').class), JSON.stringify(part(r, 'hanging')));
});

test('the T3a/K1 moat re-check: a road, street or path from outside the moat into the walled town (its auto gate) leaves no M2:wall or M6 finding', async () => {
  const base = fx('valid', 'v45_moat');
  for (const [id, kind, from] of [['road_e', 'road', 'claim_e'], ['street_s', 'street', 'claim_s'], ['path_w', 'path', 'claim_w']]) {
    const f = JSON.parse(JSON.stringify(base));
    f.plan.connectors.push({ id, kind, from: { anchor: from }, to: { part: 'town' } });
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', id);
    assert.ok(['fits', 'adjusted'].includes(part(r, id).class), id);
    const bad = report(f, r).findings.filter((x) => /^M2|^M6/.test(x.rule));
    assert.deepEqual(bad.map((x) => `${x.rule} ${x.part}: ${x.message}`), [], id);
  }
});
