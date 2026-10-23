// (6c close-out B; PLAN "Queued from the batch v0.41.0 integration": S3's natural scenario depends on the live survey) One natural run of
// the monastery (gate-runs-0410/20261021-180501-slice, IR afc7092eaf47 on main a6a947bc) planned over a live survey in which a tree near
// the gardens (x 3674-3677, z -945..-942) had no TREE flag (the pinned post-settle survey has it): the relief, free to grade those columns,
// blended its grass over a stair flight's head room cut (x 3679-3681), and the plan answered M3 (2 floating relief cells) and M8 (1 open
// walk cell). The program's trim now takes the relief's own floating natural cells out (trimFloating, TRIM_NATURAL). This test re-plans
// that run's recorded inputs (kit/test/fixtures/s3-live: its survey, frozen volumes, biome grid and bible) and holds the bars: no M1-M4,
// M8 fully guarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { decodeArvx } from '../lib/region/volume.mjs';
import { asColumns, FLAG_TREE } from '../lib/region/pack.mjs';
import { sampleIndex } from '../lib/region/survey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = path.join(HERE, 'fixtures', 's3-live');

test('S3 on the recorded live survey that answered M3/M8 (gate-runs-0410/20261021-180501-slice): no M1-M4, M8 guarded', async () => {
  const inp = JSON.parse(fs.readFileSync(path.join(F, 'inputs.json'), 'utf8'));
  const survey = fs.readFileSync(path.join(F, 'survey.bin'));
  // the cause: the tree's columns carry no TREE flag in this survey
  const cols = asColumns(survey);
  let tree = 0;
  for (let x = 3674; x <= 3677; x++) for (let z = -945; z <= -942; z++) tree += (cols.flags[sampleIndex(cols, x, z)] & FLAG_TREE) ? 1 : 0;
  assert.equal(tree, 0, 'the recorded survey has no tree at x 3674-3677, z -945..-942');
  const volumes = [];
  for (const v of Object.values(inp.volumes ?? {})) {
    const b = fs.readFileSync(path.join(F, 'blobs', `${inp.blobs[v.blob].sha}.bin`));
    const d = decodeArvx(b);
    volumes.push({ sha: d.sha, box: d.box, bytes: Uint8Array.from(b), decoded: d });
  }
  const biomes = JSON.parse(fs.readFileSync(path.join(F, 'biomes.json'), 'utf8'));
  const fluids = JSON.parse(fs.readFileSync(path.join(F, 'bible.json'), 'utf8')).fluids ?? null;
  const p = await planRegion({ programFile: path.join(HERE, '..', 'regions', `${inp.id}.mjs`), params: inp.params, survey, seed: inp.seed, claim: { ...inp.claim, minY: -64, maxY: 319 },
    roles: inp.roles, kitVersion: inp.kitVersion, keepOut: inp.keepOut, volumes, biomes, ...(fluids ? { fluids } : {}) });
  const ck = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, volumes: volumes.map((v) => v.decoded) });
  const bad = ck.findings.filter((f) => /^M[1-4](:|$)/.test(f.rule) || f.rule === 'M8').map((f) => `${f.rule} ${f.part} ${f.count} ${JSON.stringify(f.sample?.slice(0, 3))}`);
  assert.deepEqual(bad, [], 'S3 bars 1, 5, 6: no M1-M4, M8 100%');
  assert.ok(p.ir.lots.length >= 10, `${p.ir.lots.length} lots`);
  assert.ok((p.meta.monastery?.trimmed ?? 0) > 0, 'the trim took the floating relief cells out');
});
