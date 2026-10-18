// tools/lib/gate-history.mjs: the history timeout of a step counts only the samples taken under its current definition (PLAN
// "History timeouts for young steps"): a changed driver or chain entry starts over from the configured timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobId, currentHistory, definitionNow, definitionsAt, driverPaths, effectiveTimeout, pct, stepDefinition } from '../../tools/lib/gate-history.mjs';

const entry = { desc: 'T3a in game', shell: 'node tools/gate6b.mjs base && node tools/gate6ct3a.mjs ingame', env: { X: '1' }, timeoutMin: 60, client: '6b', host: 'server', estMin: 12 };
const blobs = { 'tools/gate6b.mjs': 'a1', 'tools/gate6ct3a.mjs': 'b1' };
const def = (e, b = blobs) => stepDefinition(e, (p) => b[p] ?? null);

/** A history whose samples of `id` came from these heads with these seconds, newest first. */
function hist(id, rows) {
  const samples = rows.map(([head, s], i) => ({ at: `2026-10-18T${String(23 - i).padStart(2, '0')}:00:00Z`, s, ...(head ? { head } : {}) }));
  const v = samples.map((x) => x.s).sort((a, b) => a - b);
  return { runs: rows.length, steps: { [id]: { n: v.length, p50: pct(v, 50), p90: pct(v, 90), max: v[v.length - 1], samples } } };
}

test('driverPaths: the tools files a shell names, once each, sorted', () => {
  assert.deepEqual(driverPaths(entry), ['tools/gate6b.mjs', 'tools/gate6ct3a.mjs']);
  assert.deepEqual(driverPaths({ shell: 'rc=0; node tools/gate6cb.mjs unit || rc=1; node tools/gate6cb.mjs stale; bash tools/run-gate6b-client.sh' }), ['tools/gate6cb.mjs', 'tools/run-gate6b-client.sh']);
  assert.deepEqual(driverPaths({ shell: './gradlew build' }), []);
});

test('stepDefinition: the entry and its drivers count; desc, estMin and timeoutMin do not', () => {
  const d0 = def(entry);
  assert.equal(def({ ...entry, desc: 'reworded', estMin: 3, timeoutMin: 90 }), d0);
  assert.equal(def({ env: entry.env, host: 'server', client: '6b', shell: entry.shell }), d0, 'key order does not matter');
  assert.notEqual(def({ ...entry, host: 'client' }), d0, 'a step moved to another host is a new definition');
  assert.notEqual(def({ ...entry, shell: `${entry.shell} && node tools/gate6ct3a.mjs report` }), d0);
  assert.notEqual(def({ ...entry, env: { X: '2' } }), d0);
  assert.notEqual(def(entry, { ...blobs, 'tools/gate6ct3a.mjs': 'b2' }), d0, 'a changed driver file');
  assert.equal(def(undefined), null);
});

test('a young definition keeps the configured timeout until it has 5 samples of its own', () => {
  const step = { id: 't3a-ingame', timeoutMin: 60 };
  const cur = 'new';
  const defAt = (head) => ({ h1: 'old', h2: 'old', h3: 'new', h4: 'new', h5: 'new', h6: 'new', h7: 'new' })[head] ?? null;
  // eighteen fast samples of the old definition and two of the new one: the raw history caps t3a at the 10-minute floor
  const young = hist(step.id, [['h3', 400], ['h4', 420], ...Array.from({ length: 18 }, (_, i) => [i % 2 ? 'h1' : 'h2', 110 + i])]);
  assert.equal(effectiveTimeout(step, young).min, 10, 'the raw history: max(2 x p90, 10) = 10 min');
  const t = effectiveTimeout(step, currentHistory(step.id, young, cur, defAt));
  assert.equal(t.min, 60);
  assert.match(t.source, /^configured \(history: 2 sample\(s\) of its current definition \(18 older dropped\), needs 5\)$/);
  // five of the new definition: its own p90 (420 s -> 2 x 7 = 14 min) sets it
  const grown = hist(step.id, [['h3', 400], ['h4', 420], ['h5', 380], ['h6', 410], ['h7', 390], ['h1', 120], ['h2', 110]]);
  const g = effectiveTimeout(step, currentHistory(step.id, grown, cur, defAt));
  assert.equal(g.min, 14);
  assert.match(g.source, /^history: max\(2x p90 7\.0 min of 5 of its current definition, 10 min floor\), cap 60$/);
});

test('samples with no head, or a head git does not know, never count toward the timeout', () => {
  const step = { id: 's', timeoutMin: 30 };
  const h = hist('s', [[null, 60], ['gone', 60], [null, 60], ['gone', 60], [null, 60], ['ok', 60]]);
  const c = currentHistory('s', h, 'd', (head) => (head === 'ok' ? 'd' : null));
  assert.equal(c.steps.s.n, 1);
  assert.equal(c.steps.s.dropped, 5);
  assert.equal(effectiveTimeout(step, c).min, 30);
  // the estimate's history is untouched; a step with no history, or no current definition, passes through
  assert.equal(h.steps.s.n, 6);
  assert.equal(currentHistory('other', h, 'd', () => 'd'), h);
  assert.equal(currentHistory('s', h, null, () => 'd'), h);
});

test('definitionsAt and definitionNow agree through git: a driver edit is a new definition', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    g('init', '-q');
    g('config', 'user.email', 't@example.invalid');
    g('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'tools'));
    const chains = { steps: { s: { shell: 'node tools/drv.mjs go', timeoutMin: 30, client: 'none' }, other: { shell: 'true', timeoutMin: 5, client: 'none' } } };
    fs.writeFileSync(path.join(dir, 'tools', 'gate-chains.json'), JSON.stringify(chains));
    fs.writeFileSync(path.join(dir, 'tools', 'drv.mjs'), 'console.log(1)\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    const h1 = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'tools', 'drv.mjs'), 'console.log(2)\n');
    g('commit', '-qam', 'two');
    const h2 = g('rev-parse', 'HEAD');
    const at = definitionsAt(dir);
    const now = definitionNow(dir, chains, 's');
    assert.equal(blobId(fs.readFileSync(path.join(dir, 'tools', 'drv.mjs'))), g('rev-parse', 'HEAD:tools/drv.mjs'));
    assert.equal(at(h2, 's'), now);
    assert.notEqual(at(h1, 's'), now);
    assert.equal(at(h1, 'other'), at(h2, 'other'), 'a step whose driver did not change keeps its definition');
    assert.equal(at('0000000000000000000000000000000000000000', 's'), null);
    assert.equal(at(h2, 'missing'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
