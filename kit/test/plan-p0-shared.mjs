// plan-p0's helpers, shared by plan-p0.test.mjs and its split files (plan-p0-valid, plan-p0-det-1..3, plan-p0-asks). Not a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { asksSurvey, goldenSurvey, stewardAnchors, checkPlanLocal, checkPlanVolumes, memoryCache, flatSurvey, FIX, ROOT, fixtureStyle, fixtureLotBlocks } from './plan-helpers.mjs';
import { validatePlan, PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';

// ((7a K1b) `flat`: a flat claim in rift_city's range, for the rope bridge fixtures; a fixture's `anchors` add to Steward's)
export const SV = { s7: goldenSurvey('s7'), s3: goldenSurvey('s3'), asks: asksSurvey(), flat: flatSurvey() };
export const read = (dir) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
// ((6c T3) a fixture's `terrain` ({W, D, x0, z0, y, bands}: plan-helpers.mjs flatSurvey) instead of `on`: a synthetic claim, e.g. a
// ravine, a water channel or a ridge; (T3b) and its `volume`: the frozen rock a tunnel's corridor reads, through the check's two-plan
// flow (plan_v0 asks, the fixture answers))
export const svOf = (fx) => (fx.terrain ? flatSurvey(fx.terrain) : SV[fx.on]);
// ((6c VOC-c) a VOC-c fixture (one with a rule.palette) is checked in its bible (`style`) with its bound lots' histograms (`lotDesigns`),
// as the game checks it; every other fixture as before)
export const run = async (fx, extra = {}) => {
  const s = svOf(fx);
  const vocc = (fx.plan?.rules ?? []).some((r) => r?.kind === 'palette') && (fx.style || fx.lotDesigns);
  const lb = vocc ? await fixtureLotBlocks(fx) : null;
  const o = { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}), ...(vocc ? { style: fixtureStyle(fx) } : {}), ...(lb ? { lotBlocks: lb } : {}), ...extra };
  return fx.volume ? checkPlanVolumes(fx.plan, { ...o, volume: fx.volume }) : checkPlanLocal(fx.plan, o);
};
export const lots = (n, p = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: 'house', size: [9, 9] }));
export const A = SV.asks;
export const asks = (plan, o = {}) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim), ...o });
export const part = (r, id) => r.check.parts.find((a) => a.part === id);

export const GROVE = [{ id: 'grove', rect: [130, 130, 190, 190] }];
export const NEAR_CENTRE = (tol) => ({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 0 } }, ...(tol ? { tolerance: tol } : {}) }],
  connectors: [{ id: 'up', kind: 'path', from: { part: 'town' }, to: { anchor: 'claim_n' } }] });
export const WALL = [{ id: 'wall', rect: [150, 60, 170, 260] }];
export const WALLED = { schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(3) }, where: { near: { anchor: 'claim_w', within: 8 } } }],
  connectors: [{ id: 'long', kind: 'road', from: { part: 'town' }, to: { anchor: 'claim_e' } }] };

/** Item 3 over every n-th plan from k (plan-p0-det-<k+1>.test.mjs): three checks give identical answers and artifact shas; 1 and 4 tile workers give equal tile shas. */
export async function determinism(k, n) {
  const { tileShas } = await import('../../tools/scenarios.mjs');
  const perClass = [NEAR_CENTRE(), NEAR_CENTRE({ move: { max: 2, hard: true } }), WALLED].map((plan, i) => ({ name: `per-class ${i}`, on: 'asks', plan, protected: i < 2 ? GROVE : WALL }));
  for (const f of [...read('valid'), ...perClass].filter((_, i) => i % n === k)) {
    const rs = [await run(f), await run(f), await run(f)];
    const j = rs.map((r) => JSON.stringify(r.check));
    assert.equal(j[1], j[0], `${f.name}: answers`);
    assert.equal(j[2], j[0], `${f.name}: answers`);
    assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha), `${f.name}: artifact sha`);
    if (!rs[0].artifact) continue;
    // the artifact's tile shas are the plan's own tiles (as scenario goldens compute them), 1 worker = 4 workers
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-det-'));
    try {
      fs.writeFileSync(path.join(dir, 'ir.json'), rs[0].res.irJson);
      fs.writeFileSync(path.join(dir, 'survey.bin'), svOf(f).bytes);
      fs.mkdirSync(path.join(dir, 'blobs'));
      for (const [sha, b] of rs[0].res.blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
      const ts = await tileShas(dir);
      assert.ok(ts.workersSame, `${f.name}: 1 worker = 4 workers`);
      const art = rs[0].artifact.region.tiles;
      for (const [k, sha] of Object.entries(ts.tiles)) { const [stage, set, key] = k.split('|'); assert.equal(art[stage][set][key], sha, `${f.name} ${k}`); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
