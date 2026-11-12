#!/usr/bin/env node
// (7b DS) Two more attach_to_cliff sites for the site-variant gate (docs/CONTRACT.md "Phase 7b", slice DS), in kit/test/fixtures/ds/<id>/
// (volume.bin, site.json), beside 7bF's six (f7b-foundation holds kit/test/fixtures/site/ to those six):
//   cliff_east    another cliff, east of cliff_face's run: 4 taller, its lot 2 wider and 2 taller, the walk port elsewhere on the top.
//                 A site variant of a cliff house designed on cliff_face re-runs its program here and installs ($0).
//   cliff_owned   cliff_face's shape at another place, with a player's pillar (PLAYER cells) standing in front of the face where a cliff
//                 house goes: its site variant here refuses SITE_UNFIT `site_keep`.
// Synthesized as site-fixtures.mjs does (ARVX v1, gzipPinned, sha = the ARVX sha, frame rotation none, lot = volume less 8).
//   node kit/tools/ds-fixtures.mjs           write both
//   node kit/tools/ds-fixtures.mjs --check   compare with the committed files (exit 1 on a difference)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeArvx, VC } from '../lib/region/volume.mjs';
import { gzipPinned, sha256Hex } from '../lib/region/pack.mjs';
import { SITE_MARGIN } from '../lib/siteFits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DS_FIXTURES_DIR = path.join(HERE, '..', 'test', 'fixtures', 'ds');

const FIXTURES = [
  {
    id: 'cliff_east', fit: 'attach_to_cliff',
    purpose: 'a second rock face (normal south), 4 taller than cliff_face, its lot 18x24x12: a site variant of a cliff house installs here',
    min: [-900, 110, -2497], lot: [18, 24, 12],
    cls(x, y, z) {
      if (z < SITE_MARGIN + 2) return y < 31 ? (y > 28 ? VC.SOIL : VC.ROCK) : VC.AIR; // the cliff: its face at local z 9, its top at y 30
      if (y < 3) return VC.ROCK;
      return y < 5 ? VC.SOIL : VC.AIR;
    },
    ports: [{ name: 'walk_top', kind: 'architect:walk', at: [9, 23, 1], facing: 'north', width: 2, height: 2 }],
  },
  {
    id: 'cliff_owned', fit: 'attach_to_cliff',
    purpose: "cliff_face's shape elsewhere, with a player's pillar standing in front of the face: a cliff house built there writes into it (site_keep)",
    min: [-860, 112, -2497], lot: [16, 22, 12],
    cls(x, y, z) {
      if (z < SITE_MARGIN + 2) return y < 27 ? (y > 24 ? VC.SOIL : VC.ROCK) : VC.AIR; // cliff_face's cliff
      if (x === SITE_MARGIN + 6 && z === SITE_MARGIN + 4 && y >= 5 && y < 27) return VC.PLAYER; // a player's pillar in front of the face
      if (y < 3) return VC.ROCK;
      return y < 5 ? VC.SOIL : VC.AIR;
    },
    ports: [{ name: 'walk_top', kind: 'architect:walk', at: [7, 19, 1], facing: 'north', width: 2, height: 2 }],
  },
];

/** Both fixtures, built in memory: `{id, dir, volume (gzip bytes), site (site.json)}`. Deterministic. */
export function buildDsFixtures() {
  return FIXTURES.map((f) => {
    const [lw, lh, ld] = f.lot;
    const W = lw + 2 * SITE_MARGIN, H = lh + 2 * SITE_MARGIN, D = ld + 2 * SITE_MARGIN;
    const box = { minX: f.min[0], minY: f.min[1], minZ: f.min[2], maxX: f.min[0] + W - 1, maxY: f.min[1] + H - 1, maxZ: f.min[2] + D - 1 };
    const classes = new Uint8Array(W * H * D);
    const counts = {};
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
      const c = f.cls(x, y, z, W, H, D);
      classes[(x * D + z) * H + y] = c;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    const raw = encodeArvx(box, classes);
    const sha = sha256Hex(raw);
    const origin = [box.minX + SITE_MARGIN, box.minY + SITE_MARGIN, box.minZ + SITE_MARGIN];
    const lot = { minX: origin[0], minY: origin[1], minZ: origin[2], maxX: origin[0] + lw - 1, maxY: origin[1] + lh - 1, maxZ: origin[2] + ld - 1 };
    const spec = {
      volumeSha: sha, volumeBlobId: `local:${sha}`, volume: box, fit: f.fit, frame: { origin, rotation: 'none' }, keepCritical: [],
      ports: f.ports.map((p) => ({ ...p })), lotId: `lot_${f.id}`,
    };
    const named = Object.fromEntries(Object.entries(counts).map(([k, n]) => [Object.keys(VC).find((c) => VC[c] === Number(k)), n]).sort((a, b) => a[0].localeCompare(b[0])));
    const site = { id: f.id, fit: f.fit, purpose: f.purpose, from: 'synthesized by kit/tools/ds-fixtures.mjs (7b DS)', lot, maxSize: [lw, lh, ld], counts: named, spec };
    return { id: f.id, dir: path.join(DS_FIXTURES_DIR, f.id), volume: gzipPinned(raw), site };
  });
}

const text = (fx) => `${JSON.stringify(fx.site, null, 1)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const fx of buildDsFixtures()) {
    const vf = path.join(fx.dir, 'volume.bin'), sf = path.join(fx.dir, 'site.json');
    if (check) {
      const same = fs.existsSync(vf) && Buffer.compare(fs.readFileSync(vf), Buffer.from(fx.volume)) === 0 && fs.existsSync(sf) && fs.readFileSync(sf, 'utf8') === text(fx);
      if (!same) { bad++; console.error(`${fx.id}: differs from the committed fixture (run node kit/tools/ds-fixtures.mjs)`); }
      else console.log(`${fx.id}: ok (${fx.site.spec.volumeSha.slice(0, 12)})`);
    } else {
      fs.mkdirSync(fx.dir, { recursive: true });
      fs.writeFileSync(vf, fx.volume);
      fs.writeFileSync(sf, text(fx));
      console.log(`${fx.id}: ${fx.site.fit} ${fx.site.spec.volumeSha.slice(0, 12)} ${fx.volume.length} bytes`);
    }
  }
  process.exit(bad ? 1 : 0);
}
