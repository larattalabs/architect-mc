import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineImages, writeSheet } from '../../tools/lib/sheet-inline.mjs';

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('review sheets inline local images and leave remote/data/missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'img'));
    fs.writeFileSync(path.join(dir, 'img', 'a b.png'), PNG);
    const html = '<img src="img/a%20b.png"><img alt=x src=\'img/a%20b.png\'><img src="https://x/y.png"><img src="data:image/png;base64,AA"><img src="img/none.png">';
    const r = inlineImages(html, dir);
    assert.equal(r.inlined, 2);
    assert.deepEqual(r.missing, ['img/none.png']);
    assert.equal((r.html.match(/data:image\/png;base64,iVBOR/g) ?? []).length, 2);
    assert.match(r.html, /src="https:\/\/x\/y\.png"/);
    assert.match(r.html, /src="img\/none\.png"/);
    const f = path.join(dir, 'sheet.html');
    writeSheet(f, '<img src="img/a%20b.png">');
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /src="img\//);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
