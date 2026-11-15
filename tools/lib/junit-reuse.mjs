// (speed audit A) The mod's Java tests once per gate run, as kit-reuse.mjs does for the kit suite. The runner's unit-mod step runs
// `./gradlew build`: every untagged test class of the mod. The unit steps of 0b, sch, rp, f3 and rs then ran some of those classes again
// with `./gradlew test --tests ...` (a gradle start, the lock, a JVM) for nothing. After unit-mod passes, the runner copies its JUnit
// XML to <out>/unit-mod-junit and hands the dir and the tree it ran (GATE_UNIT_MOD_JUNIT, GATE_UNIT_MOD_TREE). A driver asks here for
// its classes; the answer is the XML's, and only when it is exact:
//
// - unit-mod ran in this run and passed (the env is set), and the dir is still there;
// - this checkout's HEAD tree is the tree unit-mod ran, with no tracked file modified (a dirty checkout runs its own tests);
// - every pattern matches at least one XML file by the drivers' own rule (the file name contains the pattern without its `*`s), and
//   every matched file has tests > 0, not all of them skipped, failures = 0 and errors = 0;
// - (GI2) or it is a method pattern (`[pkg.]Class.method`, the method part may hold `*`s, as gradle's --tests takes it) whose class
//   part matches by that rule and whose method part matches at least one <testcase> (its name without the `(...)` parameter list):
//   every matched testcase must have run, not skipped, with no failure or error; anything else (no match, a parameterised name the
//   rule can't read) is not reused;
// - no system property that changes what the tests do is set for this process (-Dumt.*, -Dledger.*, -Darvx.write, -Dmirror.write,
//   -Dc6.evidence in GRADLE_OPTS / JAVA_TOOL_OPTIONS / JAVA_OPTS: gradle's test task passes umt.*, ledger.* and those three to the
//   test JVM, and unit-mod itself runs with none).
//
// Otherwise it returns null (and says why) and the driver runs the tests itself, exactly as before.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROP_RE = /-D(umt\.|ledger\.|arvx\.write|mirror\.write|c6\.evidence)/;

/** The XML files of `dir` -> [{ file, name, tests, skipped, failures, errors, out }] (out: the system-out text). */
export function readJunitDir(dir) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.xml')).sort()) {
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /<testsuite\b[^>]*?\btests="(\d+)"[^>]*?\bskipped="(\d+)"[^>]*?\bfailures="(\d+)"[^>]*?\berrors="(\d+)"/.exec(x);
    if (!m) continue;
    const out = /<system-out><!\[CDATA\[([\s\S]*?)\]\]><\/system-out>/.exec(x)?.[1] ?? '';
    const cases = [];
    for (const c of x.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = /\bname="([^"]*)"/.exec(c[1])?.[1] ?? '';
      const body = c[2] ?? '';
      cases.push({ name, skipped: /<skipped\b/.test(body), failed: /<(failure|error)\b/.test(body) });
    }
    rows.push({ file: f, name: f.replace(/^TEST-|\.xml$/g, ''), tests: +m[1], skipped: +m[2], failures: +m[3], errors: +m[4], out, cases });
  }
  return rows;
}

/**
 * patterns as given to `--tests` ('*FooTest', '*FooTest*', a class name). -> null (run them yourself), or
 * { code: 0, tests, failures: 0, names, tail, files, reused } shaped like the drivers' javaTests (`ok` is theirs to judge).
 */
export function javaReuse(root, patterns, { log = console.log } = {}) {
  const no = (why) => { log(`  java: not reused (${why}): running ${patterns.join(' ')} here`); return null; };
  const dir = process.env.GATE_UNIT_MOD_JUNIT;
  const tree = process.env.GATE_UNIT_MOD_TREE;
  if (!dir || !tree) return no('unit-mod did not pass in this run before this step');
  if (!fs.existsSync(dir)) return no('unit-mod\'s XML is gone');
  const bad = [process.env.GRADLE_OPTS, process.env.JAVA_TOOL_OPTIONS, process.env.JAVA_OPTS].find((v) => v && PROP_RE.test(v));
  if (bad) return no('a test system property is set');
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const t = git('rev-parse', 'HEAD^{tree}');
  const s = git('status', '--porcelain', '--untracked-files=no');
  if (t.status !== 0 || s.status !== 0) return no('this checkout\'s tree can\'t be read');
  if (s.stdout.trim()) return no('this checkout has modified files');
  if (t.stdout.trim() !== tree) return no(`tree ${t.stdout.trim().slice(0, 12)} is not the one unit-mod ran, ${tree.slice(0, 12)}`);
  let rows;
  try { rows = readJunitDir(dir); } catch (e) { return no(`unit-mod's XML can't be read (${e.message})`); }
  const picked = new Map();
  const methods = []; // (GI2) [{ pattern, rows, cases }]
  for (const p of patterns) {
    const key = p.replaceAll('*', '');
    const hit = rows.filter((r) => r.file.includes(key));
    if (hit.length) {
      for (const r of hit) picked.set(r.file, r);
      continue;
    }
    const m = methodPattern(p);
    if (!m) return no(`${p} is not in unit-mod's XML`);
    const cls = rows.filter((r) => r.file.includes(m.cls));
    if (!cls.length) return no(`${p}: class ${m.cls} is not in unit-mod's XML`);
    const cases = cls.flatMap((r) => r.cases.filter((c) => m.re.test(c.name.replace(/\(.*$/, ''))).map((c) => ({ ...c, file: r.file, cls: r.name })));
    if (!cases.length) return no(`${p}: no testcase of ${cls.map((r) => r.name).join(', ')} matches ${m.method}`);
    if (cases.some((c) => c.skipped)) return no(`${p}: a matched testcase was skipped in unit-mod`);
    if (cases.some((c) => c.failed)) return no(`${p}: a matched testcase failed in unit-mod`);
    methods.push({ pattern: p, cases });
  }
  const files = [...picked.values()];
  for (const r of files) {
    if (r.tests === 0) return no(`${r.name} has no tests in unit-mod's XML`);
    if (r.skipped >= r.tests) return no(`${r.name}: every test was skipped in unit-mod (nothing ran)`);
    if (r.failures > 0 || r.errors > 0) return no(`${r.name} failed in unit-mod`);
  }
  // a method pattern's cases count once, and not again when their whole class is picked too
  const whole = new Set(files.map((r) => r.file));
  const extra = new Map();
  for (const mm of methods) for (const c of mm.cases) if (!whole.has(c.file)) extra.set(`${c.file}#${c.name}`, c);
  const byCls = new Map();
  for (const c of extra.values()) byCls.set(c.cls, (byCls.get(c.cls) ?? 0) + 1);
  const tests = files.reduce((a, r) => a + r.tests, 0) + extra.size;
  const reused = `reused from this run's unit-mod (${path.basename(dir)}, tree ${tree.slice(0, 12)}): ${files.length + byCls.size} class(es)${byCls.size ? ` (${byCls.size} by method)` : ''}, ${tests} tests, 0 failures`;
  log(`  java: ${reused}`);
  return { code: 0, tests, failures: 0, names: [...files.map((r) => `${r.name}: ${r.tests}/0`), ...[...byCls].map(([n, k]) => `${n} (methods): ${k}/0`)], tail: [reused], files, reused };
}

/** (GI2) `[pkg.]Class.method` (gradle's --tests with a method part; `*` in the method part) -> { cls, method, re }, else null. */
export function methodPattern(p) {
  const i = p.lastIndexOf('.');
  if (i <= 0 || i === p.length - 1) return null;
  const cls = p.slice(0, i).replaceAll('*', '');
  const method = p.slice(i + 1);
  // the class part ends in a class name (upper case first), the method part starts lower case or with a `*`
  if (!/(^|\.)[A-Z][\w$]*$/.test(cls) || !/^[a-z_*$][\w$*]*$/.test(method)) return null;
  const re = new RegExp(`^${method.split('*').map((s) => s.replace(/[$]/g, '\\$')).join('.*')}$`);
  return { cls, method, re };
}
