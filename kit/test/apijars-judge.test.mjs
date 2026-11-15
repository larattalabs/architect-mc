// tools/lib/apijars-judge.mjs (GI2, GR-a item 10): an old apitest jar's run is judged as before; a failed jar runs once more, logged as a
// retry, and a second failure still fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeApitest, runJarWithRetry } from '../../tools/lib/apijars-judge.mjs';

const okRun = { code: 0, text: 'ok   a\nok   b\n0 FAILED -> done\n' };
const npe = { code: 1, text: 'ok   a\nFAIL setTags: NullPointerException\n1 FAILED -> done\n' };
const timingOnly = { code: 1, text: 'ok   a\nFAIL BAR mspt 60 > 50\nFAIL SITE_PROGRESS 3x, at most 1/s (min gap 400 ms), built 3 <= 3\n2 FAILED -> done\n' };
const runs = (...rs) => { let i = 0; const calls = []; return { calls, attempt: async (n) => { calls.push(n); return rs[i++]; } }; };

test('judgeApitest: pass, a hard FAIL, timing only (recorded, a pass), no ok line', () => {
  assert.equal(judgeApitest(okRun.text, 0).pass, true);
  const j = judgeApitest(npe.text, 1);
  assert.deepEqual([j.pass, j.hard.length], [false, 1]);
  const t = judgeApitest(timingOnly.text, 1);
  assert.deepEqual([t.pass, t.hard.length, t.timing.length], [true, 0, 2]);
  assert.equal(judgeApitest('', 0).pass, false, 'nothing ran');
});

test('runJarWithRetry: a pass and a timing-only run never retry', async () => {
  for (const r of [okRun, timingOnly]) {
    const a = runs(r);
    const lines = [];
    const res = await runJarWithRetry('0.56.0 (API 1.49)', a.attempt, { log: (m) => lines.push(m) });
    assert.deepEqual(a.calls, [1]);
    assert.equal(res.retried, null);
    assert.equal(res.judged.pass, true);
    assert.deepEqual(lines, []);
  }
});

test('runJarWithRetry: a first failure then a pass is a PASS with the retry logged and recorded', async () => {
  const a = runs(npe, okRun);
  const lines = [];
  const res = await runJarWithRetry('0.56.0 (API 1.49)', a.attempt, { log: (m) => lines.push(m) });
  assert.deepEqual(a.calls, [1, 2]);
  assert.equal(res.judged.pass, true);
  assert.deepEqual(res.retried.first.hard, ['FAIL setTags: NullPointerException']);
  assert.match(lines[0], /^RETRY apijars: the 0\.56\.0 \(API 1\.49\) jar's first run did not pass/);
  assert.match(lines.join('\n'), /first run: FAIL setTags/);
  assert.match(lines.at(-1), /second run passed/);
});

test('runJarWithRetry: two failures fail, never hidden (one retry only)', async () => {
  const a = runs(npe, { code: 1, text: 'ok   a\nFAIL makeVariant: timeout\n1 FAILED -> done\n' });
  const lines = [];
  const res = await runJarWithRetry('0.68.0 (API 1.61)', a.attempt, { log: (m) => lines.push(m) });
  assert.deepEqual(a.calls, [1, 2]);
  assert.equal(res.judged.pass, false);
  assert.deepEqual(res.judged.hard, ['FAIL makeVariant: timeout'], 'the second run\'s failure is the one judged');
  assert.ok(res.retried);
  assert.match(lines.at(-1), /FAILED too/);
});
