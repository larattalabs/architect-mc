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

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** §8's named exceptions: fixture -> why it moves. */
export const EXCEPT = Object.freeze({
  'extension/e16_every_reserved_b.json': 'F3: form.giant_tree supported (f_giant_tree, a giant oak near the stone, now fits; it left the reserved list)',
});

/** The base worktree at the merge base with origin/main. */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-F3-main');
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
  const { checkRegion } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'check.mjs')).href);
  const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(norm(r)), first: r.first && r.first !== r ? sha256(norm(r.first)) : null });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {}, m18: {}, m19: {} };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    const existsOld = fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a, b, err = null, headRun = null;
    try { headRun = await planFixture(hNew, root, fx); a = sig(headRun.r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) {
      try { const { r } = await planFixture(hOld, mainDir, fx); b = sig(r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; }
    }
    // M18 and M19 on this head's IR (recorded; predicted 0, any finding named)
    if (headRun) try {
      const { r, s } = headRun;
      const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta, rules: ['M18', 'M19'] });
      const f18 = rep.findings.filter((f) => f.rule === 'M18'), f19 = rep.findings.filter((f) => f.rule === 'M19');
      out.m18[name] = { count: f18.reduce((x, f) => x + f.count, 0), parts: f18.map((f) => f.part), leaves: rep.metrics.M18?.leaves ?? 0 };
      out.m19[name] = { count: f19.reduce((x, f) => x + f.count, 0), parts: f19.map((f) => f.part) };
    } catch (e) { out.m18[name] = { err: String(e.message).slice(0, 160) }; }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first;
    const ex = EXCEPT[name] ?? null;
    out.fixtures[name] = { existsOld, same, ...(ex ? { excepted: ex } : {}), ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch`); continue; }
    if (ex) { check(!same, `${name}: excepted by name (${ex}): ${same ? 'UNCHANGED (the exception did not move)' : 'differs, as named'}`); continue; }
    check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? JSON.stringify({ head: a, base: b })}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same && !r.excepted).map(([k]) => k);
  if (!only) check(out.n >= 230, `${out.n} committed fixtures planned (every dir, the 59 asks included)`);
  check(out.differ.length === 0, `${out.same} of ${out.n} byte-identical; the rest exactly the named exceptions (${Object.keys(EXCEPT).join(', ')})`);
  const m18 = Object.entries(out.m18).filter(([, v]) => v.count > 0), m19 = Object.entries(out.m19).filter(([, v]) => v.count > 0);
  log(`M18 (recorded): ${m18.length} fixture(s) with findings: ${m18.map(([k, v]) => `${k} (${v.count}: ${v.parts.join(', ')})`).join('; ') || 'none'}`);
  log(`M19 (recorded): ${m19.length} fixture(s) with findings: ${m19.map(([k, v]) => `${k} (${v.count}: ${v.parts.join(', ')})`).join('; ') || 'none'}`);
  return out;
}
