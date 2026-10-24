// (7a) The kit-only items the 7a slices share (docs/CONTRACT.md "Batch 7a" rules, "Phase 7a foundation" §7): byte identity against
// the merge base and the recorded plans' gap table. $0, no game.
//   unchanged(root, o)   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the
//                        two-plan flow (its style, its volume spec) here and on the merge base (a detached worktree
//                        ../architect-mc-<o.base>-main): answers, overall, the IR (kitVersion normalised) and the first plan's IR
//                        byte-identical, except the fixtures named in o.except (each with why it moves). A fixture new on this branch
//                        is noted, not compared. KC's `planFixture` plans each one (the same call, so the run's plan store is shared).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normIrJson } from './fl-norm.mjs';
import { inSlice } from './gate-part.mjs';
import { syncBaseTree } from './base-tree.mjs';
import * as CP from './corpus-plan.mjs';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The base worktree (../architect-mc-<name>-main) at the merge base with origin/main (made or moved there). */
export function baseTree(root, name) {
  return syncBaseTree(root, path.resolve(root, '..', `architect-mc-${name}-main`));
}

export async function unchanged(root, { check, log = console.log, base: baseName, except = {}, landed = {}, only = null, slice = null, mergedIf = null } = {}) {
  const { dir: mainDir, base } = baseTree(root, baseName);
  // (`mergedIf`: a repo path the excepted change brings; once the base has it (the change merged to main), an excepted fixture
  // identical on both is the exception already on the base, as KC's onBase reads it)
  const exMerged = !!mergedIf && fs.existsSync(path.join(mainDir, mergedIf));
  const { hNew, hOld } = await CP.corpusHelpers(root, mainDir);
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(normIrJson(r.res?.irJson)), first: r.first && r.first !== r ? sha256(normIrJson(r.first.res?.irJson)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  const all = fixtures(root);
  const onBase = (name) => fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
  const mine = all.filter(([name], k) => !(only && !only.test(name)) && inSlice(k, slice));
  await CP.prewarm(root, CP.fixtureJobs(root, mine.flatMap(([name, fx]) => [[root, root, fx, 'head', name], ...(onBase(name) ? [[mainDir, mainDir, fx, 'base', name]] : [])])), { log });
  let i = -1, elsewhere = 0;
  for (const [name, fx] of all) {
    i++;
    if (only && !only.test(name)) continue;
    if (!inSlice(i, slice)) { if (onBase(name)) elsewhere++; continue; }
    const existsOld = onBase(name);
    let a = null, b = null, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) try { b = sig((await planFixture(hOld, mainDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const ex = except[name] ?? null;
    out.fixtures[name] = { existsOld, same, ...(ex ? { excepted: ex } : {}), ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch`); continue; }
    // a mover that already landed on main (the foundation, through CW) is identical against the base: either way is fine
    if (!ex && landed[name]) { check(true, `${name}: named mover already on main (${landed[name]}): ${same ? 'identical against the base' : 'differs, as named'}`); if (!same) out.fixtures[name].excepted = landed[name]; continue; }
    if (ex) { check(!same || exMerged, `${name}: excepted by name (${ex}): ${same ? (exMerged ? `identical: the base already has it (${mergedIf} on the base; the exception merged)` : 'UNCHANGED (the exception did not move)') : 'differs, as named'}`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length + elsewhere;
  if (slice) out.slice = { slices: slice, planned: rows.length, elsewhere };
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.excepted).map(([k]) => k);
  out.moved = rows.filter(([, r]) => !r.same && r.excepted).map(([k]) => k);
  if (!only && !slice) check(out.n >= 230, `${out.n} committed fixtures planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical; the rest exactly the named exceptions (${Object.keys(except).join(', ') || 'none'})`);
  log(CP.statsLine());
  return out;
}
