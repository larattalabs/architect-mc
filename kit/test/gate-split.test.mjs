// Split steps (tools/lib/step-split.mjs, tools/lib/gate-part.mjs; docs/GATES.md "Turbo"): a split parent expands into parts that
// together run every section exactly once, and the config's splits are well formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateProblems, entryOf, expandSplits, parentResults, partEntryOf, planOrder, resultOf, sectionsOf, validateSplits } from '../../tools/lib/step-split.mjs';
import { gatePart } from '../../tools/lib/gate-part.mjs';
import { IRR_SECTIONS } from '../../tools/lib/gate6cirr-game.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHAINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'gate-chains.json'), 'utf8'));

const steps = {
  a: { shell: 'node tools/x.mjs a', env: { X_OUT: '${OUT}/x' }, estMin: 12, timeoutMin: 60, client: '6b',
    split: { env: { X_OUT: '${OUT}/x/${PART}' }, parts: [{ env: { GATE_PART_SECTIONS: 's1,s2' }, estMin: 5 }, { env: { GATE_PART_SECTIONS: 's3' } }] } },
  b: { shell: 'node tools/y.mjs', waitFor: ['a', 'c'], client: 'none' },
  c: { shell: 'node tools/z.mjs', client: 'none' },
};

test('expandSplits: a parent becomes its parts in its place; waitFor on the parent waits for every part', () => {
  const x = expandSplits(steps, ['c', 'a', 'b']);
  assert.deepEqual(x.ids, ['c', 'a/p1', 'a/p2', 'b']);
  assert.deepEqual(x.parts, { a: ['a/p1', 'a/p2'] });
  assert.deepEqual(x.defs.b.waitFor, ['a/p1', 'a/p2', 'c']);
  const p1 = x.defs['a/p1'];
  assert.equal(p1.parentId, 'a');
  assert.equal(p1.shell, steps.a.shell);
  assert.equal(p1.env.X_OUT, '${OUT}/x/p1', 'the split env overrides the step env, ${PART} filled in');
  assert.equal(p1.env.GATE_PART, '1/2');
  assert.equal(p1.env.GATE_PART_SECTIONS, 's1,s2');
  assert.equal(p1.env.GATE_PART_ALL, 's1,s2,s3');
  assert.equal(p1.estMin, 5);
  assert.equal(x.defs['a/p2'].estMin, 6, 'a part without estMin gets its share of the parent\'s');
  assert.equal(p1.split, undefined, 'a part is not split again');
});

test('entryOf: part ids resolve through their parent (history definitions, --only)', () => {
  assert.equal(entryOf({ steps }, 'c'), steps.c);
  assert.equal(entryOf({ steps }, 'a/p2').env.GATE_PART_SECTIONS, 's3');
  assert.equal(entryOf({ steps }, 'a/p3'), null);
  assert.equal(entryOf({ steps }, 'c/p1'), null);
});

test('validateSplits: the config rules', () => {
  assert.deepEqual(validateSplits(steps), []);
  const bad = (s) => validateSplits({ ...steps, ...s });
  assert.match(bad({ d: { split: { parts: [{ env: { A: 1 } }] } } }).join(), /at least 2 parts/);
  assert.match(bad({ d: { split: { parts: [{ env: {} }, { env: { A: 1 } }] } } }).join(), /neither env/);
  assert.match(bad({ d: { split: { parts: [{ env: { GATE_PART_SECTIONS: 'x,y' } }, { env: { GATE_PART_SECTIONS: 'y' } }] } } }).join(), /more than one part: y/);
  assert.match(bad({ d: { split: { parts: [{ env: { GATE_PART_SECTIONS: 'x' } }, { env: { OTHER: '1' } }] } } }).join(), /every part of a sectioned split/);
  assert.match(bad({ e: { after: 'a' } }).join(), /e is `after` a/);
});

test('gatePart: unset runs everything; set runs its sections; a split that leaves one out or names an unknown one throws', () => {
  const all = ['s1', 's2', 's3'];
  const quiet = { log: () => {} };
  assert.deepEqual(gatePart(all, { env: {}, ...quiet }).sections, all);
  assert.deepEqual(gatePart(all, { env: {}, legacy: ['s2'], ...quiet }).sections, ['s2'], 'the driver\'s own development filter as before');
  const p = gatePart(all, { env: { GATE_PART: '1/2', GATE_PART_SECTIONS: 's1,s3', GATE_PART_ALL: 's1,s3,s2' }, ...quiet });
  assert.deepEqual(p.sections, ['s1', 's3']);
  assert.equal(p.want('s2'), false);
  assert.throws(() => gatePart(all, { env: { GATE_PART_SECTIONS: 's1', GATE_PART_ALL: 's1,s2' }, ...quiet }), /leave out section\(s\) s3/);
  assert.throws(() => gatePart(all, { env: { GATE_PART_SECTIONS: 's1', GATE_PART_ALL: 's1,s2,s3,s4' }, ...quiet }), /unknown section\(s\) s4/);
  assert.throws(() => gatePart(all, { env: { GATE_PART_SECTIONS: 's1' }, ...quiet }), /GATE_PART_ALL unset/);
});

test('parentResults: the worst status, the parts summed, the wall from first start to last end', () => {
  const rows = [
    { id: 'a/p1', status: 'PASS', seconds: 60, startedAt: '2026-10-22T10:00:00Z', ok: 3, fail: 0, log: 'a.p1.log' },
    { id: 'a/p2', status: 'FAIL', seconds: 120, startedAt: '2026-10-22T10:00:30Z', ok: 2, fail: 1, log: 'a.p2.log' },
  ];
  assert.deepEqual(parentResults({ a: ['a/p1', 'a/p2'] }, rows).a, { parts: ['a/p1', 'a/p2'], status: 'FAIL', stepSeconds: 180, wallSeconds: 150, ok: 5, fail: 1 });
});

test('the config: every split is valid; sectioned splits name each section once; shell splits run every command of the whole step', () => {
  assert.deepEqual(validateSplits(CHAINS.steps), []);
  const split = Object.entries(CHAINS.steps).filter(([, s]) => s.split);
  assert.ok(split.length >= 8, `${split.length} split steps`);
  const cmds = (sh) => new Set((sh.match(/node tools\/[\w./-]+\.mjs[^;|&]*/g) ?? []).map((c) => c.trim()));
  for (const [id, s] of split) {
    const secs = sectionsOf(s.split);
    if (secs.length) {
      assert.equal(new Set(secs).size, secs.length, `${id}: a section in two parts`);
      continue;
    }
    // a shell split: the union of the parts' commands is the whole step's
    const whole = cmds(s.shell);
    const union = new Set(s.split.parts.flatMap((p) => [...cmds(partEntryOf(s, s.split.parts.indexOf(p) + 1).shell)]));
    assert.deepEqual([...union].sort(), [...whole].sort(), `${id}: the parts' commands together are the whole step's`);
  }
  // the irr driver's sections are exactly the split's (the drivers also check this at run time: GATE_PART_ALL)
  for (const id of ['irr-ingame', 'irr-ingame-smoke']) assert.deepEqual([...sectionsOf(CHAINS.steps[id].split)].sort(), [...IRR_SECTIONS].sort(), id);
});

// ---- no vacuous PASS (2026-10-23: artifacts/gate-runs/20261023-012515-slice reported rs-survival-smoke, h-ingame-smoke,
// hy-ingame-smoke, s3-unit and 4d-all PASS with 0 s and 0 ok/0 FAIL: the cache lookup's plan order held no part ids)

const CHAIN_ORDER = Object.keys(steps); // what gate-run's ORDER is: the chain file's step ids, parents only

test('planOrder: the cache lookup keeps a split parent\'s parts in the plan (main dropped them)', () => {
  const x = expandSplits(steps, ['a', 'b', 'c']);
  const all = { ...steps, ...x.defs };
  const run = new Set(['a/p1', 'a/p2', 'b', 'c']);
  // the old line, stepIds = ORDER.filter((s) => run.has(s)): every part gone, nothing said
  assert.deepEqual(CHAIN_ORDER.filter((s) => run.has(s)), ['b', 'c']);
  const p = planOrder(CHAIN_ORDER, all, run, true);
  assert.deepEqual(p.ids, ['a/p1', 'a/p2', 'b', 'c']);
  assert.deepEqual(p.lost, []);
  // one part cached, the other runs: only the runner is planned, nothing lost
  assert.deepEqual(planOrder(CHAIN_ORDER, all, new Set(['a/p2', 'c']), true), { ids: ['a/p2', 'c'], lost: [] });
  // a run that doesn't split: a stray part id is reported lost, never silently dropped
  assert.deepEqual(planOrder(CHAIN_ORDER, all, new Set(['a/p1', 'c']), false).lost, ['a/p1']);
});

test('parentResults: parts missing from the run make the parent ERROR, never PASS over nothing (the 20261023-012515 shape)', () => {
  const rows = [{ id: 'unit-mod', status: 'PASS', seconds: 60, ok: 0, fail: 0, log: 'unit-mod.log' }];
  const r = parentResults({ 's3-unit': ['s3-unit/p1', 's3-unit/p2', 's3-unit/p3'], '4d-all': ['4d-all/p1', '4d-all/p2'] }, rows, []);
  assert.equal(r['s3-unit'].status, 'ERROR');
  assert.deepEqual(r['s3-unit'].missing, ['s3-unit/p1', 's3-unit/p2', 's3-unit/p3']);
  assert.match(r['s3-unit'].problems[0], /parts missing/);
  assert.equal(r['4d-all'].status, 'ERROR');
  // one part of two missing: still ERROR, though the other passed
  const half = parentResults({ a: ['a/p1', 'a/p2'] }, [{ id: 'a/p1', status: 'PASS', seconds: 5, ok: 4, fail: 0, log: 'a.p1.log' }]);
  assert.equal(half.a.status, 'ERROR');
  assert.deepEqual(half.a.missing, ['a/p2']);
  assert.equal(half.a.ok, 4);
  // a parent with no parts at all
  assert.equal(parentResults({ a: [] }, []).a.status, 'ERROR');
});

test('parentResults: a PASS needs its log; a CACHED part needs its evidence; ok/FAIL are the parts\' sums', () => {
  const ok = (id, n) => ({ id, status: 'PASS', seconds: 10, startedAt: '2026-10-23T10:00:00Z', ok: n, fail: 0, log: `${id.replace('/', '.')}.log` });
  const both = parentResults({ a: ['a/p1', 'a/p2'] }, [ok('a/p1', 3), ok('a/p2', 4)]);
  assert.equal(both.a.status, 'PASS');
  assert.equal(both.a.ok, 7);
  assert.equal(both.a.fail, 0);
  assert.equal(parentResults({ a: ['a/p1', 'a/p2'] }, [ok('a/p1', 3), { ...ok('a/p2', 4), log: undefined }]).a.status, 'ERROR');
  const onDisk = new Set(['a.p1.log']);
  const gone = parentResults({ a: ['a/p1', 'a/p2'] }, [ok('a/p1', 3), ok('a/p2', 4)], [], { logExists: (l) => onDisk.has(l) });
  assert.equal(gone.a.status, 'ERROR');
  assert.match(gone.a.problems.join(), /a\.p2\.log is not on disk/);
  const hit = { id: 'a/p2', key: 'k', at: '2026-10-22T00:00:00Z', log: '/runs/x/a.p2.log' };
  const mixed = parentResults({ a: ['a/p1', 'a/p2'] }, [ok('a/p1', 3)], [hit]);
  assert.equal(mixed.a.status, 'PASS');
  assert.deepEqual(mixed.a.cached, ['a/p2']);
  assert.equal(parentResults({ a: ['a/p1', 'a/p2'] }, [], [hit, { ...hit, id: 'a/p1' }]).a.status, 'CACHED');
  assert.equal(parentResults({ a: ['a/p1', 'a/p2'] }, [ok('a/p1', 3)], [{ id: 'a/p2', key: 'k' }]).a.status, 'ERROR', 'a cache hit without an evidence pointer');
});

test('aggregateProblems: split parents, supersededBy drops and canaries rest on real results; an empty run is not a PASS', () => {
  const row = (id, status = 'PASS') => ({ id, status, log: `${id}.log` });
  const rows = [row('b'), row('c')];
  // the 20261023-012515 summary: the steps all PASS, the split parents over nothing -> problems (the run fails)
  const split = parentResults({ a: ['a/p1', 'a/p2'] }, rows);
  assert.match(aggregateProblems({ rows, splitResults: split }).join(), /split a: ERROR \(parts missing: a\/p1, a\/p2/);
  assert.deepEqual(aggregateProblems({ rows, splitResults: parentResults({ a: ['a/p1'] }, [...rows, row('a/p1')]) }), []);
  // supersededBy: the step kept must have a result (run, CACHED or its split parts)
  assert.match(aggregateProblems({ rows, superseded: { 'x-flat': 'x' } }).join(), /x-flat was dropped for x, which has no result/);
  assert.match(aggregateProblems({ rows: [...rows, row('x', 'FAIL')], superseded: { 'x-flat': 'x' } }).join(), /which is FAIL/);
  assert.deepEqual(aggregateProblems({ rows: [...rows, row('x')], superseded: { 'x-flat': 'x' } }), []);
  assert.deepEqual(aggregateProblems({ rows, cached: [{ id: 'x', log: 'l' }], superseded: { 'x-flat': 'x' } }), []);
  assert.match(aggregateProblems({ rows, superseded: { 'x-flat': 'a' }, splitResults: split }).join(), /x-flat was dropped for a, which is ERROR/);
  // canaries run and PASS: never CACHED, never absent
  assert.match(aggregateProblems({ rows, canaries: ['probe'] }).join(), /canary probe: no result/);
  assert.match(aggregateProblems({ rows, cached: [{ id: 'probe', log: 'l' }], canaries: ['probe'] }).join(), /canary probe/);
  assert.deepEqual(aggregateProblems({ rows: [...rows, row('probe')], canaries: ['probe'] }), []);
  assert.deepEqual(aggregateProblems({ rows: [...rows, row('a/p1'), row('a/p2')], splitResults: parentResults({ a: ['a/p1', 'a/p2'] }, [row('a/p1'), row('a/p2')]), canaries: ['a'] }), []);
  // nothing ran and nothing was cached
  assert.match(aggregateProblems({ rows: [], cached: [] }).join(), /nothing to pass/);
  assert.deepEqual(aggregateProblems({ rows: [], cached: [{ id: 'b', log: 'l' }] }), []);
  assert.equal(resultOf('nope', { rows }), null);
});

test('parentResults/aggregateProblems: a run of fewer parts than configured is PARTIAL, never the parent\'s PASS', () => {
  const row = (id) => ({ id, status: 'PASS', ok: 2, fail: 0, log: `${id}.log` });
  const r = parentResults({ a: ['a/p1'] }, [row('a/p1')], [], { total: { a: 2 } });
  assert.equal(r.a.status, 'PARTIAL');
  assert.equal(r.a.partial, '1 of 2 parts');
  assert.match(aggregateProblems({ rows: [row('a/p1')], splitResults: r }).join(), /split a: PARTIAL/);
  assert.deepEqual(aggregateProblems({ rows: [row('a/p1')], splitResults: r, partialOk: true }), [], '--only a/p1 certifies the part only');
  assert.equal(parentResults({ a: ['a/p1', 'a/p2'] }, [row('a/p1'), row('a/p2')], [], { total: { a: 2 } }).a.status, 'PASS');
  // a superseded step that ran itself (--only names it) stands on its own row
  assert.deepEqual(aggregateProblems({ rows: [row('x-flat')], superseded: { 'x-flat': 'x' } }), []);
});
