// tools/lib/bench-select.mjs: the judged benches out of the release path (docs/GATES.md "Benches out of the release path"). The
// release's bench rule (reuse the latest nightly PASS while nothing the bench measures changed, else run it), megaB's nightly walk,
// and reading the nightly records. Pure functions over records; the nightly root is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchConf, decideBench, fullBenches, latestNightlyRecords, megaBVariant, newestOf, releaseBenches, sensitiveHits } from '../../tools/lib/bench-select.mjs';
import { fullTwins, judgedBenches, supersededList } from '../../tools/lib/step-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'gate-cache.json'), 'utf8'));
const CHAINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'gate-chains.json'), 'utf8'));
const BC = benchConf(CONF);
const P = 'mod/src/main/java/dev/larattalabs/architect/';
const pass = (id, extra = {}) => ({ id, status: 'PASS', date: '2026-10-23', head: 'abc1234def', run: '/n/run', key: 'k1', ...extra });
const megaB = { bench: 'megaB', ids: ['6a-megaB', '6a-megaB-fast'] };
const megaA = { bench: '6a-megaA', ids: ['6a-megaA'] };

test('the config: the judged benches, heap nightly only, the scenarios judged in the nightly, megaB weekly', () => {
  assert.deepEqual([...BC.judged].sort(), ['4e-megalite', '6a-heap', '6a-megaA', '6a-megaB', '6a-megaB-fast', '6b-volume']);
  assert.deepEqual([...judgedBenches(CONF)].sort(), [...BC.judged].sort());
  assert.deepEqual([...BC.nightlyOnly], ['6a-heap']);
  assert.deepEqual([...BC.nightlyJudged].sort(), ['6b-scenario-s1', '6c-scenario-s2', '6c-scenario-s3']);
  assert.equal(BC.megaB.full, '6a-megaB');
  assert.equal(BC.megaB.fast, '6a-megaB-fast');
  assert.deepEqual(releaseBenches(BC).map((b) => b.bench), ['4e-megalite', '6a-megaA', 'megaB', '6a-heap', '6b-volume']);
  // every named bench is a step, and none is in the release tier's lists (they are decided by the bench rule only)
  const r = CHAINS.tiers.release;
  const listed = new Set([...r.always, ...r.rotate.flatMap((x) => [...x.options.flat(), ...(x.when?.steps ?? [])])]);
  for (const id of [...BC.judged, ...BC.nightlyJudged]) assert.ok(CHAINS.steps[id], id);
  for (const id of BC.judged) assert.ok(!listed.has(id), `${id} is still in the release tier's lists`);
  // mega-lite is a judged bench (its tick bars judged in the nightly); the folded throughput steps: no longer benches, timing recorded
  assert.ok(CHAINS.steps['4e-megalite'].resources.includes('bench'));
  assert.equal(CHAINS.steps['4e-megalite'].timing, undefined);
  for (const id of ['4e-throughput', '4e-throughput-smoke']) {
    assert.ok(!(CHAINS.steps[id].resources ?? []).includes('bench'), id);
    assert.equal(CHAINS.steps[id].timing, 'recorded', id);
    assert.ok(!listed.has(id), `${id} is still in the release tier's lists`);
  }
  // 6a-resume: an ordinary step at release, dropped next to either megaB walk
  assert.ok(r.always.includes('6a-resume'));
  assert.ok(!(CHAINS.steps['6a-resume'].resources ?? []).includes('bench'));
  assert.deepEqual(supersededList(CHAINS.steps['6a-resume']), ['6a-megaB', '6a-megaB-fast']);
  assert.ok(fullTwins(CHAINS).has('6a-megaB') && fullTwins(CHAINS).has('6a-megaB-fast'));
});

test('the bench-sensitive paths: the placement core re-runs the mega benches, not volume; the volume survey re-runs volume only', () => {
  const core = sensitiveHits(BC, ['6a-megaA'], [`${P}site/Placement.java`, 'docs/GATES.md']);
  assert.deepEqual(core, [{ group: 'placement core', files: [`${P}site/Placement.java`] }]);
  assert.deepEqual(sensitiveHits(BC, ['6b-volume'], [`${P}site/Placement.java`]), []);
  assert.equal(sensitiveHits(BC, ['6b-volume'], [`${P}region/volume/VolumeSurvey.java`])[0].group, 'volume survey');
  assert.equal(sensitiveHits(BC, ['6a-megaA'], [`${P}batch/QBatch.java`])[0].group, 'block-write queue');
  assert.equal(sensitiveHits(BC, ['4e-megalite'], [`${P}batch/QBatch.java`])[0].group, 'block-write queue');
  assert.deepEqual(sensitiveHits(BC, ['4e-megalite'], [`${P}region/TileStream.java`]), []);
  assert.equal(sensitiveHits(BC, megaB.ids, ['sidecar/src/regionpool.ts'])[0].group, 'sidecar tile path');
  assert.equal(sensitiveHits(BC, ['6b-volume'], [`${P}mixin/LevelTicksMixin.java`])[0].group, 'scheduler');
  assert.deepEqual(sensitiveHits(BC, ['6a-megaA'], ['docs/GATES.md', 'kit/lib/forms/states.mjs']), []);
});

test('the release reuses the latest nightly PASS when nothing the bench measures changed', () => {
  // valid as a thunk (the runner's): asked only once nothing else decided
  let asked = 0;
  const d = decideBench(BC, { ...megaA, latest: pass('6a-megaA'), valid: () => (asked++, { ok: true, why: 'key unchanged' }), changed: ['docs/GATES.md'] });
  assert.equal(asked, 1);
  assert.equal(decideBench(BC, { ...megaA, latest: pass('6a-megaA'), valid: () => (asked++, { ok: true, why: '' }), changed: [`${P}site/Placement.java`] }).run, true);
  assert.equal(asked, 1, 'a sensitive change decides before the entry is checked');
  assert.equal(d.run, false);
  assert.equal(d.reuse.date, '2026-10-23');
  assert.match(d.why, /^reused: 6a-megaA PASS in the nightly of 2026-10-23 \(head abc1234de\)/);
});

test('the release runs a bench, with the reason, when it cannot reuse', () => {
  const cases = [
    [{ latest: null, valid: null, changed: null }, /no nightly has run it yet/],
    [{ latest: pass('6a-megaA', { status: 'FAIL' }), valid: null, changed: [] }, /latest nightly result is FAIL .*only a PASS is reused/],
    [{ latest: pass('6a-megaA'), valid: { ok: true, why: '' }, changed: null }, /files changed since .* are unknown/],
    [{ latest: pass('6a-megaA'), valid: { ok: true, why: '' }, changed: [`${P}site/Placement.java`] }, /bench-sensitive code changed since the nightly of 2026-10-23 .*: placement core \(.*Placement\.java\)/],
    [{ latest: pass('6a-megaA'), valid: null, changed: [] }, /no step-cache entry for its PASS/],
    [{ latest: pass('6a-megaA'), valid: { ok: false, why: 'a file its coverage holds changed' }, changed: [`${P}region/Heights.java`] }, /the code it measures changed since .*: a file its coverage holds changed/],
  ];
  for (const [x, re] of cases) {
    const d = decideBench(BC, { ...megaA, ...x });
    assert.equal(d.run, true, re.source);
    assert.equal(d.step, '6a-megaA');
    assert.match(d.why, re);
  }
  assert.match(decideBench(BC, { ...megaA, latest: pass('6a-megaA'), valid: { ok: true, why: '' }, changed: [], noReuse: true }).why, /--no-cache/);
  // the sensitive rule wins even when the key still holds (the paths are a guard on top of the coverage)
  assert.equal(decideBench(BC, { ...megaA, latest: pass('6a-megaA'), valid: { ok: true, why: '' }, changed: [`${P}batch/QBatch.java`] }).run, true);
});

test('megaB at release: the full walk when its sensitive core changed, else the fast walk; reused from whichever walk ran last', () => {
  const full = decideBench(BC, { ...megaB, latest: pass('6a-megaB-fast'), valid: { ok: true, why: '' }, changed: [`${P}site/TickDeferral.java`] });
  assert.deepEqual([full.run, full.step], [true, '6a-megaB']);
  const fast = decideBench(BC, { ...megaB, latest: pass('6a-megaB-fast'), valid: { ok: false, why: 'x' }, changed: [`${P}region/Heights.java`] });
  assert.deepEqual([fast.run, fast.step], [true, '6a-megaB-fast']);
  const reuse = decideBench(BC, { ...megaB, latest: pass('6a-megaB'), valid: { ok: true, why: '' }, changed: [] });
  assert.deepEqual([reuse.run, reuse.step], [false, '6a-megaB']);
  const recs = new Map([['6a-megaB', pass('6a-megaB', { date: '2026-10-18' })], ['6a-megaB-fast', pass('6a-megaB-fast', { date: '2026-10-22' })]]);
  assert.equal(newestOf(recs, megaB.ids).id, '6a-megaB-fast');
});

test('6a-heap is nightly only: never run at release, its last nightly shown', () => {
  const d = decideBench(BC, { bench: '6a-heap', ids: ['6a-heap'], latest: pass('6a-heap', { status: 'FAIL' }), valid: null, changed: [`${P}site/Placement.java`] });
  assert.equal(d.run, false);
  assert.equal(d.nightlyOnly, true);
  assert.match(d.why, /nightly only; last judged in the nightly of 2026-10-23 .*: FAIL/);
});

test('the nightly: megaB full weekly, on demand, first time, and when the sensitive core changed since the last full walk; else fast', () => {
  const sun = new Date(2026, 9, 25, 2, 0); // a Sunday, 02:00 local
  const tue = new Date(2026, 9, 27, 2, 0);
  const last = { head: 'f00dfeed00' };
  assert.equal(megaBVariant(BC, { date: sun, lastFull: last, changedSinceFull: [] }).id, '6a-megaB');
  assert.match(megaBVariant(BC, { date: sun, lastFull: last, changedSinceFull: [] }).why, /weekly/);
  assert.equal(megaBVariant(BC, { date: tue, onDemand: true, lastFull: last, changedSinceFull: [] }).id, '6a-megaB');
  assert.equal(megaBVariant(BC, { date: tue, lastFull: null }).id, '6a-megaB');
  // the last full walk failed: the next nightly runs it again (not a week later)
  assert.match(megaBVariant(BC, { date: tue, lastFull: { ...last, status: 'FAIL', date: '2026-10-25' }, changedSinceFull: [] }).why, /last full walk .* ended FAIL/);
  assert.equal(megaBVariant(BC, { date: tue, lastFull: { ...last, status: 'PASS' }, changedSinceFull: [] }).id, '6a-megaB-fast');
  assert.equal(megaBVariant(BC, { date: tue, lastFull: last, changedSinceFull: null }).id, '6a-megaB');
  assert.equal(megaBVariant(BC, { date: tue, lastFull: last, changedSinceFull: [`${P}site/PlaceJob.java`] }).id, '6a-megaB');
  assert.equal(megaBVariant(BC, { date: tue, lastFull: last, changedSinceFull: ['kit/lib/forms/states.mjs', `${P}region/volume/VolumeSurvey.java`] }).id, '6a-megaB-fast');
  const n = fullBenches(BC, { nightly: true, variant: { id: '6a-megaB-fast', why: 'fast' } });
  assert.deepEqual(n.ids, ['4e-megalite', '6a-megaA', '6a-megaB-fast', '6a-heap', '6b-volume']);
  // a release --full that is not the nightly (by hand or the auto rule): every judged bench but heap (nightly only), megaB's full walk
  assert.deepEqual(fullBenches(BC, { nightly: false }).ids, ['4e-megalite', '6a-megaA', '6a-megaB', '6b-volume']);
});

test('the nightly records: the newest nightly result of each bench, finished or stopped; a yielded or running step does not count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-benches-'));
  const night = (date, state, steps, head) => {
    const run = path.join(root, `run-${date}`);
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ head, steps }));
    fs.mkdirSync(path.join(root, date), { recursive: true });
    fs.writeFileSync(path.join(root, date, 'summary.json'), JSON.stringify({ date, state, head, startedAt: `${date}T02:00:00Z`, runs: [run] }));
  };
  night('2026-10-20', 'done', [{ id: '6a-megaA', status: 'PASS', cache: { key: 'a1', recorded: true } }, { id: '6a-megaB', status: 'PASS', cache: { key: 'b1' } }], 'h20');
  // stopped after megaA failed: the FAIL still counts (an older PASS is never reused past it)
  night('2026-10-21', 'stopped', [{ id: '6a-megaA', status: 'FAIL' }, { id: '6a-megaB-fast', status: 'SKIPPED', error: 'yielded' }], 'h21');
  // running: a finished step counts, a running or pending one does not
  night('2026-10-22', 'running', [{ id: '6a-megaA', status: 'RUNNING' }, { id: '6b-volume', status: 'PASS', cache: { key: 'v1' } }, { id: '6a-heap', status: 'PENDING' }], 'h22');
  const r = latestNightlyRecords(root, ['6a-megaA', '6a-megaB', '6a-megaB-fast', '6b-volume', '6a-heap']);
  assert.deepEqual([r.get('6a-megaA').status, r.get('6a-megaA').date, r.get('6a-megaA').head], ['FAIL', '2026-10-21', 'h21']);
  assert.deepEqual([r.get('6a-megaB').status, r.get('6a-megaB').key], ['PASS', 'b1']);
  assert.equal(r.has('6a-megaB-fast'), false, 'a yielded step never ran');
  assert.deepEqual([r.get('6b-volume').status, r.get('6b-volume').date], ['PASS', '2026-10-22']);
  assert.equal(r.has('6a-heap'), false, 'a pending step has no result');
  assert.equal(decideBench(BC, { ...megaA, latest: r.get('6a-megaA'), valid: null, changed: [] }).run, true);
  fs.rmSync(root, { recursive: true });
});
