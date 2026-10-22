// (6c close-out A) The kit items' byte identity (docs/CONTRACT.md "Phase 6c close-out A" §11 item 10): every committed plan fixture
// planned here and on a base checkout (a detached worktree ../architect-mc-coA-base at the merge base with origin/main), compared as
// S3's gate did (answers, overall, the IR with kitVersion normalised, the first plan's IR), plus the artifact (its palette rows). $0, no game.
//   unchanged(root, {check, log, only, moved})   moved: {fixture: 'the item that moves it, and why'} (named, not judged)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixtures, planFixture } from './gate6ckc-kit.mjs';
import { normSiblingIr } from './batch-0410.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The base worktree (made at the merge base with origin/main when missing; an existing one is used as it stands). */
export function baseTree(root) {
  const dir = path.resolve(root, '..', 'architect-mc-coA-base');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main']).toString().trim();
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', dir, base]);
  }
  return { dir, base: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim() };
}

export async function unchanged(root, { check = null, log = console.log, only = null, moved = {} } = {}) {
  const { dir: baseDir, base } = baseTree(root);
  const H = (d) => import(pathToFileURL(path.join(d, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(baseDir)];
  const sig = (r) => ({ answers: sha256(JSON.stringify(r.check.parts)), overall: r.check.overall, ir: sha256(normSiblingIr(r.res.irJson)), first: r.first && r.first !== r ? sha256(normSiblingIr(r.first.res?.irJson ?? JSON.stringify(r.first))) : null, art: sha256(normSiblingIr(JSON.stringify(r.artifact ?? null))) });
  const out = { base, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), fixtures: {} };
  for (const [name, fx] of fixtures(root)) {
    if (only && !only.test(name)) continue;
    const existsOld = fs.existsSync(path.join(baseDir, 'kit', 'test', 'fixtures', 'plan', name));
    let a = null, b = null, err = null;
    try { a = sig((await planFixture(hNew, root, fx)).r); } catch (e) { err = `head: ${String(e.message).slice(0, 160)}`; }
    if (existsOld) { try { b = sig((await planFixture(hOld, baseDir, fx)).r); } catch (e) { err = (err ? `${err}; ` : '') + `base: ${String(e.message).slice(0, 160)}`; } }
    const same = !!a && !!b && a.answers === b.answers && a.overall === b.overall && a.ir === b.ir && a.first === b.first && a.art === b.art;
    out.fixtures[name] = { existsOld, same, ...(err ? { err } : {}), ...(a && b && !same ? { head: a, base: b } : {}), ...(!existsOld && a ? { overall: a.overall } : {}) };
    if (!existsOld) { log(`note ${name}: new on this branch (${a ? a.overall : err})`); continue; }
    if (moved[name]) { out.fixtures[name].moved = moved[name]; log(`note ${name}: ${same ? 'byte-identical' : 'differs'}; ${moved[name]}`); continue; }
    if (check) check(same || (!a && !b), `${name}: ${same ? 'byte-identical (answers, overall, IR, first plan)' : !a && !b ? `errors on both (${err})` : `DIFFERS ${err ?? ''}`}`);
  }
  const rows = Object.entries(out.fixtures).filter(([, r]) => r.existsOld);
  out.n = rows.length;
  out.same = rows.filter(([, r]) => r.same).length;
  out.differ = rows.filter(([, r]) => !r.same).map(([k]) => k);
  return out;
}
