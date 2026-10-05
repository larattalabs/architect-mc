// Phase 4a: kit programs read blobs from a job's scratch dir (docs/CONTRACT.md "Jobs (R2)", "Survey"). A survey-shaped
// blob, as the sidecar copies it (blobs/<id>.json), is read by a script run in that dir, the way the sidecar will run
// kit programs on an agent's behalf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blobPath, listBlobs, readBlob, readBlobJson } from '../lib/blobs.mjs';

const LIB = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'blobs.mjs')).href;

/** A small survey sample: 4x3 columns at resolution 1, with masks and a biome per 4x4. */
function survey() {
  const w = 4;
  const d = 3;
  const height = [64, 64, 65, 66, 64, 65, 66, 70, 63, 63, 64, 64];
  return {
    area: { minX: 100, minY: 50, minZ: -20, maxX: 103, maxY: 90, maxZ: -18 },
    resolution: 1,
    width: w,
    depth: d,
    height,
    floor: height.map((h) => h - 1),
    top: height.map((_, i) => (i === 8 || i === 9 ? 'minecraft:water' : 'minecraft:grass_block')),
    slope: [0, 1, 1, 1, 1, 1, 4, 4, 1, 1, 1, 6],
    water: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0],
    tree: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    natural: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    biome: ['minecraft:plains'],
    missing: [],
  };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-blobs-'));
  fs.mkdirSync(path.join(dir, 'blobs'));
  return dir;
}

test('readBlob / readBlobJson / listBlobs / blobPath', () => {
  const dir = scratch();
  try {
    const b = path.join(dir, 'blobs');
    fs.writeFileSync(path.join(b, 'bsurvey01.json'), JSON.stringify(survey()));
    fs.writeFileSync(path.join(b, 'braw.bin'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(b, 'bchunked.dat'), JSON.stringify({ a: 1 }));
    assert.deepEqual(listBlobs(b).map((x) => `${x.id}.${x.ext}`), ['bchunked.dat', 'braw.bin', 'bsurvey01.json']);
    assert.equal(readBlob('bsurvey01', { dir: b }).width, 4);
    assert.deepEqual([...readBlob('braw', { dir: b })], [1, 2, 3]);
    assert.deepEqual(readBlobJson('bchunked', { dir: b }), { a: 1 });
    assert.equal(blobPath('braw', b), path.join(b, 'braw.bin'));
    assert.throws(() => readBlob('nope', { dir: b }), /no blob nope/);
    assert.throws(() => readBlob('../etc/passwd', { dir: b }), /not a blob id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a kit script in a job scratch dir reads a survey blob from ./blobs/', () => {
  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, 'blobs', 'b5e7a1c0.json'), JSON.stringify(survey()));
    const script = path.join(dir, 'flat.mjs');
    fs.writeFileSync(
      script,
      `import { readBlob } from ${JSON.stringify(LIB)};
const s = readBlob(process.argv[2]);
const cells = s.width * s.depth;
let flat = 0, wet = 0, best = null;
for (let i = 0; i < cells; i++) {
  if (s.water[i]) { wet++; continue; }
  if (s.slope[i] <= 1 && s.natural[i] && !s.tree[i]) { flat++; if (!best || s.height[i] < best.h) best = { x: s.area.minX + (i % s.width), z: s.area.minZ + Math.floor(i / s.width), h: s.height[i] }; }
}
console.log(JSON.stringify({ cells, flat, wet, best }));
`,
    );
    const out = execFileSync(process.execPath, [script, 'b5e7a1c0'], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), { cells: 12, flat: 7, wet: 2, best: { x: 100, z: -20, h: 64 } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
