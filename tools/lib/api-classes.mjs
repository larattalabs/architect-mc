// (GI2, GR-a item 8) Which compiled mod classes tools/api-compat.mjs checks against when no classesDir is given.
//
// A change run with shards put api-compat (cwd run:, the lane's run worktree) on its offline lane o1, a worktree no build ever ran in:
// no mod/build/classes, so every member of every old jar read as MISSING (951 of them). The classes built from this head are, in order:
// where unit-mod built in this run (GATE_UNIT_MOD_RUN), the run's frozen source (GATE_FROZEN_SOURCE: gate-run built its classes at
// setup), then this checkout (outside the runner: as before). A dir with no .class file is never used, and when none has any the caller
// fails with a clear message instead of a MISSING list.
import fs from 'node:fs';
import path from 'node:path';

const dirsOf = (base) => ['main', 'client'].map((s) => path.join(base, 'mod', 'build', 'classes', 'java', s));

/** Whether a dir holds at least one .class file (any depth). */
export function hasClasses(dir) {
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.class')) return true;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return false;
}

/** -> { dirs, source, ok, tried: [base] }: the first base whose main classes exist; ok false when none has any. */
export function resolveClassDirs({ root, env = process.env } = {}) {
  const cands = [['GATE_UNIT_MOD_RUN', env.GATE_UNIT_MOD_RUN], ['GATE_FROZEN_SOURCE', env.GATE_FROZEN_SOURCE], ['this checkout', root]].filter(([, b]) => b);
  for (const [source, base] of cands) {
    const dirs = dirsOf(path.resolve(base));
    if (hasClasses(dirs[0])) return { dirs, source: `${source} (${base})`, ok: true, tried: cands.map(([, b]) => b) };
  }
  return { dirs: dirsOf(path.resolve(root)), source: 'none', ok: false, tried: cands.map(([, b]) => b) };
}

/** The failure line for classes dirs without a class file. */
export function noClassesMessage(dirs, tried) {
  return `FAIL api-compat: no compiled classes in ${dirs.join(', ')}${tried?.length > 1 ? ` (also looked in ${tried.slice(0, -1).join(', ')})` : ''}: `
    + 'build first (cd mod && ./gradlew --offline classes), or in a gate run let it wait for unit-mod; nothing was compared';
}
