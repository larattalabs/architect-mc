// (6c F3) The kit-only items of slice F3 (docs/CONTRACT.md "Phase 6c slice F3" §8, §9, §10 items 2 and 9): byte identity against the
// merge base (a detached worktree ../architect-mc-F3-main) and the recorded plans' before and after. $0, no game.
//   unchanged(root)  every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan flow
//                    (its style, its volume spec) here and on the base: answers, overall, the IR (kitVersion normalised) and the first
//                    plan's IR byte-identical, except the fixtures named in EXCEPT; M18 and M19 recorded on every fixture (this head's
//                    checker over this head's IR).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { SIBLING_MOVED, STORM_MOVED, normSiblingIr } from './batch-0410.mjs';
import { inSlice } from './gate-part.mjs';
import { identicalToBase, skippedLine, syncBaseTree } from './base-tree.mjs';
import * as CP from './corpus-plan.mjs'; // (gate speed 3) the plans from the run's shared store, prewarmed on every core
import { DERIVE } from './corpus-derive.mjs';
import { F7A_MOVED } from './f7a-norm.mjs'; // (7a foundation) the fixtures the foundation's catalogue changes move by name
import { THEME_REST_MOVED } from './theme-rest-norm.mjs'; // (theme rest) the tunnel fixtures' flush lamp

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** §8's named exceptions: fixture -> why it moves. */
export const EXCEPT = Object.freeze({
  ...THEME_REST_MOVED,
  ...F7A_MOVED, // ((7a foundation) its catalogue changes' named movers)
  'extension/e16_every_reserved_b.json': 'F3: form.giant_tree supported (f_giant_tree, a giant oak near the stone, now fits; it left the reserved list)',
  // (fix/survival-off-storm) their trees had a log held only from above or by leaves: now a leaf or gone; the answers unchanged
  ...Object.fromEntries(STORM_MOVED.map((f) => [f, 'fix/survival-off-storm: giantTree leaves no unsupported log (the answers unchanged, the tree cells move)'])),
});

/** The base worktree at the merge base with origin/main. */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-F3-main');
  return syncBaseTree(root, dir); // (turbo) one fetch and checkout at a time; left alone at the base
}

export async function unchanged(root, { check, log = console.log, only = null, slice = null, baseDir = null } = {}) {
  // (baseDir: a test's own base tree, kit/test/gate-corpus-plan.test.mjs; a gate run always uses the merge base's worktree)
  // (speed audit D, K1) base kit and scenarios trees identical to HEAD's: the base side (its plans and the comparison) is skipped;
  // the head's own M18/M19 still run
  const sk = baseDir ? null : identicalToBase(root);
  const { dir: mainDir, base } = sk ? { dir: root, base: sk.base } : baseDir ? { dir: baseDir, base: 'given' } : baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const { hNew, hOld } = sk ? { hNew: await CP.helpers(root, { derive: [...CP.HEAD_DERIVE], headRoot: root }), hOld: null } : await CP.corpusHelpers(root, mainDir);
  if (sk) check(true, skippedLine(sk));
  // (M18/M19: corpus-derive.mjs f3M18M19, computed where the plan ran; without the store (GATE_PLAN_CACHE=0), here, as before)
  const m1819 = async (r, s) => r.derived?.f3M18M19 ?? DERIVE.f3M18M19(r, { survey: s.bytes }, { headRoot: root });
  // ((batch v0.41.0) kitVersion and FL's street ext normalised; a fixture a sibling slice moves by name is that slice's to judge)
  const norm = (r) => normSiblingIr(r.res.irJson);
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {}, m18: {}, m19: {} };
  const all = fixtures(root);
  await CP.prewarm(root, CP.fixtureJobs(root, all.filter(([name], k) => !(only && !only.test(name)) && inSlice(k, slice)).flatMap(([name, fx]) => [[root, root, fx, 'head', name], ...(!sk && fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name)) ? [[mainDir, mainDir, fx, 'base', name]] : [])])), { log });
  let i = -1;
  let elsewhere = 0; // (a split unit step) fixtures another part plans: counted, not planned here
  for (const [name, fx] of all) {
    i++;
    if (only && !only.test(name)) continue;
    // (counted as the whole loop's rows count: those on the base)
    if (!inSlice(i, slice)) { if (fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name))) elsewhere++; continue; }
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a, b, err = null, headRun = null;
    try { headRun = await planFixture(hNew, root, fx); a = sig(headRun.r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (sk) b = a; // (the same kit and scenarios: the base's signature is the head's)
    if (existsOld && !sk) {
      try { const { r } = await planFixture(hOld, mainDir, fx); b = sig(r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    }
    // M18 and M19 on this head's IR (recorded; predicted 0, any finding named)
    if (headRun) {
      const m = await m1819(headRun.r, headRun.s);
      if (m.err !== undefined) out.m18[name] = { err: m.err };
      else { out.m18[name] = m.m18; out.m19[name] = m.m19; }
    }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const ex = EXCEPT[name] ?? null;
    out.fixtures[name] = { existsOld, same, ...(ex ? { excepted: ex } : {}), ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch`); continue; }
    // (release v0.42.0) on a base that already has the storm fix (main since 52c2707f) a storm fixture plans the same: noted, not failed
    if (ex && STORM_MOVED.includes(name) && same) { log(`note ${name}: excepted by name (${ex}): unchanged against this base (it has the storm fix already)`); continue; }
    if (ex && STORM_MOVED.includes(name)) { check(!same && !!a && !!b && a.answers === b.answers && a.overall === b.overall, `${name}: excepted by name (${ex}): ${same ? 'UNCHANGED (the exception did not move)' : a && b && a.answers === b.answers && a.overall === b.overall ? 'its IR differs, its answers and overall the same, as named' : `its answers or overall moved ${JSON.stringify({ head: a, base: b })}`}`); continue; }
    // ((6c close-out A) on a base that already has F3 (main since v0.41.0) an F3 exception plans the same: noted, not failed)
    if (ex) { if (same) log(`note ${name}: excepted by name (${ex}): unchanged against this base (it has F3 already)`); else check(true, `${name}: excepted by name (${ex}): differs, as named`); continue; }
    if (SIBLING_MOVED[name]) { out.fixtures[name].sibling = SIBLING_MOVED[name]; log(`note ${name}: ${same ? 'byte-identical' : 'differs'}; ${SIBLING_MOVED[name]}`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length + elsewhere;
  if (slice) out.slice = { slices: slice, planned: rows.length, elsewhere };
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.excepted && !r.sibling).map(([k]) => k);
  if (!only) check(out.n >= 230, `${out.n} committed fixtures planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical; the rest exactly the named exceptions (${Object.keys(EXCEPT).join(', ')})`);
  const m18 = Object.entries(out.m18).filter(([, v]) => v.count > 0), m19 = Object.entries(out.m19).filter(([, v]) => v.count > 0);
  log(`M18 (recorded): ${m18.length} fixture(s) with findings: ${m18.map(([k, v]) => `${k} (${v.count}: ${v.parts.join(', ')})`).join('; ') || 'none'}`);
  log(`M19 (recorded): ${m19.length} fixture(s) with findings: ${m19.map(([k, v]) => `${k} (${v.count}: ${v.parts.join(', ')})`).join('; ') || 'none'}`);
  log(CP.statsLine());
  return out;
}
