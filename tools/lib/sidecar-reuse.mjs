// The sidecar suite once per gate run (docs/GATES.md "Sidecar suite once per run"; speed audit D, B3), the twin of kit-reuse.mjs.
// The runner's unit-sidecar step runs every sidecar test file and writes a JUnit report ($GATE_SIDECAR_RESULTS, one <testsuite> per
// file); the drivers' unit steps, which ran their own sidecar test files again with `npx vitest run <files>`, take pass/fail from
// that report instead. Only when it is exact:
//
// - the runner set GATE_SIDECAR_RESULTS and GATE_SIDECAR_TREE (unit-sidecar is in this run) and the report is complete (closing tag);
// - this checkout's sidecar/, kit/ and scenarios/ are clean and their trees are the ones unit-sidecar ran (GATE_SIDECAR_TREE);
// - every requested file has a suite in the report with at least one test, no failure, no error and no skipped test.
//
// Otherwise it returns null and says why (`  sidecar: not reused (<reason>); running <files>`), and the driver runs the files itself,
// exactly as before. A call with a name filter (-t) or a reporter flag of its own is the driver's own item: it never calls this.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let parsed = null;

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((m) => [m[1], unxml(m[2])]));

function report(file) {
  let text, stamp;
  try {
    const st = fs.statSync(file);
    stamp = `${st.size}:${st.mtimeMs}`;
    if (parsed?.file === file && parsed.stamp === stamp) return parsed.files;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!/<\/testsuites>\s*$/.test(text)) return null; // unit-sidecar still running, or killed mid-write
  const files = {};
  for (const m of text.matchAll(/<testsuite\s([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const a = attrs(m[1]);
    if (!a.name) return null;
    const cases = [...m[2].matchAll(/<testcase\s([^>]*?)\/?>/g)].map((c) => attrs(c[1]));
    files[a.name] = { tests: Number(a.tests ?? 0), failures: Number(a.failures ?? 0), errors: Number(a.errors ?? 0), skipped: Number(a.skipped ?? 0), cases };
  }
  parsed = { file, stamp, files };
  return files;
}

/** The sidecar tree the run's unit-sidecar tests: HEAD's sidecar/, kit/ and scenarios/, or 'dirty'. */
export function sidecarTree(root) {
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const t = ['sidecar', 'kit', 'scenarios'].map((d) => git('rev-parse', `HEAD:${d}`));
  const s = git('status', '--porcelain', '--', 'sidecar', 'kit', 'scenarios');
  if (t.some((x) => x.status !== 0) || s.status !== 0) return null;
  return s.stdout.trim() ? 'dirty' : t.map((x) => x.stdout.trim().slice(0, 12)).join('.');
}

/**
 * `files` as given to `vitest run` (paths relative to sidecar/, e.g. test/jobs.test.ts). -> null (run them yourself; the reason is
 * logged), or { status: 0, code: 0, stdout, stderr: '', out, reused } with vitest's two summary lines for the files. `jsonOut`: a path to
 * write a vitest `--reporter=json`-shaped file (testResults[].assertionResults[]) for the drivers that read the tests' names.
 */
export function sidecarReuse(root, files, { jsonOut = null } = {}) {
  const no = (why) => {
    if (process.env.GATE_SIDECAR_RESULTS) console.log(`  sidecar: not reused (${why}); running ${files.join(' ')}`);
    return null;
  };
  const file = process.env.GATE_SIDECAR_RESULTS;
  const tree = process.env.GATE_SIDECAR_TREE;
  if (!file || !tree) return null; // no unit-sidecar in this run (--only, a named chain, a re-run by hand): the driver's own run, as before
  const now = sidecarTree(root);
  if (now !== tree) return no(`the sidecar/kit/scenarios tree is ${now === 'dirty' ? 'dirty' : `${now} not unit-sidecar's ${tree}`}`);
  const rep = report(file);
  if (!rep) return no('unit-sidecar\'s report is missing or incomplete');
  let tests = 0;
  const results = [];
  for (const f of files) {
    const e = rep[f];
    if (!e) return no(`${f} is not in the report`);
    if (e.tests === 0 || e.failures > 0 || e.errors > 0 || e.skipped > 0) return no(`${f}: ${e.tests} tests, ${e.failures} failed, ${e.errors} errors, ${e.skipped} skipped`);
    tests += e.tests;
    results.push({ name: path.join(root, 'sidecar', f), status: 'passed', assertionResults: e.cases.map((c) => ({ fullName: c.name.split(' > ').join(' '), title: c.name.split(' > ').pop(), status: 'passed' })) });
  }
  const stdout = ` Test Files  ${files.length} passed (${files.length})\n      Tests  ${tests} passed (${tests})\n`;
  const reused = `reused from this run's unit-sidecar (${path.basename(file)}, tree ${tree}): ${files.length} file(s), ${tests} pass, 0 fail`;
  console.log(`  sidecar: ${reused}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ numPassedTests: tests, numFailedTests: 0, success: true, testResults: results }));
  return { status: 0, code: 0, stdout, stderr: '', out: stdout, reused };
}
