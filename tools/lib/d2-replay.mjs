// (6c D2) "stable across a reload" judged on the plan's inputs. A district plan is deterministic from its survey, its biome grid
// and its seed (C27). A natural world's own changes across a save and reload (a spring's water) can move the live survey and so
// the second plan's IR; then the first plan's own inputs are planned again offline (as the scenarios' golden row) and must give
// its IR sha, and the columns the live survey moved are recorded. Used by tools/gate6cd.mjs; tested in kit/test/districts-d2.test.mjs.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Columns whose ground, flags or height differ between two surveys (both decoded or both bytes); null if either is missing. */
export async function movedColumns(kitDir, surveyA, surveyB) {
  if (!surveyA || !surveyB) return null;
  const { asColumns } = await import(pathToFileURL(path.join(kitDir, 'lib', 'region', 'pack.mjs')).href);
  const a = asColumns(surveyA), b = asColumns(surveyB);
  if (a.ground.length !== b.ground.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.ground.length; i++) if (a.ground[i] !== b.ground[i] || a.flags[i] !== b.flags[i] || a.height[i] !== b.height[i]) n++;
  return n;
}

/**
 * `{irA, irShaA, surveyA, biomesA?}`: the first plan (its IR, sha, survey and biome grid); `irShaB`, `surveyB`: the second plan's.
 * Returns `{stable, again, replay}`: stable when the second plan gives the same IR sha, or (only when the live survey moved) the
 * first plan's inputs planned again give the first IR sha. `replay` is null when no re-plan was needed.
 */
export async function replayStable({ kitDir, irA, irShaA, surveyA, biomesA = null, irShaB, surveyB }) {
  if (irShaB && irShaB === irShaA) return { stable: true, again: irShaB, replay: null };
  if (!irShaB) return { stable: false, again: irShaB ?? null, replay: null };
  const cols = await movedColumns(kitDir, surveyA, surveyB);
  const { planRegion } = await import(pathToFileURL(path.join(kitDir, 'lib', 'region', 'plan.mjs')).href);
  const re = await planRegion({ programFile: path.join(kitDir, 'regions', `${irA.id}.mjs`), params: irA.params, survey: surveyA, seed: irA.seed, claim: { ...irA.claim, minY: -64, maxY: 319 }, roles: irA.roles, kitVersion: irA.kitVersion, keepOut: irA.keepOut ?? [], ...(biomesA ? { biomes: biomesA } : {}) });
  const replay = { surveyColumnsMoved: cols, replayIr: re.irSha, again: irShaB };
  return { stable: cols !== null && cols > 0 && re.irSha === irShaA, again: irShaB, replay };
}
