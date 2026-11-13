// (7c CO, docs/CONTRACT.md "Phase 7c" §3 row 12, "Slice CO as built") The planning images (kit/lib/region/planImages.mjs): the four
// renders of a claim's land with its affordances, byte-stable (the same survey and list give the same pixels, twice and through the CLI,
// equal to the committed shas), the affordance ranking the composer's prompt shares, and the labels.
//   node kit/test/co.test.mjs --write   re-records kit/test/fixtures/co/planimages.json (only when the renders are meant to change)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLand, applySculpt, plan2 } from './sb-world.mjs';
import { hillAt } from '../regions/s3_hill.mjs';
import { analyseVolume } from '../lib/region/affordances.mjs';
import { renderPlanImages, rankAffordances, PLAN_IMAGE_NAMES, PLAN_IMAGE_AFFORDANCES } from '../lib/region/planImages.mjs';
import { decodePng } from '../lib/png.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(KIT, 'test', 'fixtures', 'co', 'planimages.json');

/** S6's sculpted hill with its cavern (tc-land.mjs's s6_cavern land): its survey and its whole volume's affordances. */
async function cavernLand() {
  const claim = { minX: 3672, minZ: -1780, maxX: 3863, maxZ: -1589 };
  const groundAt = (x, z) => 64 + hillAt((claim.minX + claim.maxX) >> 1, (claim.minZ + claim.maxZ) >> 1, 88, 60, x, z);
  const land = makeLand({ claim, minY: 22, maxY: 173, groundAt });
  applySculpt(land, await plan2(land, 's6_cavern_sculpt'));
  const v = land.volume({ ...claim, minY: 22, maxY: 173 });
  return { survey: land.survey(), affordances: analyseVolume(v.decoded) };
}
/** A plain flat land (no affordances given). */
function flatLand() {
  const claim = { minX: 0, minZ: 0, maxX: 95, maxZ: 63 };
  return { survey: makeLand({ claim, minY: 40, maxY: 90, groundAt: (x) => 60 + (x >> 4) }).survey(), affordances: [] };
}

const shas = (r) => Object.fromEntries(r.images.map((im) => [im.name, { pixelSha: im.pixelSha, width: im.width, height: im.height }]));

if (process.argv.includes('--write')) {
  const cav = await cavernLand(), flat = flatLand();
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  const out = { note: '7c CO: the planning images\' pixel shas (kit/test/co.test.mjs --write)', cavern: shas(renderPlanImages(cav)), flat: shas(renderPlanImages(flat)) };
  fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

test('7c CO: the planning images are byte-stable and equal the committed shas', async () => {
  const cav = await cavernLand();
  const a = renderPlanImages(cav), b = renderPlanImages(cav);
  assert.deepEqual(a.images.map((im) => im.name), PLAN_IMAGE_NAMES);
  for (let i = 0; i < a.images.length; i++) {
    assert.equal(Buffer.compare(Buffer.from(a.images[i].png), Buffer.from(b.images[i].png)), 0, `${a.images[i].name}: the same PNG bytes twice`);
    const px = decodePng(Buffer.from(a.images[i].png));
    assert.equal(px.width, a.images[i].width);
    assert.ok(a.images[i].width <= 1536 * 2 && a.images[i].height <= 4096, `${a.images[i].name}: a sane size ${a.images[i].width}x${a.images[i].height}`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(shas(a), golden.cavern, 'the cavern land: the committed pixel shas');
  assert.deepEqual(shas(renderPlanImages(flatLand())), golden.flat, 'a flat land without affordances: the committed pixel shas');
});

test('7c CO: the affordances are ranked by score then id, at most 60, numbered as the prompt numbers them', async () => {
  const cav = await cavernLand();
  assert.ok(cav.affordances.some((a) => a.kind === 'cave'), 'the cavern land has a cave');
  const r = renderPlanImages(cav);
  const ranked = rankAffordances(cav.affordances);
  assert.ok(ranked.length <= PLAN_IMAGE_AFFORDANCES);
  assert.deepEqual(r.labels.map((l) => l.id), ranked.map((a) => a.id));
  assert.deepEqual(r.labels.map((l) => l.n), ranked.map((_, i) => i + 1));
  for (let i = 1; i < ranked.length; i++) {
    const p = ranked[i - 1], q = ranked[i];
    assert.ok(p.score > q.score || (p.score === q.score && p.id < q.id), `order at ${i}`);
  }
  // the order does not depend on the input order
  assert.deepEqual(rankAffordances([...cav.affordances].reverse()).map((a) => a.id), ranked.map((a) => a.id));
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `pad_${String(i).padStart(3, '0')}`, kind: 'pad', box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, score: 0.5 }));
  assert.equal(rankAffordances(many).length, 60);
  assert.equal(rankAffordances([{ id: 1 }, null, { id: 'x', kind: 'pad' }]).length, 0, 'malformed entries are left out');
});

test('7c CO: the CLI writes the library\'s images', async () => {
  const cav = await cavernLand();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-pi-'));
  try {
    fs.writeFileSync(path.join(dir, 'survey.bin'), cav.survey);
    fs.writeFileSync(path.join(dir, 'aff.json'), JSON.stringify({ affordances: cav.affordances }));
    const out = execFileSync(process.execPath, [path.join(KIT, 'tools', 'planimages.mjs'), path.join(dir, 'survey.bin'), '--out', path.join(dir, 'out'), '--affordances', path.join(dir, 'aff.json')], { encoding: 'utf8' });
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.ok, true);
    const lib = renderPlanImages(cav);
    assert.deepEqual(j.images.map((im) => [im.name, im.pixelSha]), lib.images.map((im) => [im.name, im.pixelSha]));
    for (const im of j.images) assert.equal(Buffer.compare(fs.readFileSync(im.file), Buffer.from(lib.images.find((x) => x.name === im.name).png)), 0);
    assert.equal(j.labels.length, lib.labels.length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
