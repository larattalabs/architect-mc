// (M5 GP, S-M5-1) A given program is told its lot's reserved cells: build.mjs passes `--reserved` to the design as `reserved` (the lot's
// frame), so the module fixture (test/fixtures/gp/gp_crop_field.mjs) leaves them air and the checker passes; the same program ignoring them
// is refused by the checker's reserved rule; values outside its params are a UsageError; no reserved given: the option is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesign, loadDesign, UsageError } from '../build.mjs';
import { parseReserved, frameToTemplate } from '../lib/reserved.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'gp', 'gp_crop_field.mjs'), 'utf8');
const RESERVED = parseReserved({ front: 'south', size: [11, 11], cells: [[5, -1, 5], [5, 0, 5]] });

/** A temp design dir (outside the kit: other runs copy it), its `../lib/` imports pointed at this kit's lib; removed after. */
function designDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-test-'));
  const lib = pathToFileURL(path.join(KIT, 'lib')).href;
  for (const [id, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${id}.mjs`), src.replaceAll("'../lib/", `'${lib}/`));
  return dir;
}
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-out-'));

test('a program is given the reserved cells and leaves them; the checker passes', async () => {
  const dir = designDir({ gp_crop_field: SOURCE });
  try {
    const { bp, result } = await buildDesign('gp_crop_field', { dir, out: out(), reserved: RESERVED });
    assert.deepEqual(result.errors, []);
    const t = { size: [11, 3, 11], groundY: 1, front: 'south' };
    for (const [u, y, v] of RESERVED.cells) assert.equal(bp.cells.has(frameToTemplate(u, y, v, t, RESERVED).join(',')), false, `reserved ${u},${y},${v} is left air`);
    assert.equal(bp.cells.has('4,0,5'), true, 'the field next to it is farmed');
    // no reserved: every field cell is written
    const plain = await loadDesign('gp_crop_field', { dir });
    assert.equal(plain.cells.has('5,0,5'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a program that ignores the reserved cells is refused by the checker (reserved)', async () => {
  const ign = SOURCE.replace("if (!keep.has(`${x},${y},${z}`)) bp.set(x, y, z, block, props);", 'bp.set(x, y, z, block, props);');
  assert.notEqual(ign, SOURCE);
  const dir = designDir({ gp_crop_field: ign });
  try {
    const { result } = await buildDesign('gp_crop_field', { dir, out: out(), reserved: RESERVED });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^reserved: the design writes 2 of the lot's reserved cell/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('values outside the program\'s params are a usage error', async () => {
  const dir = designDir({ gp_crop_field: SOURCE });
  try {
    await assert.rejects(loadDesign('gp_crop_field', { dir, values: { side: 99 } }), (e) => e instanceof UsageError && /side must be an integer 5\.\.27/.test(e.message));
    await assert.rejects(loadDesign('gp_crop_field', { dir, values: { crop: 'melon' } }), UsageError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
