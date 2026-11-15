// (7c PAY, P4's blind sheet, $0) Two plan/0 documents of the same brief rendered the same way over the same land: each planned through
// plan_v0 by the kit's own check (kit/test/plan-helpers.mjs checkPlanLocal, as Regions.checkPlan plans it) over one survey and Style,
// then the kit's previews (kit/lib/region/preview.mjs: siteplan, iso, top). Nothing is written to a world.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(root, 'kit', rel)).href);

/** Render one plan: {overall, lots, placed, paths: {view: [png...]}} under outDir/previews. */
export async function renderPlan({ plan, survey, claim, bible, roles, outDir, views = ['siteplan', 'iso', 'top'] }) {
  const { checkPlanLocal } = await imp('test/plan-helpers.mjs');
  const { renderPreviews } = await imp('lib/region/preview.mjs');
  const out = await checkPlanLocal(plan, { survey, claim, bible, style: { roles } });
  fs.mkdirSync(outDir, { recursive: true });
  const r = renderPreviews({ ir: out.res.ir, survey, blobs: out.res.blobs, meta: out.res.meta, views, outDir });
  const lots = out.res.ir.lots ?? [];
  return { overall: out.check.overall, lots: lots.length, paths: r.paths };
}
