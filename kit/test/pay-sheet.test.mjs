// (7c PAY) The blind A/B sheet (tools/lib/pay-sheet.mjs): one self-contained HTML file (every image inlined as a data: URI, Noah's
// standing rule), the sides from the given randomness, the key in its own file and never on the sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abSheet } from '../../tools/lib/pay-sheet.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');

test('the sheet is self-contained (images inlined), the sides follow rand, the key is apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-sheet-'));
  const img = (n) => { const f = path.join(dir, `${n}.png`); fs.writeFileSync(f, PNG); return f; };
  const pairs = [{ pair: 's3', on: { imgs: [img('on1'), img('on2')] }, off: { imgs: [img('off1'), img('off2')] } }, { pair: 's5', on: { text: 'plan <on>' }, off: { text: 'plan off' } }];
  const bytes = [1, 0];
  const r = abSheet('P4', dir, pairs, 'Plan pick sheet', 'Pick one.', { rand: () => bytes.shift() });
  const html = fs.readFileSync(r.sheet, 'utf8');
  assert.equal(r.inlined, 4);
  assert.deepEqual(r.missing, []);
  assert.equal((html.match(/<img src="data:image\/png;base64,/g) ?? []).length, 4);
  assert.doesNotMatch(html, /<img src="(?!data:)/);
  assert.match(html, /plan &lt;on>/);
  const key = JSON.parse(fs.readFileSync(r.key, 'utf8')).key;
  assert.deepEqual(key, { s3: { A: 'off', B: 'on' }, s5: { A: 'on', B: 'off' } });
  assert.doesNotMatch(html, /"off"|"on"|ab-key/);
});
