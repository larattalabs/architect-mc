// (7c TC, docs/CONTRACT.md "Phase 7c" §3 row 7, "Slice TC as built") The template pick's land fixtures: the claim volumes the mod would
// freeze for Regions.design's affordance summary, built offline with SB's land (kit/test/sb-world.mjs): S5's grove and S6's cavern
// sculpted as natural land (the scenario setup, SB reading 2) on their flat variants' land, and plains (S5's flat land, no sculpt).
// `node kit/test/tc-land.mjs --write` writes them to kit/test/fixtures/tc/<name>.bin (gzip ARVX, as the mod uploads a volume) with
// lands.json (box, sha, the AF kinds found); tc.test.mjs re-builds them and holds the committed files equal (deterministic).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { makeLand, applySculpt, plan2 } from './sb-world.mjs';
import { hillAt } from '../regions/s3_hill.mjs';
import { analyseVolume } from '../lib/region/affordances.mjs';

export const FIXTURES = new URL('./fixtures/tc/', import.meta.url);
const S5 = { claim: { minX: 3328, minZ: -1600, maxX: 3519, maxZ: -1409 }, minY: 22, maxY: 156 };
const S6 = { claim: { minX: 3672, minZ: -1780, maxX: 3863, maxZ: -1589 }, minY: 22, maxY: 173 };
const hill6 = (x, z) => 64 + hillAt((S6.claim.minX + S6.claim.maxX) >> 1, (S6.claim.minZ + S6.claim.maxZ) >> 1, 88, 60, x, z);

/** name -> {spec, groundAt, sculpt?}: the lands. */
export const LANDS = Object.freeze({
  s5_grove: { spec: S5, groundAt: () => 64, sculpt: 's5_grove_sculpt' },
  s6_cavern: { spec: S6, groundAt: hill6, sculpt: 's6_cavern_sculpt' },
  s6_hill: { spec: S6, groundAt: hill6 },
  plains: { spec: S5, groundAt: () => 64 },
});

/** A land's claim volume: {name, box, sha, bytes (raw ARVX), gz, kinds (AF's per-kind counts), sculptMeta}. */
export async function buildLand(name) {
  const L = LANDS[name];
  const land = makeLand({ claim: L.spec.claim, minY: L.spec.minY, maxY: L.spec.maxY, groundAt: L.groundAt });
  let sculptMeta = null;
  if (L.sculpt) {
    const s = await plan2(land, L.sculpt);
    applySculpt(land, s);
    sculptMeta = s.meta.sb;
  }
  const box = { ...L.spec.claim, minY: L.spec.minY, maxY: L.spec.maxY };
  const v = land.volume(box);
  const kinds = {};
  for (const a of analyseVolume(v.decoded)) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  const gz = zlib.gzipSync(v.bytes, { level: 9 });
  gz[9] = 0; // (the gzip OS byte pinned: byte-compared files are platform-independent)
  return { name, box, sha: v.sha, bytes: v.bytes, gz, kinds, sculptMeta, claim: L.spec.claim };
}

if (process.argv.includes('--write')) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const index = {};
  for (const name of Object.keys(LANDS)) {
    const l = await buildLand(name);
    fs.writeFileSync(new URL(`${name}.bin`, FIXTURES), l.gz);
    index[name] = { claim: l.claim, box: l.box, sha: l.sha, bytes: l.gz.length, kinds: l.kinds };
    console.log(name, l.gz.length, 'bytes', JSON.stringify(l.kinds));
  }
  fs.writeFileSync(new URL('lands.json', FIXTURES), `${JSON.stringify({ note: '7c TC: the template pick\'s land fixtures (kit/test/tc-land.mjs --write); kinds = AF\'s analysis of each whole volume', lands: index }, null, 1)}\n`);
}
