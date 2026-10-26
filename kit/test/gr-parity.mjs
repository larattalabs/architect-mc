// (6d GR §7) The kit/Java parity fixture for `architect_mc:land` v 2 (not a test file itself): a beside district and an outpost, each
// grown by a revision, as effective IRs, with the kit's districtLand of each (grown; and undone: the base with `revised`). The kit's test
// (gr-parity.test.mjs) keeps it equal to the kit; the mod's DistrictLandGrTest compares Java to it.
//   node kit/test/gr-parity.mjs --write     re-cut kit/test/fixtures/gr/land.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { districtLand } from '../lib/region/land.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';
import { d3Town, planBeside, reachInputs } from './d3-helpers.mjs';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gr', 'land.json');

export async function build() {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const out = [];
  for (const [name, ds, claimB, grow] of [
    ['east', [{ id: 'east', size: [48, 48], lots: 2 }], [100, 13, 180, 93], { district: 'east', lots: 3 }],
    ['camp', [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 30 } }], [100, 13, 230, 120], { district: 'camp', lots: 4, prefer: 'extend' }],
  ]) {
    const q = await planBeside({ town, districts: ds, claimB, besideReach: R.besideReach });
    const eff = mergeEffective(q.ir);
    const RI = reachInputs({ id: 'rg2', ir: q.ir, world: town.world, claim: claimB });
    const standing = { ...revisionStanding({ id: 'rg2', claim: claimB, effective: eff, held: RI.besideReach.held }), town: { id: 'rg1', claim: town.claim } };
    const r = await reviseIR(eff, { grow }, { rid: 1, position: 1, parent: { rid: 0, irSha: q.irSha }, base: { irSha: q.irSha }, survey: RI.besideReach.survey, standing });
    const m = mergeEffective(q.ir, [{ rid: 1, position: 1, ir: r.ir, irSha: r.irSha }]);
    out.push({ name, townClaim: town.claim, base: q.ir, effective: m, land: districtLand(m, town.claim), landUndone: districtLand(q.ir, town.claim, { revised: true }), landBase: districtLand(q.ir, town.claim) });
  }
  return { cases: out };
}

if (process.argv.includes('--write')) {
  const f = await build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${FIXTURE} (${fs.statSync(FIXTURE).size} bytes)`);
}
