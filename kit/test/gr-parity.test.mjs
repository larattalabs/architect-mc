// (6d GR §7) The land v 2 parity fixture equals the kit (the mod's DistrictLandGrTest reads the same file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIXTURE, build } from './gr-parity.mjs';

test('kit/test/fixtures/gr/land.json is the kit\'s own answer (re-cut with node kit/test/gr-parity.mjs --write)', async () => {
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(await build())), want);
  for (const c of want.cases) {
    assert.equal(c.land.v, 2);
    assert.equal(c.landUndone.v, 2);
    assert.equal(c.landBase.v, 1);
    assert.ok(c.land.parts.some((p) => p.kind === 'grown' && p.revision === 1));
  }
});
