// (6c D3) The kit/Java parity fixture (not a test file itself): a standing town's IR with the kit's besideStanding of it, and districts
// IRs (a reach join at a street end, a side T, a seam join, an outpost) with the kit's districtLand of each. The kit's test
// (districts-d3-parity.test.mjs) keeps it equal to the kit; the mod's BesideReachTest and DistrictLandTest compare Java to it.
//   node kit/test/d3-parity.mjs --write     re-cut kit/test/fixtures/d3/parity.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { besideStanding } from '../lib/region/beside.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { d3Town, planBeside, reachInputs } from './d3-helpers.mjs';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'd3', 'parity.json');

/** The fixture's inputs and the kit's outputs, from scratch. */
export async function build() {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const cases = [
    ['east_end', [{ id: 'east', size: [48, 48], lots: 4 }], [100, 13, 180, 93]],
    ['north_side', [{ id: 'north', size: [48, 48], lots: 4 }], [0, -70, 90, -1]],
    ['seam', [{ id: 'east', size: [48, 48], lots: 4 }], [-60, 13, 11, 93]],
    ['outpost', [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 30 } }], [100, 13, 230, 120]],
  ];
  const districts = [];
  for (const [name, ds, claimB] of cases) {
    const q = await planBeside({ town, districts: ds, claimB, besideReach: R.besideReach });
    districts.push({ name, ir: q.ir, townClaim: town.claim, land: districtLand(q.ir, town.claim), landNoTown: districtLand(q.ir, null), landRemoved: districtLand(q.ir, town.claim, { standingRemoved: 1234567 }) });
  }
  return { town: { id: 'rg1', claim: town.claim, ir: town.p.ir, standing: besideStanding('rg1', town.claim, town.p.ir) }, districts };
}

if (process.argv.includes('--write')) {
  const f = await build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${FIXTURE} (${fs.statSync(FIXTURE).size} bytes)`);
}
