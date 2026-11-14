#!/usr/bin/env node
// Scoped unit suites (docs/GATES.md "Speed rules" 8, "Scoped unit suites"): the kit (node --test), sidecar (vitest) and Gradle
// (JUnit) tests for the files a slice changed plus their direct dependents. The full suites run once, at the batch merge.
//
//   node tools/unit-scope.mjs                      the diff origin/main...HEAD plus the working tree's changes: what it picks, and why
//   node tools/unit-scope.mjs --since <ref>        another base (three dots: since the merge base)
//   node tools/unit-scope.mjs --range A..B         any range (A...B too), e.g. a merged slice's commits; the graph is the working tree's
//   node tools/unit-scope.mjs <file> ...           explicit paths
//   [--run]                                        run the picks under nice -n 10 (kit, then sidecar, then Gradle); exit 1 if any fails
//   [--json]                                       machine-readable
//
// The selection. S0 = the changed files; D1 = the files that reference one of S0 directly (an import, a literal repo path, a
// path.join tail, a `new URL(.., import.meta.url)`; for Java: an import, the same package and the simple name, a literal path or
// classpath resource). A test is picked when it is in S0, or references a file of S0 or of D1 directly ("the files it touched plus
// their direct dependents"). Each pick prints its chain (test <- dependent <- changed file).
// Full suites instead: a file of SHARED_CORE selects the full suites it names; a deleted file, or one no test reaches within those
// two hops and that impact.ignore (tools/gate-chains.json: docs and the like) does not cover, selects the full suite of its
// language (mod/, devserver/, apitest/: Gradle; sidecar/: vitest; everything else: kit). Never a silent skip. One exception, printed:
// a gate driver (a step's root in tools/step-inputs.json, e.g. tools/gate7caq.mjs) no unit reaches is run by its own gate step, which
// the slice runs anyway; it gets `node --check` here instead of the full kit suite.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { moduleClosure, dirtyPaths } from './lib/step-inputs.mjs';
import { globToRe } from './gate-impact.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const ALL = ['kit', 'sidecar', 'gradle'];
const J = 'mod/src/main/java/dev/larattalabs/architect';

/**
 * Shared core: a change here runs the full suites named (speed rule 8: the checker core, the journal and ledger, the build pipeline;
 * plus the package and lock files, the test configs and this tool with what it builds on).
 */
export const SHARED_CORE = [
  { name: 'checker core', paths: ['kit/check.mjs', 'kit/lib/check.mjs', 'kit/lib/region/check.mjs'], suites: ['kit', 'sidecar'] },
  { name: 'journal', paths: [`${J}/journal/**`], suites: ['gradle'] },
  { name: 'ledger', paths: [`${J}/survival/Ledger.java`, `${J}/survival/StockLedger.java`, `${J}/apiimpl/JobLedger.java`, `${J}/apiimpl/AwaitingLedger.java`], suites: ['gradle'] },
  { name: 'ledger lint', paths: ['tools/lib/pa-ledger.mjs'], suites: ['kit'] },
  { name: 'build pipeline', paths: ['kit/build.mjs', 'sidecar/scripts/**', '**/*.gradle', '**/gradle.properties', 'mod/gradle/**', 'mod/gradlew', 'mod/gradlew.bat'], suites: ALL },
  { name: 'packages and lock files', paths: ['**/package.json', '**/package-lock.json'], suites: ALL },
  { name: 'test config', paths: ['sidecar/vitest.config.ts', 'sidecar/tsconfig.json'], suites: ['sidecar'] },
  { name: 'unit-scope itself', paths: ['tools/unit-scope.mjs', 'tools/lib/step-inputs.mjs', 'tools/gate-impact.mjs'], suites: ALL },
].map((c) => ({ ...c, res: c.paths.map(globToRe) }));

/** The suite a file falls back to: mod/, devserver/, apitest/ Gradle; sidecar/ vitest; the rest (kit/, tools/, scenarios/, ...) kit. */
export function languageOf(f) {
  if (/^(mod|devserver|apitest)\//.test(f)) return 'gradle';
  if (f.startsWith('sidecar/')) return 'sidecar';
  return 'kit';
}

const JAVA_SRC = /^mod\/src\/(main|client|test)\/java\/(.+)\.java$/;
const isKitTest = (f) => /^kit\/test\/[^/]+\.test\.mjs$/.test(f);
const isSidecarTest = (f) => /^sidecar\/test\/.+\.test\.ts$/.test(f);
const JUNIT = /@(Test|ParameterizedTest|TestFactory|RepeatedTest|TestTemplate)\b/;

/** The tags mod/build.gradle's `test` task excludes (UMT's own tasks run those): a --tests filter naming such a class finds nothing. */
export function excludedTags(gradleText) {
  const m = /excludeTags\s+([^\n]+)/.exec(gradleText ?? '');
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/** The class-level tags of a Java file (the @Tag lines before its first class/record/interface declaration). */
function classTags(text) {
  const head = text.slice(0, text.search(/\n(public\s+|final\s+|abstract\s+)*(class|record|interface|enum)\s/) + 1 || 0);
  return [...head.matchAll(/@Tag\("([^"]+)"\)/g)].map((x) => x[1]);
}

/** .js specifiers that name a tracked .ts (TypeScript's NodeNext convention) rewritten to the .ts, so the import edge resolves. */
function tsSpecifiers(f, text, has) {
  const dir = path.posix.dirname(f);
  return text.replace(/(['"])(\.{1,2}\/[^'"\n]+)\.js\1/g, (m, q, p) => (has.has(path.posix.normalize(path.posix.join(dir, `${p}.ts`))) ? `${q}${p}.ts${q}` : m));
}

/** Literal paths in a Java file's strings: "../kit/x" (from mod/), "kit/x" (repo root), "/arvx/x" (a classpath resource). */
function javaLiteralRefs(f, text, has, dirs) {
  const out = { files: new Set(), globs: new Set() };
  const add = (p) => {
    const n = path.posix.normalize(p).replace(/\/$/, '');
    if (n.startsWith('..') || n === '.') return false;
    if (has.has(n)) out.files.add(n);
    else if (dirs.has(n) && n.split('/').length > 1) out.globs.add(`${n}/**`);
    else return false;
    return true;
  };
  for (const m of text.matchAll(/"([\w@./-]+)"/g)) {
    const s = m[1];
    if (s.startsWith('../')) add(path.posix.join('mod', s));
    else if (/^(kit|tools|scenarios|sidecar|mod|eval|devserver|apitest)\//.test(s)) add(s);
    else if (s.startsWith('src/')) add(path.posix.join('mod', s));
    else if (s.startsWith('/') && s.length > 1) {
      const r = s.slice(1);
      add(`mod/src/test/resources/${r}`) || add(`mod/src/main/resources/${r}`) || add(`mod/src/client/resources/${r}`);
    }
  }
  return out;
}

/**
 * The direct-reference graph over the tree `files` (a Set of repo paths). `read(p)` gives a file's text. Returns
 * { refs: Map file -> Set of files it references, globs: Map file -> [dir globs it references], tests: Map test -> suite, gradle:
 * Map java test file -> FQCN, excluded: [java test files the `test` task excludes] }.
 */
export function buildGraph(files, read) {
  const has = files instanceof Set ? files : new Set(files);
  const dirs = new Set();
  for (const f of has) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  const refs = new Map();
  const globs = new Map();
  const tests = new Map();
  const gradle = new Map();
  const excluded = [];
  const text = (p) => {
    try {
      return read(p);
    } catch {
      return '';
    }
  };
  // JS/TS: moduleClosure on the one file (the others read as empty) is that file's direct references
  for (const f of has) {
    if (!/\.(mjs|js|cjs|ts)$/.test(f) || /(^|\/)node_modules\//.test(f)) continue;
    const t = text(f);
    const own = f.endsWith('.ts') ? tsSpecifiers(f, t, has) : t;
    const c = moduleClosure([f], has, { read: (p) => (p === f ? own : '') });
    c.files.delete(f);
    refs.set(f, c.files);
    if (c.globs.size) globs.set(f, [...c.globs]);
    if (isKitTest(f)) tests.set(f, 'kit');
    else if (isSidecarTest(f)) tests.set(f, 'sidecar');
  }
  // Java: package + simple name; edges by import, same package or wildcard import with the simple name, a dotted FQN, literal paths
  const javaFiles = [...has].filter((f) => JAVA_SRC.test(f));
  const byFqn = new Map();
  const byPkg = new Map();
  const info = new Map();
  for (const f of javaFiles) {
    const t = text(f);
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(t)?.[1] ?? '';
    const name = path.posix.basename(f, '.java');
    const fqn = pkg ? `${pkg}.${name}` : name;
    info.set(f, { t, pkg, name, fqn });
    byFqn.set(fqn, f);
    (byPkg.get(pkg) ?? byPkg.set(pkg, []).get(pkg)).push(f);
  }
  const skip = excludedTags(text('mod/build.gradle'));
  for (const [f, { t, pkg, fqn }] of info) {
    const r = new Set();
    const ids = new Set(t.match(/\b[A-Z]\w*\b/g) ?? []);
    const pkgs = [pkg];
    for (const m of t.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/gm)) {
      if (m[2]) pkgs.push(m[1]);
      // import a.b.C; import static a.b.C.x; import a.b.C.Inner;
      const parts = m[1].split('.');
      for (let i = parts.length; i > 0; i--) {
        const hit = byFqn.get(parts.slice(0, i).join('.'));
        if (hit) {
          r.add(hit);
          break;
        }
      }
    }
    for (const p of pkgs) for (const g of byPkg.get(p) ?? []) if (ids.has(info.get(g).name)) r.add(g);
    for (const m of t.matchAll(/\bdev\.larattalabs\.[\w.]+/g)) {
      const parts = m[0].split('.');
      for (let i = parts.length; i > 2; i--) {
        const hit = byFqn.get(parts.slice(0, i).join('.'));
        if (hit) {
          r.add(hit);
          break;
        }
      }
    }
    const lit = javaLiteralRefs(f, t, has, dirs);
    for (const x of lit.files) r.add(x);
    r.delete(f);
    refs.set(f, r);
    if (lit.globs.size) globs.set(f, [...lit.globs]);
    if (f.startsWith('mod/src/test/java/') && JUNIT.test(t) && !/\babstract\s+class\b/.test(t)) {
      if (classTags(t).some((x) => skip.includes(x))) excluded.push(f);
      else {
        tests.set(f, 'gradle');
        gradle.set(f, fqn);
      }
    }
  }
  // reverse edges
  const back = new Map();
  for (const [f, rs] of refs) for (const x of rs) (back.get(x) ?? back.set(x, new Set()).get(x)).add(f);
  // A directory a file names (KIT = 'kit/lib', a fixtures dir) reaches the data in it; it reaches the code in it only when a test
  // names it (a test that lints every program of kit/regions/), since elsewhere such a path is a base for computed paths whose
  // modules arrive by import (else sidecar/src/protocol.ts would depend on every sidecar module)
  const globRes = [...globs].map(([f, gs]) => [f, gs.map(globToRe), tests.has(f)]);
  const CODE = /\.(mjs|js|cjs|ts|java)$/;
  const dependents = (x) => {
    const out = new Set(back.get(x) ?? []);
    const code = CODE.test(x);
    for (const [f, res, isTest] of globRes) if (f !== x && (!code || isTest) && res.some((re) => re.test(x))) out.add(f);
    return out;
  };
  return { refs, globs, tests, gradle, excluded, dependents, has };
}

/**
 * The selection for the changed paths. `ignore`: impact.ignore globs. Returns per suite { full: [reasons] | null, picks: Map test ->
 * [chains] }, plus ignored and per-file notes.
 */
export function selectTests(changed, graph, { ignore = [], drivers = new Map() } = {}) {
  const ign = ignore.map(globToRe);
  const suites = Object.fromEntries(ALL.map((s) => [s, { full: [], picks: new Map() }]));
  const files = [];
  const ignored = [];
  const checks = [];
  const pick = (t, chain) => {
    const s = suites[graph.tests.get(t)];
    (s.picks.get(t) ?? s.picks.set(t, []).get(t)).push(chain);
  };
  for (const f of [...new Set(changed)]) {
    const core = SHARED_CORE.find((c) => c.res.some((re) => re.test(f)));
    if (core) {
      for (const s of core.suites) suites[s].full.push(`${f}: shared core (${core.name})`);
      files.push({ file: f, why: `shared core (${core.name}): full ${core.suites.join(', ')}` });
      continue;
    }
    if (!graph.has.has(f)) {
      const lang = languageOf(f);
      if (ign.some((re) => re.test(f))) {
        ignored.push(f);
        files.push({ file: f, why: 'deleted, and ignored (impact.ignore)' });
        continue;
      }
      suites[lang].full.push(`${f}: deleted or not in the tree (its dependents are unknown)`);
      files.push({ file: f, why: `deleted: full ${lang}` });
      continue;
    }
    const before = ALL.reduce((a, s) => a + suites[s].picks.size, 0);
    let n = 0;
    if (graph.tests.has(f)) {
      pick(f, `${f} (changed)`);
      n++;
    }
    const d1 = graph.dependents(f);
    for (const d of d1) {
      if (graph.tests.has(d)) {
        pick(d, `${d} <- ${f}`);
        n++;
      }
      for (const t of graph.dependents(d)) {
        if (graph.tests.has(t) && t !== f) {
          pick(t, `${t} <- ${d} <- ${f}`);
          n++;
        }
      }
    }
    if (n) {
      const added = ALL.reduce((a, s) => a + suites[s].picks.size, 0) - before;
      files.push({ file: f, why: `${n} test reference(s) (${added} new pick(s)); ${d1.size} direct dependent(s)` });
      continue;
    }
    if (ign.some((re) => re.test(f))) {
      ignored.push(f);
      files.push({ file: f, why: 'ignored (impact.ignore), no test reads it' });
      continue;
    }
    if (drivers.has(f) && /\.(mjs|js)$/.test(f)) {
      checks.push(f);
      files.push({ file: f, why: `gate driver of ${drivers.get(f).slice(0, 4).join(', ')}${drivers.get(f).length > 4 ? ` (+${drivers.get(f).length - 4})` : ''}: no unit reaches it; its own gate step runs it (node --check here)` });
      continue;
    }
    const lang = languageOf(f);
    suites[lang].full.push(`${f}: no test within two hops (unmapped)`);
    files.push({ file: f, why: `unmapped: full ${lang}` });
  }
  for (const s of ALL) if (!suites[s].full.length) suites[s].full = null;
  return { suites, files, ignored, checks };
}

/** Gate drivers: each step's roots in tools/step-inputs.json (not the unit suites' own roots) -> the steps they drive. */
export function gateDrivers(inputMap) {
  const out = new Map();
  for (const [id, e] of Object.entries(inputMap?.steps ?? {})) {
    if (/^unit-/.test(id)) continue;
    for (const r of e.roots ?? []) (out.get(r) ?? out.set(r, []).get(r)).push(id);
  }
  return out;
}

/** The full suite of each language in this graph: its test files (Gradle: its classes). */
export function fullCounts(graph) {
  const c = { kit: 0, sidecar: 0, gradle: 0 };
  for (const s of graph.tests.values()) c[s]++;
  return c;
}

// ------------------------------------------------------------------ CLI

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const opt = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (f) => argv.includes(f);
  const git = (...a) => execFileSync('git', ['-C', SRC, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
  const explicit = argv.filter((a, i) => !a.startsWith('--') && !['--since', '--range'].includes(argv[i - 1]));
  let range = null;
  let changed;
  if (opt('--range')) {
    range = opt('--range');
    changed = git('diff', '--name-only', range).split('\n').filter(Boolean);
  } else if (explicit.length) changed = explicit;
  else {
    range = `${opt('--since') ?? 'origin/main'}...HEAD`;
    const dirty = dirtyPaths(SRC);
    changed = [...new Set([...git('diff', '--name-only', range).split('\n').filter(Boolean), ...dirty])];
    if (dirty.length) range += ` + ${dirty.length} working-tree path(s)`;
  }
  const files = new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter((p) => p && fs.existsSync(path.join(SRC, p))));
  const graph = buildGraph(files, (p) => fs.readFileSync(path.join(SRC, p), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'tools', 'gate-chains.json'), 'utf8'));
  let inputMap = null;
  try {
    inputMap = JSON.parse(fs.readFileSync(path.join(SRC, 'tools', 'step-inputs.json'), 'utf8'));
  } catch {
    // no map: every driver no unit reaches falls back to the full kit suite
  }
  const sel = selectTests(changed, graph, { ignore: cfg.impact?.ignore ?? [], drivers: gateDrivers(inputMap) });
  const full = fullCounts(graph);
  const plan = Object.fromEntries(ALL.map((s) => {
    const x = sel.suites[s];
    const tests = x.full ? null : [...x.picks.keys()].sort();
    return [s, { full: !!x.full, fullCount: full[s], picked: x.full ? full[s] : tests.length, why: x.full ?? [], tests, chains: Object.fromEntries([...x.picks].map(([t, c]) => [t, c])) }];
  }));
  if (flag('--json')) console.log(JSON.stringify({ range, changed: changed.length, files: sel.files, ignored: sel.ignored, checks: sel.checks, excludedJava: graph.excluded, suites: plan }, null, 1));
  else {
    console.log(`unit-scope: ${range ?? 'explicit paths'}: ${changed.length} changed file(s)${range && opt('--range') ? ' (the graph is the working tree\'s)' : ''}`);
    for (const f of sel.files) console.log(`  ${f.file}: ${f.why}`);
    for (const s of ALL) {
      const p = plan[s];
      const unit = s === 'gradle' ? 'class(es)' : 'file(s)';
      if (p.full) {
        console.log(`${s}: FULL (${p.fullCount} ${unit})`);
        for (const w of p.why.slice(0, 12)) console.log(`  because ${w}`);
        if (p.why.length > 12) console.log(`  (+${p.why.length - 12} more)`);
      } else {
        console.log(`${s}: ${p.picked}/${p.fullCount} ${unit}`);
        for (const t of p.tests) console.log(`  ${s === 'gradle' ? graph.gradle.get(t) : t}  [${p.chains[t][0]}${p.chains[t].length > 1 ? ` (+${p.chains[t].length - 1})` : ''}]`);
      }
    }
    if (sel.checks.length) console.log(`node --check: ${sel.checks.join(' ')}`);
  }
  if (flag('--run')) {
    const results = [];
    const run = (name, cmd, args, cwd, env) => {
      console.log(`\nunit-scope --run ${name}: nice -n 10 ${cmd} ${args.length > 8 ? `${args.slice(0, 8).join(' ')} ... (${args.length} args)` : args.join(' ')} (cwd ${path.relative(SRC, cwd) || '.'})`);
      const r = spawnSync('nice', ['-n', '10', cmd, ...args], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
      results.push({ name, code: r.status ?? 1 });
    };
    for (const f of sel.checks) run(`node --check ${f}`, 'node', ['--check', f], SRC);
    if (plan.kit.full) run('kit', 'node', ['--test', ...testConcurrencyArgs(), ...[...graph.tests].filter(([, s]) => s === 'kit').map(([t]) => t).sort()], SRC);
    else if (plan.kit.picked) run('kit', 'node', ['--test', ...testConcurrencyArgs(), ...plan.kit.tests], SRC);
    const sc = path.join(SRC, 'sidecar');
    if (plan.sidecar.full) run('sidecar', 'npx', ['vitest', 'run'], sc);
    else if (plan.sidecar.picked) run('sidecar', 'npx', ['vitest', 'run', ...plan.sidecar.tests.map((t) => path.relative('sidecar', t))], sc);
    if (plan.gradle.full || plan.gradle.picked) {
      const gh = process.env.GRADLE_USER_HOME ?? path.join(SRC, '.gradle-home');
      if (!fs.existsSync(gh) || path.relative(SRC, path.resolve(gh)).startsWith('..')) {
        console.error(`unit-scope: GRADLE_USER_HOME ${gh} is not this checkout's own copy (AGENTS.md "Build and test"): Gradle not run`);
        results.push({ name: 'gradle', code: 2 });
      } else {
        const args = plan.gradle.full ? ['--offline', '--no-daemon', 'build'] : ['--offline', '--no-daemon', 'test', ...plan.gradle.tests.flatMap((t) => ['--tests', graph.gradle.get(t)])];
        run('gradle', './gradlew', args, path.join(SRC, 'mod'), { GRADLE_USER_HOME: path.resolve(gh) });
      }
    }
    const bad = results.filter((r) => r.code !== 0);
    console.log(`\nunit-scope --run: ${results.map((r) => `${r.name} ${r.code === 0 ? 'PASS' : `FAIL (exit ${r.code})`}`).join(', ') || 'nothing to run'}`);
    process.exit(bad.length ? 1 : 0);
  }
}
