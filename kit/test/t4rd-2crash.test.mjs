// (slice T4R-D narrowing round, P2-4; row T4RDN-2crash-wait) T4RD-2crash's second crash counts only when it happened: the world's open was
// refused because the host has no server (not timed out, not opened), the host shows no server, and the recovery it interrupted is still
// open in txn.json on disk. Red at e1a7aad7: the row dropped the race's result and only logged `down`, so a timeout or a start that recovered
// without the second crash passed on the later owed/ground/open checks alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sc from '../../tools/lib/second-crash.mjs';

const { secondCrash, txnOpenOnDisk } = sc;
const POINT = 'TX:recover:removal.site:barrier:member';
const MARKER = 'dev-killed.json'; // DevStart.markKilled's file (T4RDLKillMarkerTest checks the Java side names it too)

const never = () => new Promise(() => {});
const now = async () => {};

test('T4RDN-2crash-wait: a timeout is a FAIL', async () => {
  const r = await secondCrash({ open: never, sleep: now, serverGone: async () => true, txnOpen: () => true, boundMs: 1 });
  assert.equal(r.down, false, `timed out: ${r.why}`);
  assert.match(r.why, /timed out/);
});

test('T4RDN-2crash-wait: a world that opened (no second crash) is a FAIL', async () => {
  const r = await secondCrash({ open: async () => {}, sleep: never, serverGone: async () => false, txnOpen: () => false, boundMs: 1 });
  assert.equal(r.down, false);
  assert.match(r.why, /opened/);
});

test('T4RDN-2crash-wait: a refused open with a server still there, or no txn left open, is a FAIL', async () => {
  const refused = async () => { throw new Error('the headless server exited'); };
  assert.equal((await secondCrash({ open: refused, sleep: never, serverGone: async () => false, txnOpen: () => true, boundMs: 1 })).down, false);
  assert.equal((await secondCrash({ open: refused, sleep: never, serverGone: async () => true, txnOpen: () => false, boundMs: 1 })).down, false);
});

test('T4RDN-2crash-wait: refused, no server, its recovery still open on disk, the start marker at its point: the second crash happened', async () => {
  const r = await secondCrash({ open: async () => { throw new Error('exited'); }, sleep: never, serverGone: async () => true, txnOpen: () => true,
    marker: () => POINT, point: POINT, boundMs: 1 });
  assert.equal(r.down, true, r.why);
});

test('T4RDL-2crash-marker: refused, no server, its recovery open, but no marker (or another point\'s): a FAIL', async () => {
  const refused = async () => { throw new Error('startup failed before recovery'); };
  for (const marker of [() => null, () => 'TX:removal.site:apply:1+save']) {
    const r = await secondCrash({ open: refused, sleep: never, serverGone: async () => true, txnOpen: () => true, marker, point: POINT, boundMs: 1 });
    assert.equal(r.down, false, `marker ${marker()}: ${r.why}`);
  }
});

test('T4RDL-2crash-marker: killMarker reads the point from <arch>/dev-killed.json', () => {
  assert.equal(sc.KILL_MARKER, MARKER, 'the same file name as DevStart.markKilled');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4rdl-marker-'));
  try {
    assert.equal(sc.killMarker(dir), null, 'absent');
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ point: POINT }));
    assert.equal(sc.killMarker(dir), POINT);
    fs.writeFileSync(path.join(dir, MARKER), '{ broken');
    assert.equal(sc.killMarker(dir), null, 'unreadable: not shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (slice T4R-D last round, P2; ported from the reviewer's node probe) The T4RD-2crash row's own branch, sliced out of gatetxncc.mjs and run
// against a modelled world start: the first crash's txn.json (a removal.site open), then the second open in four ways. Red at ae97e9da: a
// startup failure after dev-start.json was consumed but before the barrier left the same disk state and passed.
async function runBranch(mode) {
  const src = fs.readFileSync(new URL('../../tools/lib/gatetxncc.mjs', import.meta.url), 'utf8');
  const a = src.indexOf("        if (sub === '2crash') {", src.indexOf('// T4RD-2crash'));
  const b = src.indexOf('\n        await reopen();', a);
  assert.ok(a > 0 && b > a, 'the 2crash branch');
  const F = Object.getPrototypeOf(async function () {}).constructor;
  const run = new F('secondCrash', 'txnOpenOnDisk', 'killMarker', 'KILL_MARKER', 'L', 'W', 'path', 'serverGone', 'rowLog', 'name', 'sub', 'tag', 'check',
    'call', 'let down = true; for (let row = 0; row < 1; row++) {' + src.slice(a, b) + '} return down;');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4rdl-2crash-'));
  try {
    const arch = path.join(dir, 'architect');
    fs.mkdirSync(arch);
    fs.writeFileSync(path.join(arch, 'txn.json'), JSON.stringify({ format: 1, open: [{ id: 'tx-first-crash', kind: 'removal.site', phase: 'PREPARED_DONE' }], retiring: [] }));
    if (mode === 'stale marker, pre-barrier error') fs.writeFileSync(path.join(arch, MARKER), JSON.stringify({ point: POINT })); // an earlier row's
    const checks = [];
    const L = {
      sleep: mode === 'timeout' ? async () => {} : never,
      openWorld: mode === 'timeout' ? never : mode === 'opened' ? async () => {} : async () => {
        // DevStart.arm consumes dev-start.json at the start, before recovery
        const armed = JSON.parse(fs.readFileSync(path.join(arch, 'dev-start.json'), 'utf8'));
        fs.unlinkSync(path.join(arch, 'dev-start.json'));
        if (mode === 'at-barrier halt') {
          fs.writeFileSync(path.join(arch, MARKER), JSON.stringify({ point: armed.killAt })); // DevStart.markKilled, then the halt
          throw new Error('world did not open: the headless server exited');
        }
        throw new Error('startup failed before recovery');
      },
    };
    const down = await run(secondCrash, txnOpenOnDisk, sc.killMarker, sc.KILL_MARKER, L, { dir }, path, async () => mode !== 'opened', () => {}, 'world', '2crash',
      'T4RD-2crash', (ok, text) => checks.push({ ok: !!ok, text }), async () => ({}));
    return { down, checks };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [mode, want] of [['timeout', false], ['opened', false], ['pre-barrier startup error', false], ['stale marker, pre-barrier error', false],
  ['at-barrier halt', true]]) {
  test(`T4RDL-2crash-marker: the row's branch, ${mode}: ${want ? 'PASS' : 'FAIL'}`, async () => {
    const r = await runBranch(mode);
    const last = r.checks.at(-1);
    assert.ok(last, 'the branch checks its second crash');
    assert.equal(r.down, want, `${mode}: ${last.text}`);
    assert.equal(last.ok, want, `${mode}: the row's check is ${want ? 'a pass' : 'a FAIL'} (${last.text})`);
  });
}

test('T4RDN-2crash-wait: txnOpenOnDisk reads the open txns of a kind from txn.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4rdn-2crash-'));
  try {
    const f = path.join(dir, 'txn.json');
    assert.equal(txnOpenOnDisk(f, 'removal.site'), false, 'no file');
    fs.writeFileSync(f, JSON.stringify({ format: 1, open: [{ id: 'tx-3', kind: 'removal.site' }], retiring: [] }));
    assert.equal(txnOpenOnDisk(f, 'removal.site'), true);
    assert.equal(txnOpenOnDisk(f, 'removal.cargo'), false);
    fs.writeFileSync(f, JSON.stringify({ format: 1, open: [], retiring: [{ id: 'tx-3', kind: 'removal.site' }] }));
    assert.equal(txnOpenOnDisk(f, 'removal.site'), true, 'retiring counts as not yet retired');
    fs.writeFileSync(f, '{ broken');
    assert.equal(txnOpenOnDisk(f, 'removal.site'), false, 'unreadable: not shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T4RDN-2crash-wait: the T4RD-2crash row judges its second crash with secondCrash and FAILS (skips its checks) without it', () => {
  const src = fs.readFileSync(new URL('../../tools/lib/gatetxncc.mjs', import.meta.url), 'utf8');
  const a = src.indexOf("if (sub === '2crash') {", src.indexOf('// T4RD-2crash'));
  const b = src.indexOf('await reopen();', a);
  const branch = src.slice(a, b);
  assert.ok(a > 0 && b > a, 'the 2crash branch');
  assert.match(branch, /await secondCrash\(/, 'judged by secondCrash');
  assert.match(branch, /check\(down,/, 'a missing second crash is a check, not a log line');
  assert.match(branch, /if \(!down\) \{.*continue; \}/, 'and the row stops there');
});
