// Split steps (tools/lib/step-split.mjs, tools/lib/gate-part.mjs; docs/GATES.md "Turbo"): a split parent expands into parts that
// together run every section exactly once, and the config's splits are well formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryOf, expandSplits, parentResults, partEntryOf, sectionsOf, validateSplits } from '../../tools/lib/step-split.mjs';
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
    { id: 'a/p1', status: 'PASS', seconds: 60, startedAt: '2026-10-22T10:00:00Z', ok: 3, fail: 0 },
    { id: 'a/p2', status: 'FAIL', seconds: 120, startedAt: '2026-10-22T10:00:30Z', ok: 2, fail: 1 },
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
