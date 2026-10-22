#!/usr/bin/env node
// The step result cache (docs/GATES.md "Affected-only releases"; tools/lib/step-cache.mjs).
//
//   node tools/step-cache.mjs import <run dir>...     record a traced run's PASSes under the current input map (after a merge that
//                                                     widened it): each PASS whose trace stays inside its set, at the run's head
//   node tools/step-cache.mjs replay --at <commit> <run dir>...
//                                                     analysis only, writes nothing: which steps those runs' PASSes would serve
//                                                     at <commit> (keys at each run's head against keys at <commit>; old runs
//                                                     carry no trace and no toolchain record, so this never seeds the cache)
//   node tools/step-cache.mjs import-history --into <dir> [--since <ISO time>] <run dir>...
//                                                     an ANALYSIS cache (never the live one) rebuilt from past runs that carry no
//                                                     trace: each PASS (no bar recorded, not a judged bench, cacheable) keyed at its
//                                                     run's head; runs before --since (the toolchain's install: the node binary in
//                                                     use, JAVA_HOME's release file) and dirty runs are skipped. Entries say
//                                                     `untraced`. Point a plan at it with GATE_STEP_CACHE_DIR=<dir>.
//   node tools/step-cache.mjs list [step]             the recorded entries (newest first)
//
// The cache lives in <main checkout>/artifacts/step-cache/ (untracked).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyHosts } from './lib/hosts.mjs';
import { parentOf } from './lib/step-split.mjs';
import { cacheContext, judgedBenches, keyFor, record } from './lib/step-cache.mjs';
import { loadConf, loadMap, treeAt } from './lib/step-inputs.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const runsArg = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--at', '--host', '--json', '--into', '--since'].includes(all[i - 1]));
const git = (...a) => execFileSync('git', ['-C', SRC, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const conf = loadConf(SRC);
const map = loadMap(SRC);
const rawCfg = JSON.parse(fs.readFileSync(path.join(SRC, 'tools', 'gate-chains.json'), 'utf8'));
const resolved = () => {
  const c = JSON.parse(JSON.stringify(rawCfg));
  applyHosts(c, opt('--host') ?? process.env.GATE_HOST ?? 'auto');
  return c;
};
const SNAP = process.env.GATE_SNAPSHOT_DIR ?? path.resolve(SRC, '..', 'architect-mc-6a-run', 'mod', 'run', 'saves');
const readSummary = (run) => JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'));

/** The part of a step's set every mode keeps (coverage mode included): its drivers' closure, its data, the runner, the classes
 * coverage doesn't replace (gradle), and the coverage safety set; for a step not in coverage mode, its whole set. */
async function anyModeMatcher(id, tree) {
  const { safetyGlobs, setMatcher } = await import('./lib/step-coverage.mjs');
  const { inputMatcher } = await import('./lib/step-inputs.mjs');
  const mid = map.steps[id] ? id : parentOf(id);
  const e = map.steps[mid];
  const rep = conf.coverage?.replaces ?? ['jar', 'sidecar', 'world'];
  if (!conf.coverage?.enabled || !(e.classes ?? []).some((c) => rep.includes(c))) return { cov: false, m: inputMatcher(map, conf, mid) };
  safetyCache ??= setMatcher(safetyGlobs(conf.coverage, tree, SRC));
  // --gradle-in-game-off: an in-game step keeps the gradle class only when its run takes the source gradle lock (known from its
  // trace); without a trace, the bound either keeps it (default, the worst case) or drops it for client steps (this flag)
  const dropGradle = argv.includes('--gradle-in-game-off') && (rawCfg.steps[parentOf(id)]?.client ?? 'none') !== 'none';
  const keep = setMatcher([...(e.closure ?? []), ...(e.data ?? []), ...(conf.runnerKey?.files ?? []), ...(e.classes ?? []).filter((c) => !rep.includes(c) && !(dropGradle && c === 'gradle')).flatMap((c) => (conf.classes[c] ?? []).filter((g) => !g.startsWith('!')))]);
  return { cov: true, m: (p) => keep(p) || safetyCache(p) };
}
let safetyCache = null;

if (cmd === 'import') {
  const cfg = resolved();
  const JB = judgedBenches(cfg);
  let stored = 0;
  let refused = 0;
  for (const run of runsArg.map((r) => path.resolve(r))) {
    const sm = readSummary(run);
    if (sm.sourceDirty) {
      console.log(`${run}: its source was dirty: nothing imported`);
      continue;
    }
    const ctx = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: sm.head, dirty: [] });
    ctx.rawCfg = rawCfg;
    const kitTree = (() => {
      try {
        return git('rev-parse', `${sm.head}:kit`);
      } catch {
        return null;
      }
    })();
    const policy = sm.timingPolicy ?? 'judged';
    for (const s of sm.steps) {
      if (s.status !== 'PASS') continue;
      const tdir = path.join(run, 'traces', s.id); // absent for a step with no node process (gradle): its classes cover it
      const k = keyFor(ctx, s.id);
      const ev = sm.shards?.find((x) => x.k === s.shard)?.evidence;
      const r = record(ctx, s.id, s, { key: k.key, why: k.why, parts: k.parts, run, ev: ev ? path.join(run, ev) : run, traceDir: tdir, traced: fs.existsSync(path.join(run, 'traces')),
        timingPolicy: policy, judgedBench: JB.has(s.id), tier: sm.tier?.name ?? sm.chain,
        ...(s.id === 'unit-kit' && fs.existsSync(path.join(run, 'kit-suite.junit.xml')) ? { junit: path.join(run, 'kit-suite.junit.xml'), kitTree } : {}) });
      if (r.stored) stored++;
      else refused++;
      console.log(`${r.stored ? 'recorded' : 'not     '} ${s.id.padEnd(22)} ${r.why}${r.outside ? `: ${r.outside.slice(0, 6).join(', ')}${r.outside.length > 6 ? ', ...' : ''}` : ''}`);
    }
  }
  console.log(`step-cache import: ${stored} recorded, ${refused} not`);
} else if (cmd === 'import-history') {
  const into = opt('--into');
  if (!into) throw new Error('import-history needs --into <dir> (an analysis cache, never the live artifacts/step-cache)');
  const dir = path.resolve(into);
  if (dir === path.join(MAIN, 'artifacts', 'step-cache')) throw new Error('import-history never writes the live cache');
  // the toolchain cutoff: runs before the current node and JDK were installed ran another toolchain
  const nodeSince = fs.statSync(path.dirname(path.dirname(fs.realpathSync(process.execPath)))).birthtime;
  const javaSince = fs.statSync(path.join(process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', 'libexec', 'openjdk.jdk', 'Contents', 'Home', 'release')).mtime;
  const since = opt('--since') ?? new Date(Math.max(nodeSince, javaSince)).toISOString();
  const cfg = resolved();
  const JB = judgedBenches(cfg);
  let stored = 0;
  const skipped = [];
  for (const run of runsArg.map((r) => path.resolve(r))) {
    let sm;
    try {
      sm = readSummary(run);
    } catch {
      continue;
    }
    if (!sm.head || sm.sourceDirty || !(sm.startedAt >= since)) {
      skipped.push(`${path.basename(run)}: ${!sm.head ? 'no head' : sm.sourceDirty ? 'dirty source' : `before ${since}`}`);
      continue;
    }
    let ctx;
    try {
      ctx = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: sm.head, dirty: [], env: { ...process.env, GATE_STEP_CACHE_DIR: dir } });
    } catch {
      skipped.push(`${path.basename(run)}: head ${sm.head.slice(0, 9)} unknown here`);
      continue;
    }
    ctx.rawCfg = rawCfg;
    for (const s of sm.steps) {
      if (s.status !== 'PASS') continue;
      // an untraced PASS is only as good as the set it is keyed by: only steps whose set a traced PASS has verified
      if (!map.steps[map.steps[s.id] ? s.id : parentOf(s.id)]?.verified) continue;
      const k = keyFor(ctx, s.id);
      const ev = sm.shards?.find((x) => x.k === s.shard)?.evidence;
      const r = record(ctx, s.id, s, { key: k.key, why: k.why, parts: k.parts, run, ev: ev ? path.join(run, ev) : run, traceDir: null, traced: false,
        untracedImport: `from ${path.relative(MAIN, run)} (no trace; toolchain assumed: run after ${since})`, timingPolicy: sm.timingPolicy ?? 'recorded', judgedBench: JB.has(s.id), tier: sm.tier?.name ?? sm.chain });
      if (r.stored) stored++;
    }
  }
  console.log(`step-cache import-history into ${dir}: ${stored} entr${stored === 1 ? 'y' : 'ies'} recorded (newest PASS per key wins); runs since ${since}; ${skipped.length} run(s) skipped`);
} else if (cmd === 'coverage-select') {
  // what a release of one commit (against its parent, the cache warm there) would run: map mode (the whole-tree classes), and the
  // bounds of coverage mode: steps whose static part (drivers, data, definition, runner) moved run in any mode; steps moved only
  // through the classes run under coverage when their recorded coverage holds a changed file (exact once recorded, else pending)
  const { setMatcher } = await import('./lib/step-coverage.mjs');
  const { inputMatcher } = await import('./lib/step-inputs.mjs');
  const cfg = resolved();
  const out = [];
  for (const c of runsArg) {
    const head = git('rev-parse', c);
    const base = git('rev-parse', `${c}^`);
    const delta = execFileSync('git', ['-C', SRC, 'diff', '--name-only', base, head], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const cb = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: base, dirty: [] });
    const ch = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: head, dirty: [] });
    cb.rawCfg = rawCfg;
    ch.rawCfg = rawCfg;
    const row = { commit: c, subject: git('log', '-1', '--format=%s', head).slice(0, 80), changed: delta.length, steps: 0, mapRuns: 0, staticRuns: 0, classesOnly: 0, coverageRuns: 0, coverageSkips: 0, pending: 0, classesOnlyIds: [] };
    for (const id of Object.keys(cfg.steps)) {
      if (!map.steps[id] || conf.uncacheable?.[id]) continue;
      row.steps++;
      const a = keyFor(cb, id).key;
      const b = keyFor(ch, id).key;
      if (a === b) continue;
      row.mapRuns++;
      const am = await anyModeMatcher(id, treeAt(SRC, head));
      const all = inputMatcher(map, conf, id);
      if (!am.cov || delta.some((p) => am.m(p)) || !delta.some((p) => all(p))) {
        row.staticRuns++; // not a coverage-mode step, or its drivers, data, runner, the safety set, a mode or flag moved: it runs
        continue;
      }
      row.classesOnly++;
      row.classesOnlyIds.push(id);
    }
    out.push(row);
    console.log(`${c} ${row.subject}\n  ${row.changed} files changed; ${row.steps} cacheable steps: map mode runs ${row.mapRuns}; coverage mode runs at least ${row.staticRuns} (their drivers, data or runner moved) and at most ${row.mapRuns}: ${row.classesOnly} moved only through the whole-tree classes, decided by their recorded coverage`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
} else if (cmd === 'fail-audit') {
  // safety on history: every past FAIL/TIMEOUT of a step, against the step's last earlier PASS on an ancestor commit. The change
  // between them is what caused it (or nothing did: a flake). Would the selection have run the step?
  //   static: the change touches its drivers' closure, its traced data, its definition: runs in every mode
  //   classes: only the whole-tree classes (the jar, the sidecar's kit, scenarios) hold it: map mode runs it; coverage mode runs it
  //            when the step's recorded coverage holds a changed file (a coverage PASS in the cache), else it is "pending"
  //   none: nothing in its set moved: a hole (map mode would have served a stale PASS)
  const { coverageSet, setMatcher } = await import('./lib/step-coverage.mjs');
  const { inputMatcher, treeAt: tAt } = await import('./lib/step-inputs.mjs');
  const { definitionsAt } = await import('./lib/gate-history.mjs');
  const defAt = definitionsAt(SRC);
  const ART = path.join(MAIN, 'artifacts');
  const rows = [];
  for (const d of fs.readdirSync(ART).filter((x) => x.startsWith('gate-runs'))) {
    let runs = [];
    try {
      runs = fs.readdirSync(path.join(ART, d));
    } catch {
      continue;
    }
    for (const r of runs) {
      let sm;
      try {
        sm = readSummary(path.join(ART, d, r));
      } catch {
        continue;
      }
      if (!sm.head || sm.sourceDirty) continue;
      for (const st of sm.steps ?? []) if (['PASS', 'FAIL', 'TIMEOUT'].includes(st.status)) rows.push({ id: st.id, status: st.status, at: st.startedAt ?? sm.startedAt, head: sm.head, run: `${d}/${r}`, fail: (st.failLines ?? [])[0] ?? '' });
    }
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  const isAnc = (a, b) => {
    try {
      execFileSync('git', ['-C', SRC, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const covDir = path.join(MAIN, 'artifacts', 'step-cache');
  const covOf = (id) => {
    try {
      const es = fs.readdirSync(path.join(covDir, id.replace(/[^\w.@-]/g, '_'))).map((f) => JSON.parse(fs.readFileSync(path.join(covDir, id.replace(/[^\w.@-]/g, '_'), f), 'utf8'))).filter((e) => e.mode === 'coverage');
      return es.sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
    } catch {
      return null;
    }
  };
  const out = { static: [], classes: [], none: [], flake: [], noBase: 0, fails: 0 };
  const conf2 = conf;
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i];
    if (f.status === 'PASS') continue;
    out.fails++;
    let base = null;
    for (let j = i - 1; j >= 0; j--) if (rows[j].id === f.id && rows[j].status === 'PASS' && (rows[j].head === f.head || isAnc(rows[j].head, f.head))) {
      base = rows[j];
      break;
    }
    if (!base) {
      out.noBase++;
      continue;
    }
    const mid = map.steps[f.id] ? f.id : parentOf(f.id);
    if (!map.steps[mid]) continue;
    const delta = base.head === f.head ? [] : execFileSync('git', ['-C', SRC, 'diff', '--name-only', base.head, f.head], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const defMoved = base.head !== f.head && defAt(base.head, f.id) !== defAt(f.head, f.id);
    const rec = { id: f.id, status: f.status, fail: f.fail.slice(0, 140), run: f.run, head: f.head.slice(0, 9), base: base.head.slice(0, 9), baseRun: base.run, changed: delta.length };
    if (!delta.length) {
      out.flake.push(rec);
      continue;
    }
    const e = map.steps[mid];
    const am = await anyModeMatcher(f.id, tAt(SRC, f.head));
    const stat = am.cov ? am.m : setMatcher([...(e.closure ?? []), ...(e.globs ?? []), ...(e.data ?? []), ...(conf2.runnerKey?.files ?? [])]);
    const all = inputMatcher(map, conf2, mid);
    const sHit = am.cov ? delta.filter((p) => stat(p)) : delta.filter((p) => all(p) || stat(p));
    if (defMoved || sHit.length) {
      out.static.push({ ...rec, why: defMoved ? 'its definition moved' : sHit.slice(0, 3), runner: sHit.some((p) => (conf2.runnerKey?.files ?? []).includes(p)) });
      continue;
    }
    const cHit = delta.filter((p) => all(p));
    if (!cHit.length) {
      out.none.push({ ...rec, delta: delta.slice(0, 8) });
      continue;
    }
    const cov = covOf(f.id);
    let verdict = 'pending (no coverage recorded for this step yet)';
    if (cov) verdict = delta.some((p) => setMatcher(cov.coverageSet)(p)) ? 'runs (its coverage holds a changed file)' : 'SKIPPED (coverage misses the cause: a hole to close)';
    out.classes.push({ ...rec, why: cHit.slice(0, 4), java: cHit.filter((p) => p.endsWith('.java')).length, kit: cHit.filter((p) => p.startsWith('kit/')).length, coverage: verdict });
  }
  console.log(`fail-audit: ${out.fails} FAIL/TIMEOUT records; ${out.noBase} with no earlier PASS on an ancestor; ${out.flake.length} on the same commit as an earlier PASS (no code change: a flake, load or the environment); ${out.static.length} caused by a change in the step's own drivers, data or definition (run in every mode); ${out.classes.length} only through the whole-tree classes (coverage decides); ${out.none.length} with no change in the step's set (holes)`);
  const byCov = {};
  for (const x of out.classes) byCov[x.coverage] = (byCov[x.coverage] ?? 0) + 1;
  console.log(`  classes-only, by coverage verdict: ${JSON.stringify(byCov)}; of them java ${out.classes.filter((x) => x.java).length}, kit ${out.classes.filter((x) => x.kit).length}`);
  for (const x of out.none) console.log(`  HOLE ${x.id} ${x.status} @ ${x.head} (PASS @ ${x.base}): ${x.delta.join(', ')}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
} else if (cmd === 'replay') {
  const at = opt('--at') ?? 'HEAD';
  const cfg = resolved();
  const JB = judgedBenches(cfg);
  const target = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: git('rev-parse', at), dirty: [] });
  target.rawCfg = rawCfg;
  const served = new Map();
  const seen = new Set();
  for (const run of runsArg.map((r) => path.resolve(r))) {
    let sm;
    try {
      sm = readSummary(run);
    } catch {
      continue;
    }
    if (!sm.head || sm.sourceDirty) continue;
    let ctx;
    try {
      ctx = cacheContext({ src: SRC, main: MAIN, cfg, conf, map, snapDir: SNAP, commit: sm.head, dirty: [] });
    } catch {
      continue; // a head this clone doesn't have
    }
    ctx.rawCfg = rawCfg;
    for (const s of sm.steps) {
      seen.add(s.id);
      if (s.status !== 'PASS' || s.timingRecorded?.length || JB.has(s.id) || served.has(s.id)) continue;
      let a;
      let b;
      try {
        a = keyFor(ctx, s.id);
        b = keyFor(target, s.id);
      } catch {
        continue;
      }
      if (a.key && a.key === b.key) served.set(s.id, { run: path.relative(MAIN, run), head: sm.head.slice(0, 9), at: s.startedAt });
    }
  }
  console.log(`replay at ${at} (${target.head.slice(0, 9)}): ${served.size} step(s) would be served by the PASSes of ${runsArg.length} run(s) (${seen.size} distinct steps in them)`);
  for (const [id, h] of [...served].sort()) console.log(`  ${id.padEnd(22)} PASS ${h.at} ${h.run} @ ${h.head}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ at, head: target.head, runs: runsArg, served: Object.fromEntries(served), seen: [...seen] }, null, 1));
} else if (cmd === 'list') {
  const dir = path.resolve(process.env.GATE_STEP_CACHE_DIR ?? path.join(MAIN, 'artifacts', 'step-cache'));
  const rows = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (argv[1] && id !== argv[1]) continue;
    for (const f of fs.readdirSync(path.join(dir, id)).filter((x) => x.endsWith('.json'))) {
      const e = JSON.parse(fs.readFileSync(path.join(dir, id, f), 'utf8'));
      rows.push(e);
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const e of rows) console.log(`${e.id.padEnd(22)} ${e.key.slice(0, 12)} PASS ${e.at} ${e.tier} @ ${String(e.head).slice(0, 9)} ${path.relative(MAIN, e.run ?? '')}`);
  console.log(`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
} else {
  console.error('usage: node tools/step-cache.mjs import <run dir>... | replay --at <commit> <run dir>... [--json f] | list [step]');
  process.exit(2);
}
