#!/usr/bin/env node
// (7b foundation, slice 7bF; docs/CONTRACT.md "Phase 7b" §3 row 1) The six site fixtures, one per fit: a frozen ARVX volume (the lot
// box plus SITE_MARGIN on every side) and its site spec, in kit/test/fixtures/site/<id>/ (volume.bin: gzipPinned ARVX v1; site.json).
// They are the $0 subjects of the 7b slices (SV's examples build over them, SC checks them, PL places them, AF analyses them).
//
// Synthesized, not cut from a world: the gate of 7bF runs no client, and the pinned sites (scenarios/sites/*.json) record a seed, a
// claim and a 2.5D survey sha, not a frozen 3D volume. Each fixture is shaped after the recorded geometry of the site it names
// (cliff_face's run, tunnel_hill's hill, rift_site's carved rift, grove's plains with natural trees) and placed at that site's
// coordinates; the two new ones (an overhang, a trunk) sit beside cliff_face's run and in grove's claim. A slice that needs the real
// land cuts it from the pinned seed in game.
//
//   node kit/tools/site-fixtures.mjs           write every fixture
//   node kit/tools/site-fixtures.mjs --check   compare with the committed files (exit 1 on a difference)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeArvx, VC } from '../lib/region/volume.mjs';
import { gzipPinned, sha256Hex } from '../lib/region/pack.mjs';
import { SITE_MARGIN } from '../lib/siteFits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_FIXTURES_DIR = path.join(HERE, '..', 'test', 'fixtures', 'site');

/**
 * One fixture. `lot`: the design's allowed box size [w, h, d] and its minimum corner in the world; the volume is the lot plus
 * SITE_MARGIN. `cls(x, y, z)`: the class at local volume coordinates (0 = the volume's minimum corner). `ports` in design coordinates
 * (the lot's minimum corner is 0,0,0, front south: every fixture's frame is rotation none). `keep(volume)`: world keep-critical cells.
 */
const FIXTURES = [
  {
    id: 'cliff_face', fit: 'attach_to_cliff', after: 'scenarios/sites/cliff_face.json',
    purpose: 'a rock face 22 above the ground (normal south): a cliff house on brackets bears on the face (SV fit_attach_to_cliff)',
    min: [-951, 112, -2497], lot: [16, 22, 12],
    cls(x, y, z) {
      if (z < SITE_MARGIN + 2) return y < 27 ? (y > 24 ? VC.SOIL : VC.ROCK) : VC.AIR; // the cliff: its face at local z 9, its top at y 26
      if (y < 3) return VC.ROCK;
      return y < 5 ? VC.SOIL : VC.AIR;
    },
    ports: [{ name: 'walk_top', kind: 'architect:walk', at: [7, 19, 1], facing: 'north', width: 2, height: 2 }], // on the clifftop
    keep: () => [],
  },
  {
    id: 'tunnel_hill', fit: 'carve_into', after: 'scenarios/sites/tunnel_hill.json',
    purpose: 'a hill of rock under 3 of soil with a steep south face: a carved room keeps the rock as its walls (SV fit_carve_into)',
    min: [1528, 58, 566], lot: [16, 12, 16],
    cls(x, y, z, W, H, D) {
      const dx = x - W / 2, dz = z - D / 2;
      const top = Math.min(H - 2, 24 + Math.floor(4 - Math.sqrt(dx * dx + dz * dz) / 4));
      if (z >= D - SITE_MARGIN - 1 && y >= SITE_MARGIN) return VC.AIR; // the cut face, south
      if (y < SITE_MARGIN) return y < SITE_MARGIN - 2 ? VC.ROCK : VC.SOIL;
      if (y > top) return VC.AIR;
      return y > top - 3 ? VC.SOIL : VC.ROCK;
    },
    ports: [{ name: 'door_s', kind: 'door', at: [7, 0, 14], facing: 'south', width: 1, height: 2 }],
    keep: () => [],
  },
  {
    id: 'rift_site', fit: 'span', after: 'scenarios/sites/rift_site.json',
    purpose: "two rock faces 9 apart across a rift (6b's carved rift on the pinned desert): a span house bears on both rims (SV fit_span)",
    min: [-1032, 52, -16], lot: [16, 10, 16],
    cls(x, y, z) {
      const gap = x >= 11 && x <= 19;
      if (y < 3) return VC.ROCK;
      if (gap) return y < 5 ? VC.WATER : VC.AIR;
      if (y < 9) return VC.ROCK;
      return y < 11 ? VC.SOIL : VC.AIR; // the rims' top at y 10
    },
    ports: [
      { name: 'walk_w', kind: 'architect:walk', at: [0, 3, 7], facing: 'west', width: 2, height: 3 },
      { name: 'walk_e', kind: 'architect:walk', at: [15, 3, 7], facing: 'east', width: 2, height: 3 },
    ],
    keep: () => [],
  },
  {
    id: 'grove', fit: 'on_pad', after: 'scenarios/sites/grove.json',
    purpose: 'flat plains with natural trees at the north and west edges and a shallow pond in the south of the lot: a stilt house on_pad (SV fit_on_pad stilts)',
    min: [3400, 54, -1528], lot: [16, 16, 16],
    cls(x, y, z) {
      const pond = x >= 12 && x <= 19 && z >= 18 && z <= 27;
      if (y < 6) return VC.ROCK;
      if (pond && y >= 8 && y <= 9) return VC.WATER;
      if (y < 10) return VC.SOIL;
      for (const [tx, tz] of [[3, 3], [3, 18], [18, 3]]) {
        if (x === tx && z === tz && y <= 15) return VC.LOG;
        if (y >= 14 && y <= 17 && Math.abs(x - tx) <= 2 && Math.abs(z - tz) <= 2 && !(x === tx && z === tz && y <= 15)) return VC.LEAVES;
      }
      return y === 10 && (x * 7 + z * 13) % 11 === 0 ? VC.PLANT : VC.AIR;
    },
    ports: [],
    keep: () => [],
  },
  {
    id: 'overhang', fit: 'suspend', after: 'new (beside cliff_face\'s run)',
    purpose: 'a rock ceiling 8 thick reaching 14 out from a face, 18 of air under it: a hanging house from four hang points (SV fit_suspend)',
    min: [-951, 112, -2441], lot: [16, 14, 12],
    cls(x, y, z) {
      if (y < 4) return y < 2 ? VC.ROCK : VC.SOIL;
      if (z < 10) return VC.ROCK; // the face, normal south
      if (z < 24 && y >= 22) return VC.ROCK; // the overhang: its underside at y 22, just above the lot
      return VC.AIR;
    },
    ports: [{ name: 'hatch', kind: 'architect:walk', at: [8, 0, 6], facing: 'down', width: 1, height: 1 }],
    keep: (o) => [[2, 3], [13, 3], [2, 8], [13, 8]].map(([dx, dz]) => [o[0] + dx, o[1] + 14, o[2] + dz]), // the ceiling's underside over the lot
  },
  {
    id: 'trunk', fit: 'wrap_trunk', after: 'new (in grove\'s claim)',
    purpose: 'a giant trunk (radius 2, 30 tall) under a leaf canopy: a ring house on decks round the trunk (SV fit_wrap_trunk)',
    min: [3440, 56, -1488], lot: [16, 20, 16],
    cls(x, y, z, W, H, D) {
      const dx = x - Math.floor(W / 2), dz = z - Math.floor(D / 2), r2 = dx * dx + dz * dz;
      if (y < 4) return y < 2 ? VC.ROCK : VC.SOIL;
      if (r2 <= 4 && y < 34) return VC.LOG;
      if (y >= 30 && r2 <= 64) return VC.LEAVES; // the canopy, above the lot
      return VC.AIR;
    },
    ports: [{ name: 'walk_w', kind: 'architect:walk', at: [0, 2, 7], facing: 'west', width: 2, height: 2 }],
    keep: null, // every LOG cell inside the lot box (the host trunk)
  },
];

/** Every fixture, built in memory: `{id, dir, volume: Uint8Array (the gzip file), site: object (site.json)}`. Deterministic. */
export function buildSiteFixtures() {
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
    let keep;
    if (f.keep) keep = f.keep(origin);
    else {
      keep = [];
      for (let x = lot.minX; x <= lot.maxX; x++) for (let y = lot.minY; y <= lot.maxY; y++) for (let z = lot.minZ; z <= lot.maxZ; z++) {
        if (classes[((x - box.minX) * D + (z - box.minZ)) * H + (y - box.minY)] === VC.LOG) keep.push([x, y, z]);
      }
    }
    const spec = {
      volumeSha: sha, volumeBlobId: `local:${sha}`, volume: box, fit: f.fit, frame: { origin, rotation: 'none' }, keepCritical: keep,
      ports: f.ports.map((p) => ({ ...p })), lotId: `lot_${f.id}`,
    };
    const named = Object.fromEntries(Object.entries(counts).map(([k, n]) => [Object.keys(VC).find((c) => VC[c] === Number(k)), n]).sort((a, b) => a[0].localeCompare(b[0])));
    const site = { id: f.id, fit: f.fit, purpose: f.purpose, after: f.after, from: 'synthesized by kit/tools/site-fixtures.mjs (no client in the 7bF gate)', lot, maxSize: [lw, lh, ld], counts: named, spec };
    return { id: f.id, dir: path.join(SITE_FIXTURES_DIR, f.id), volume: gzipPinned(raw), site };
  });
}

/** The site.json text of a built fixture. */
export const siteJsonText = (fx) => `${JSON.stringify(fx.site, null, 1)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const fx of buildSiteFixtures()) {
    const vf = path.join(fx.dir, 'volume.bin'), sf = path.join(fx.dir, 'site.json');
    if (check) {
      const same = fs.existsSync(vf) && Buffer.compare(fs.readFileSync(vf), Buffer.from(fx.volume)) === 0 && fs.existsSync(sf) && fs.readFileSync(sf, 'utf8') === siteJsonText(fx);
      if (!same) { bad++; console.error(`${fx.id}: differs from the committed fixture (run node kit/tools/site-fixtures.mjs)`); }
      else console.log(`${fx.id}: ok (${fx.site.spec.volumeSha.slice(0, 12)})`);
    } else {
      fs.mkdirSync(fx.dir, { recursive: true });
      fs.writeFileSync(vf, fx.volume);
      fs.writeFileSync(sf, siteJsonText(fx));
      console.log(`${fx.id}: ${fx.site.fit} ${fx.site.spec.volumeSha.slice(0, 12)} ${fx.volume.length} bytes`);
    }
  }
  process.exit(bad ? 1 : 0);
}
