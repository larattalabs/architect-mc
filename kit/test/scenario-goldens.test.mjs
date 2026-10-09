// Scenario determinism goldens (docs/CONTRACT.md 6b §8.3 "Determinism", gate item 1): for each scenarios/goldens/<id>.json,
// the committed plan inputs beside it (goldens/<id>/: ir.json, survey.bin, blobs/) give the same IR sha and the same tile
// shas with 1 worker forward and 4 workers shuffled, on macOS and Linux CI alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileShas } from '../../tools/scenarios.mjs';

const GOLD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scenarios', 'goldens');
const files = fs.existsSync(GOLD) ? fs.readdirSync(GOLD).filter((f) => f.endsWith('.json')).sort() : [];

test('scenario goldens exist for the green 6b scenario (S1)', () => {
  assert.ok(files.includes('s1.json'), `scenarios/goldens/s1.json (have: ${files.join(', ') || 'none'})`);
});

for (const f of files) {
  test(`scenario golden ${f}: IR sha and tile shas, 1 worker = 4 workers shuffled = the golden`, async () => {
    const g = JSON.parse(fs.readFileSync(path.join(GOLD, f), 'utf8'));
    const r = await tileShas(path.join(GOLD, f.replace(/\.json$/, '')));
    assert.equal(r.irSha, g.irSha, 'IR sha');
    assert.ok(r.workersSame, '1 worker forward = 4 workers shuffled');
    assert.deepEqual(r.tiles, g.tiles, 'tile shas');
  });
}
