// 6c D3 (§6, §14 item 1): the kit/Java parity fixture is the kit's own answer: besideStanding and districtLand over its inputs equal the
// recorded outputs (the mod's BesideReachTest and DistrictLandTest compare Java to the same file). Re-cut: node kit/test/d3-parity.mjs --write
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { besideStanding } from '../lib/region/beside.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { FIXTURE } from './d3-parity.mjs';

test('the parity fixture: besideStanding and districtLand over its IRs equal its recorded outputs', () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(besideStanding(f.town.id, f.town.claim, f.town.ir), f.town.standing);
  assert.ok(f.districts.length >= 4);
  for (const d of f.districts) {
    assert.deepEqual(districtLand(d.ir, d.townClaim), d.land, d.name);
    assert.deepEqual(districtLand(d.ir, null), d.landNoTown, d.name);
    assert.deepEqual(districtLand(d.ir, d.townClaim, { standingRemoved: 1234567 }), d.landRemoved, d.name);
  }
  assert.ok(f.districts.some((d) => d.ir.reach) && f.districts.some((d) => !d.ir.reach && d.ir.beside), 'a reach join and a seam join');
  assert.ok(f.districts.some((d) => d.ir.corridor), 'an outpost');
});
