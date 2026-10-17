// The kit suite once per gate run (docs/GATES.md "Kit suite once per run"). The runner's unit-kit step runs every kit test file
// and also writes a JUnit report to $GATE_KIT_RESULTS; the gate drivers' unit steps, which used to re-run the whole kit suite (and
// the goldens and the P0 tests) next to their own items, take those files' results from it instead. Only when it is exact:
//
// - the runner set GATE_KIT_RESULTS and GATE_KIT_TREE (unit-kit is in this run), and the report is complete (closing tag);
// - this checkout's kit/ is clean and its tree is the one unit-kit ran (GATE_KIT_TREE: HEAD:kit; unit-kit runs in the run
//   worktree at HEAD, the drivers from this checkout);
// - every requested file is in the report with at least one test and no failure, cancel or file-level error;
// - the call has no flag other than --test-skip-pattern (a subset of tests that all passed passes). A name pattern, or a call
//   that reads the tests' names or diagnostics, is the driver's own item and always runs.
//
// Otherwise (no unit-kit in the run: --only, a named chain, the verifier's re-runs; a failure in one of the files; a dirty kit/)
// it returns null and the driver runs the files itself, exactly as before.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let parsed = null;

function report(file) {
  if (parsed?.file === file) return parsed.files;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!/<\/testsuites>\s*$/.test(text)) return null; // unit-kit still running, or killed mid-write
  const files = {};
  for (const m of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const f = /\bfile="([^"]+)"/.exec(m[1])?.[1];
    if (!f) return null; // a test the report can't place: don't guess
    const k = `kit/test/${path.basename(f)}`;
    const e = (files[k] ??= { tests: 0, failures: 0, skipped: 0 });
    e.tests++;
    const body = m[3] ?? '';
    if (/<failure\b|<error\b/.test(body)) e.failures++;
    else if (/<skipped\b/.test(body)) e.skipped++;
  }
  parsed = { file, files };
  return files;
}

function kitTree(root) {
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const t = git('rev-parse', 'HEAD:kit');
  const s = git('status', '--porcelain', '--', 'kit');
  if (t.status !== 0 || s.status !== 0) return null;
  return s.stdout.trim() ? 'dirty' : t.stdout.trim();
}

/**
 * `args` as given to `node --test` (files, maybe --test-skip-pattern). -> null (run them yourself), or a result shaped like the
 * drivers' nodeTest: { code: 0, pass, fail: 0, failing: [], names: [], notes: [], comments: [], reused }.
 */
export function kitReuse(root, args) {
  const file = process.env.GATE_KIT_RESULTS;
  const tree = process.env.GATE_KIT_TREE;
  if (!file || !tree) return null;
  const flags = args.filter((a) => a.startsWith('--'));
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length || flags.some((f) => !f.startsWith('--test-skip-pattern='))) return null;
  if (kitTree(root) !== tree) return null;
  const rep = report(file);
  if (!rep) return null;
  let pass = 0;
  for (const f of files) {
    const e = rep[f];
    if (!e || e.tests === 0 || e.failures > 0) return null;
    pass += e.tests - e.skipped;
  }
  const reused = `reused from this run's unit-kit (${path.basename(file)}, kit tree ${tree.slice(0, 12)}): ${files.length} file(s), ${pass} pass, 0 fail${flags.length ? `; the run had every test, ${flags.join(' ')} would skip some` : ''}`;
  console.log(`  kit: ${reused}`);
  return { code: 0, pass, fail: 0, failing: [], names: [], notes: [], comments: [], reused };
}
