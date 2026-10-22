// (6c S3) The kit-only items of slice S3 (docs/CONTRACT.md "Phase 6c slice S3" §8, §9 item 5): byte identity against the merge base
// (a detached worktree ../architect-mc-S3-main at the merge base with origin/main) and the 59 asks before and after. $0, no game.
//   unchanged(root)   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan
//                     flow here and on the base: answers, overall, the IR (kitVersion normalised) and the first plan's IR byte-identical.
//                     A fixture new on this branch is planned here only (recorded). No fixture on the base carries `terraces`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { SIBLING_MOVED, normSiblingIr } from './batch-0410.mjs';
import { inSlice } from './gate-part.mjs';
import { syncBaseTree } from './base-tree.mjs';
import * as CP from './corpus-plan.mjs'; // (gate speed 3) the plans from the run's shared store, prewarmed on every core

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The base worktree at the merge base with origin/main (made or moved there): S3's own, never another builder's. */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-S3-main');
  return syncBaseTree(root, dir); // (turbo) one fetch and checkout at a time; left alone at the base
}

const hasTerraces = (plan) => /"terraces":\s*[{t]/.test(JSON.stringify(plan));

export async function unchanged(root, { check, log = console.log, only = null, slice = null } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const { hNew, hOld } = await CP.corpusHelpers(root, mainDir);
  // ((batch v0.41.0) kitVersion and FL's street ext normalised; a fixture a sibling slice moves by name is that slice's to judge)
  const norm = (r) => normSiblingIr(r.res.irJson);
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  const all = fixtures(root);
  await CP.prewarm(root, CP.fixtureJobs(root, all.filter(([name], k) => !(only && !only.test(name)) && inSlice(k, slice)).flatMap(([name, fx]) => [[root, root, fx, 'head', name], ...(fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name)) ? [[mainDir, mainDir, fx, 'base', name]] : [])])), { log });
  let i = -1;
  let elsewhere = 0; // (a split unit step) fixtures another part plans: counted, not planned here
  for (const [name, fx] of all) {
    i++;
    if (only && !only.test(name)) continue;
    // (counted as the whole loop's rows count: those on the base)
    if (!inSlice(i, slice)) { if (fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name))) elsewhere++; continue; }
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a, b, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) {
      try { b = sig((await planFixture(hOld, mainDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    out.fixtures[name] = { existsOld, same, terraces: hasTerraces(fx.plan), ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}), ...(!existsOld && a ? { overall: a.overall } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch (${a ? a.overall : err})`); continue; }
    if (SIBLING_MOVED[name]) { out.fixtures[name].sibling = SIBLING_MOVED[name]; log(`note ${name}: ${same ? 'byte-identical' : 'differs'}; ${SIBLING_MOVED[name]}`); continue; }
    if (check) check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length + elsewhere;
  if (slice) out.slice = { slices: slice, planned: rows.length, elsewhere };
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.sibling).map(([k]) => k);
  out.baseWithTerraces = rows.filter(([, r]) => r.terraces).map(([k]) => k);
  log(CP.statsLine());
  return out;
}
