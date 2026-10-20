// (6c IRR) The kit-only items of slice IRR (docs/CONTRACT.md "Phase 6c slice IRR" §8, §10 item 8): byte identity against the merge base
// with origin/main (a detached worktree ../architect-mc-IRR-main), offline and $0.
//   unchanged(root)   every committed plan fixture (every dir under kit/test/fixtures/plan, the 59 asks included) through the two-plan
//                     flow (its style, its volume spec) here and on the base: answers, overall, the IR (kitVersion normalised) and the
//                     first plan's IR byte-identical. No plan before IRR writes `irrigate` (the member did not exist), so there is no
//                     named exception; the fixtures new on this branch (irrigate's own) are listed, not compared.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { UNCHANGED_EXCEPTIONS as VOCC_EXCEPTIONS } from './gate6cvoc-c.mjs';

/** (The CU/IRR/VOC-c batch) VOC-c's named exceptions (rule.palette supported: the 7 asks with a palette rule, extension/e05 and e16): its own item 4 holds them. */
export const LATER_EXCEPTIONS = VOCC_EXCEPTIONS;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The base worktree at the merge base with origin/main (made or moved there). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-IRR-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  else execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', base]);
  return { dir, base };
}

export async function unchanged(root, { check, log = console.log, only = null } = {}) {
  const { dir: mainDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {}, added: [] };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    if (!fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name))) { out.added.push(name); continue; }
    if (/"irrigate":/.test(JSON.stringify(fx.plan))) { out.added.push(name); continue; }
    let a, b, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    try { b = sig((await planFixture(hOld, mainDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    out.fixtures[name] = { same, ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}), ...(LATER_EXCEPTIONS.includes(name) ? { later: true } : {}) };
    if (LATER_EXCEPTIONS.includes(name)) { check(true, `${name}: ${same ? 'byte-identical' : 'differs'} (VOC-c's named exception, judged by its own item 4)`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.later && !/errors on both/.test(r.err ?? '')).map(([k]) => k);
  if (!only) check(out.n >= 230, `${out.n} committed fixtures without irrigate planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical, no exception of IRR's own (VOC-c's named ones aside); new on this branch (not compared): ${out.added.join(', ')}`);
  return out;
}
