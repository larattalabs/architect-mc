// C38: Regions.planCatalogue() (docs/CONTRACT.md "C38 as built") reads the catalogue the kit stamps on every plan check. This is the
// kit's half: a check answer (READY and MALFORMED alike) carries planCatalogue() entry for entry, which is the committed golden;
// the mod's half (PlanCatalogueTest) holds the jar's catalogue equal to the same golden and to a node run of this function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { asksSurvey, checkPlanLocal, stewardAnchors, ROOT } from './plan-helpers.mjs';

const A = asksSurvey();
const check = (plan) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));

test('C38: a check answer carries planCatalogue(), entry for entry, and it is the golden', async () => {
  const ok = await check({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: [{ id: 'c1', type: 'cottage', size: [9, 9] }] } }] });
  assert.equal(ok.check.overall, 'READY');
  const live = planCatalogue();
  assert.equal(ok.check.catalogue.entries.length, live.entries.length);
  ok.check.catalogue.entries.forEach((e, i) => assert.deepEqual(e, live.entries[i], `entry ${i} ${e.id}`));
  assert.deepEqual(ok.check.catalogue, live);
  assert.deepEqual(live, golden);
});

test('C38: a malformed plan\'s answer carries the same catalogue', async () => {
  const bad = await check({ schemaVersion: 'plan/0', zones: 'nope' });
  assert.equal(bad.check.overall, 'MALFORMED');
  assert.deepEqual(bad.check.catalogue, planCatalogue());
});

test('C38: an entry\'s members are the answer\'s: id, state, sinceApi, schemaVersion, then only until/retiredInApi/replacedBy/aliasOf/limits/note', () => {
  const allowed = new Set(['id', 'state', 'sinceApi', 'schemaVersion', 'until', 'retiredInApi', 'replacedBy', 'aliasOf', 'limits', 'note']);
  for (const e of planCatalogue().entries) {
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `${e.id}: ${k}`);
    for (const k of ['id', 'state', 'sinceApi', 'schemaVersion']) assert.ok(e[k] !== undefined, `${e.id} lacks ${k}`);
  }
});
