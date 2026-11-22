// (slice T4R-D narrowing round, P2-4; row T4RDN-2crash-wait) T4RD-2crash's second crash counts only when it happened: the world's open was
// refused because the host has no server (not timed out, not opened), the host shows no server, and the recovery it interrupted is still
// open in txn.json on disk. Red at e1a7aad7: the row dropped the race's result and only logged `down`, so a timeout or a start that recovered
// without the second crash passed on the later owed/ground/open checks alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secondCrash, txnOpenOnDisk } from '../../tools/lib/second-crash.mjs';

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

test('T4RDN-2crash-wait: refused, no server, its recovery still open on disk: the second crash happened', async () => {
  const r = await secondCrash({ open: async () => { throw new Error('exited'); }, sleep: never, serverGone: async () => true, txnOpen: () => true, boundMs: 1 });
  assert.equal(r.down, true, r.why);
});

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
