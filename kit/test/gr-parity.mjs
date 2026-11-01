// (6d GR §7) The kit/Java parity fixture for `architect_mc:land` v 2 (not a test file itself): a beside district and an outpost, each
// grown by a revision, as effective IRs, with the kit's districtLand of each (grown; and undone: the base with `revised`). The kit's test
// (gr-parity.test.mjs) keeps it equal to the kit; the mod's DistrictLandGrTest compares Java to it.
//   node kit/test/gr-parity.mjs --write     re-cut kit/test/fixtures/gr/land.json
// Every plan here is pinned (PIN): the IR records `node` and `kitVersion`, and both feed the revisions' irShas, so unpinned the
// fixture differed by the Node major that cut it (CI runs Node 22) and went stale at every kit release. Pinned, it is byte-identical
// on any Node and platform and is not one of the goldens tools/release-version.mjs re-cuts. A future behaviour gated on kitVersion
// (program.mjs reads ctx.kitVersion) reaches this fixture only when PIN.kitVersion is raised and the fixture re-cut.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { districtLand } from '../lib/region/land.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';
import { d3Town, planBeside, reachInputs } from './d3-helpers.mjs';

export const PIN = { node: 'golden', kitVersion: '0.44.0' };

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gr', 'land.json');

export async function build() {
  const town = await d3Town({ pin: PIN });
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const out = [];
  for (const [name, ds, claimB, grow] of [
    ['east', [{ id: 'east', size: [48, 48], lots: 2 }], [100, 13, 180, 93], { district: 'east', lots: 3 }],
    ['camp', [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 30 } }], [100, 13, 230, 120], { district: 'camp', lots: 4, prefer: 'extend' }],
  ]) {
    const q = await planBeside({ town, districts: ds, claimB, besideReach: R.besideReach, pin: PIN });
    const eff = mergeEffective(q.ir);
    const RI = reachInputs({ id: 'rg2', ir: q.ir, world: town.world, claim: claimB });
    const standing = { ...revisionStanding({ id: 'rg2', claim: claimB, effective: eff, held: RI.besideReach.held }), town: { id: 'rg1', claim: town.claim } };
    const r = await reviseIR(eff, { grow }, { rid: 1, position: 1, parent: { rid: 0, irSha: q.irSha }, base: { irSha: q.irSha }, survey: RI.besideReach.survey, standing, ...PIN });
    const m = mergeEffective(q.ir, [{ rid: 1, position: 1, ir: r.ir, irSha: r.irSha }]);
    out.push({ name, townClaim: town.claim, base: q.ir, effective: m, land: districtLand(m, town.claim), landUndone: districtLand(q.ir, town.claim, { revised: true }), landBase: districtLand(q.ir, town.claim) });
  }
  // (§5) an along district grown by its boundary: the new band's own district part (shape mask, its revision)
  {
    const { makeColumns } = await import('../lib/region/pack.mjs');
    const W = 192, D = 192, claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
    const c = makeColumns(0, 0, W, D, 1);
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W; const w = i >= 90 && i < 100; c.ground[k] = 64; c.height[k] = 64; c.floor[k] = w ? 61 : 64; c.flags[k] = w ? 1 : 0; }
    const { planRegion } = await import('../lib/region/plan.mjs');
    const q = await planRegion({ programFile: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: 'quay', size: [64, 24], follow: { shore: {} }, lots: 2 }] }, lamps: false }, survey: c, claim, seed: '1', ...PIN });
    const eff = mergeEffective(q.ir);
    const standing = revisionStanding({ id: 'rg3', claim: [0, 0, 191, 191], effective: eff, held: { runs: [], town: [], terrain: [] } });
    const r = await reviseIR(eff, { grow: { district: 'quay', lots: 4, prefer: 'extend' } }, { rid: 1, position: 1, parent: { rid: 0, irSha: q.irSha }, base: { irSha: q.irSha }, survey: c, standing, ...PIN });
    const m = mergeEffective(q.ir, [{ rid: 1, position: 1, ir: r.ir, irSha: r.irSha }]);
    out.push({ name: 'quay', townClaim: [0, 0, -1, -1], base: q.ir, effective: m, land: districtLand(m, [0, 0, -1, -1]), landUndone: districtLand(q.ir, [0, 0, -1, -1], { revised: true }), landBase: districtLand(q.ir, [0, 0, -1, -1]) });
  }
  return { cases: out };
}

if (process.argv.includes('--write')) {
  const f = await build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${FIXTURE} (${fs.statSync(FIXTURE).size} bytes)`);
}
