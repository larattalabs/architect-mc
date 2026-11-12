// (7cF) The 7c foundation (docs/CONTRACT.md "Phase 7c" §3 row 1): program.authored reserved until AU, the six flips' plan/0 draft
// skeletons (still reserved), and catalogue text on demand (planCatalogueKinds; Regions.planCatalogue(kinds) is the mod's half,
// PlanCatalogueTest). The compact copy's one line per kind is the sidecar's (sidecar/test/system-refs.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffCatalogues, planCatalogue, planCatalogueKinds } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA } from '../lib/plan/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
const FLIPS = ['form.hollow_mountain', 'form.crater', 'form.floating_island', 'form.hidden_room', 'rule.suspended', 'channel.aqueduct'];

test('catalogue: against catalogue-pre7c.json exactly program.authored added (reserved until AU, sinceApi NEXT); the six flips unchanged in the answer', () => {
  assert.deepEqual(planCatalogue(), golden);
  const pre = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan', 'catalogue-pre7c.json'), 'utf8'));
  const d = diffCatalogues(pre, golden);
  // (later 7c slices' own flips are their tests')
  const mine = (xs) => xs.filter((x) => !FLIPS.includes(x.id ?? x));
  assert.deepEqual(d.added, [{ id: 'program.authored', state: 'reserved' }]);
  assert.deepEqual([d.removed, d.retired, mine(d.reservedToSupported), mine(d.otherStateChanges), mine(d.untilChanged), mine(d.notesChanged)], [[], [], [], [], [], []]);
  const e = golden.entries.find((x) => x.id === 'program.authored');
  assert.equal(e.until, 'AU');
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
});

test('plan/0: program.authored and the six flips have reserved draft defs (x-state reserved), named by draft, never def', () => {
  for (const id of ['program.authored', ...FLIPS]) {
    const e = PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === id);
    // (a later 7c slice's flip, supported with its def, is that slice's test: BF's bf.test.mjs)
    if (e.state === 'supported') continue;
    assert.equal(e.def, undefined, `${id}: a def would make the part strict-checked`);
    assert.equal(e.draft, `#/$defs/${id}`, id);
    assert.equal(PLAN_SCHEMA.$defs[id]['x-state'], 'reserved', id);
    if (e.id !== 'program.authored' && e.id !== 'channel.aqueduct') assert.ok(PLAN_SCHEMA.$defs[id].properties.kind.const, id);
    if (golden.entries.find((x) => x.id === id).state === 'reserved') assert.ok(e.until, id);
  }
  assert.deepEqual(PLAN_SCHEMA.$defs['form.hidden_room'].properties.entrance.enum, ['bookshelf', 'trapdoor', 'waterfall', 'wall']);
});

test('planCatalogueKinds: the named kinds in catalogue order, full entries plus def, unknown ids sorted; a fresh copy', () => {
  const r = planCatalogueKinds(['form.crater', 'zz.x', 'connector.wall', 'aa.y', 'form.brush']);
  const all = planCatalogue();
  for (const k of ['catalogueVersion', 'api', 'kitVersion', 'schemaVersion']) assert.equal(r[k], all[k]);
  assert.deepEqual(r.entries.map((e) => e.id), ['connector.wall', 'form.brush', 'form.crater']);
  assert.deepEqual(r.unknown, ['aa.y', 'zz.x']);
  const wall = r.entries[0];
  const { def, ...entry } = wall;
  assert.deepEqual(entry, all.entries.find((e) => e.id === 'connector.wall'));
  assert.deepEqual(def, PLAN_SCHEMA.$defs['connector.wall']);
  assert.ok(typeof def.description === 'string' && def.description.length > 0, 'the def keeps its descriptions');
  assert.equal(r.entries[1].def, undefined, 'a reserved kind with neither def nor draft');
  // (form.crater: BF's supported def; the draft was 7cF's)
  assert.deepEqual(r.entries[2].def, PLAN_SCHEMA.$defs[PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === 'form.crater').def?.slice(8) ?? 'form.crater']);
  def.scribble = 1;
  assert.equal(PLAN_SCHEMA.$defs['connector.wall'].scribble, undefined);
  assert.deepEqual(planCatalogueKinds([]), { ...planCatalogueKinds(undefined) });
  assert.equal(planCatalogueKinds([]).entries.length, 0);
});
