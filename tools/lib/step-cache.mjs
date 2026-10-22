// The step result cache (docs/GATES.md "Affected-only releases"). A step's PASS is recorded under a key:
//   - its input set's hash at the run's commit (tools/lib/step-inputs.mjs: git blob ids; a dirty source tree never looks up
//     nor records), plus the fingerprints of its untracked inputs (local data, the snapshot worlds it restores);
//   - its definition (gate-history's stepDefinition: the chain entry and its drivers' blobs), the resolved client entry and host;
//   - the toolchain: node, java (JAVA_HOME's `java -version`), the Minecraft version;
//   - the modes: every environment variable its closure reads that is not per-run plumbing (GATE_P3, GATE_P2_SMOKE, ...);
//   - flags its closure raises: the release context, origin/main's tree for drivers that diff against it.
// Entries live in <main checkout>/artifacts/step-cache/<step>/<key>.json (untracked), newest PASS per key, with the run dir and
// the evidence paths. Never recorded: FAIL, TIMEOUT, ERROR, NOISY; a PASS with timing bars recorded-not-judged; an isolated or
// judged bench; an uncacheable step (tools/gate-cache.json); a step whose trace read a source file outside its set (an
// inputs-map miss, reported).

import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { definitionNow, definitionsAt } from './gate-history.mjs';
import { checkTrace, dirtyPaths, fingerprintOf, globRe, inputsHash, readTrace, treeAt } from './step-inputs.mjs';
import { releaseContext } from '../release-context.mjs';
import { entryOf, parentOf } from './step-split.mjs';
import { constantChanges, coverageSet, setMatcher, testSourcesMatching, TESTS_PREFIX } from './step-coverage.mjs';

const blobs = new Map();
/** A blob's text (cached by id). */
function blobText(src, id) {
  if (!id) return '';
  if (!blobs.has(id)) blobs.set(id, execFileSync('git', ['-C', src, 'cat-file', 'blob', id], { maxBuffer: 64 << 20 }).toString());
  return blobs.get(id);
}
import { bytecodeDigest, ensureBuild } from './build-artifact.mjs';

/** The build artifact's manifest at the context's head (tools/lib/build-artifact.mjs); built on first use when ctx.allowBuild. */
export function manifestOf(ctx) {
  if (ctx.manifest === undefined) {
    try {
      ctx.manifest = ensureBuild({ src: ctx.src, main: ctx.main, commit: ctx.head, conf: ctx.conf, java: ctx.toolchain.java, build: !!ctx.allowBuild, log: ctx.log });
    } catch (e) {
      ctx.manifest = { ok: false, error: e.message };
    }
  }
  return ctx.manifest;
}

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString().trim();
const sha = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

let javaCache = null;
/** `java -version`'s first line for JAVA_HOME (the runner's children default to openjdk@25). */
export function javaVersion(env = process.env) {
  if (javaCache) return javaCache;
  const home = env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
  const r = spawnSync(path.join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
  javaCache = `${r.stderr ?? ''}${r.stdout ?? ''}`.split('\n').filter((l) => l && !/^(NOTE: )?Picked up /.test(l)).slice(0, 2).join(' | ') || `unknown (${home})`;
  return javaCache;
}

/** The Minecraft version and the build dependency versions at a commit (mod/gradle.properties less mod_version). */
export function buildVersions(src, commit) {
  try {
    const t = git(src, 'show', `${commit}:mod/gradle.properties`);
    return Object.fromEntries(t.split('\n').map((l) => /^([\w.]+)\s*=\s*(.*)$/.exec(l.trim())).filter((m) => m && m[1] !== 'mod_version').map((m) => [m[1], m[2]]));
  } catch {
    return {};
  }
}

/**
 * The run-wide part of every key, computed once: the head, the dirty paths, the toolchain, the release context, origin/main.
 * `opts`: { src, main, cfg (the resolved chain config: hosts applied), conf, map, snapDir, env }.
 */
export function cacheContext({ src, main, cfg, conf, map, snapDir, env = process.env, commit = 'HEAD', dirty }) {
  const head = git(src, 'rev-parse', commit);
  const dirtyList = dirty ?? (commit === 'HEAD' ? dirtyPaths(src) : []);
  // drivers that compare against origin/main (a worktree there, or the merge base) read those commits' code trees: their tree ids
  // (docs excluded: a doc-only commit on main or on the branch changes nothing they read)
  const SUB = ['kit', 'scenarios', 'tools', 'mod', 'sidecar', 'devserver', 'apitest'];
  const subtrees = (c) => Object.fromEntries(SUB.map((d) => {
    try {
      return [d, git(src, 'rev-parse', `${c}:${d}`)];
    } catch {
      return [d, null];
    }
  }));
  let originMain = null;
  try {
    originMain = { main: subtrees('origin/main'), mergeBase: subtrees(git(src, 'merge-base', head, 'origin/main')) };
  } catch {
    originMain = { main: null, mergeBase: null };
  }
  let tagAtHead = false;
  try {
    tagAtHead = git(src, 'tag', '--points-at', head).split('\n').some((t) => /^v\d/.test(t));
  } catch {
    // none
  }
  const plumbing = new RegExp(conf.modeEnv?.plumbing ?? '^$');
  let lastTag = null;
  try {
    const t = git(src, 'describe', '--tags', '--abbrev=0', '--match', 'v*', head);
    lastTag = { tag: t, commit: git(src, 'rev-parse', `${t}^{commit}`) };
  } catch {
    // none reachable
  }
  const repoListing = sha([...treeAt(src, head).keys()].sort().join('\n')).slice(0, 16);
  // the runner code every step runs under (gate-cache.json runnerKey): its blobs at this commit
  const tr = treeAt(src, head);
  const runner = sha((conf.runnerKey?.files ?? []).map((f) => `${f}\0${tr.get(f) ?? '-'}`).join('\n')).slice(0, 16);
  return {
    src, main, cfg, conf, map, snapDir, env, head, dirty: dirtyList,
    toolchain: { node: process.version, java: javaVersion(env), build: buildVersions(src, head) }, lastTag, repoListing, runner,
    // the release context (strict NEXT checks): this checkout's; for another commit, as a detached checkout of it would see it
    // (ARCHITECT_RELEASE, else a v* tag on it), which is what the nightly's and the runner's detached worktrees see
    release: { src: commit === 'HEAD' ? releaseContext(src, env).release : env.ARCHITECT_RELEASE === '1' || env.ARCHITECT_RELEASE === '0' ? env.ARCHITECT_RELEASE === '1' : tagAtHead, tagAtHead },
    originMain, plumbing,
    // GATE_STEP_CACHE_DIR: another cache (an analysis cache rebuilt from history: tools/step-cache.mjs import-history)
    dir: path.resolve(env.GATE_STEP_CACHE_DIR ?? path.join(main, 'artifacts', 'step-cache')),
    defAt: commit === 'HEAD' ? null : definitionsAt(src),
  };
}

/** The input map's entry id for a step or a split step's part (the parent's). */
export const mapId = (map, id) => (map?.steps?.[id] ? id : parentOf(id));

/** The snapshot worlds a step restores and its client's world: a fingerprint of each level.dat (size, mtime) in the store. */
function snapshotsOf(ctx, entry) {
  const client = ctx.cfg.clients?.[entry.client];
  const worlds = [...new Set([...(entry.restore ?? []), ...(client?.world ? [client.world] : [])])].sort();
  if (!ctx.snapDir) return worlds.map((w) => [w, 'unknown']);
  return worlds.map((w) => {
    try {
      const st = fs.statSync(path.join(ctx.snapDir, w, 'level.dat'));
      return [w, `${st.size}:${Math.round(st.mtimeMs)}`];
    } catch {
      return [w, 'missing'];
    }
  });
}

/**
 * Step `id`'s key -> { key, parts } or { key: null, why } when it can't be cached (uncacheable, no map entry, a dirty tree).
 */
export function keyFor(ctx, id, { set = null, classes = null } = {}) {
  const { cfg, conf, map } = ctx;
  // a split step's part (<id>/p<k>, turbo): its own entry (its section env) and key, its parent's input set
  const entry = cfg.steps[id] ?? entryOf(cfg, id);
  if (!entry) return { key: null, why: 'unknown step' };
  const pid = parentOf(id);
  if (conf.uncacheable?.[pid]) return { key: null, why: `uncacheable: ${conf.uncacheable[pid]}` };
  const mid = mapId(map, id);
  const me = map?.steps?.[mid];
  if (!me) return { key: null, why: 'no entry in tools/step-inputs.json' };
  if (ctx.dirty.length) return { key: null, why: `the source tree is dirty (${ctx.dirty.length} path(s), e.g. ${ctx.dirty[0]}): a dirty tree is never cached` };
  // coverage mode (step-coverage.mjs): the hash runs over the set a recorded run touched instead of the map's set
  const inputs = set ? setHash(set, ctx.src, ctx.head) : inputsHash(map, conf, mid, ctx.src, ctx.head);
  // bytecode mode: the loaded classes' class-file digests from the run-level build artifact; no artifact (or a failed build), no key
  let bytecode = null;
  if (classes) {
    const m = manifestOf(ctx);
    if (!m?.ok) return { key: null, why: `the build artifact at ${ctx.head.slice(0, 9)}: ${m?.error ?? 'missing'}` };
    bytecode = bytecodeDigest(classes, m);
  }
  const def = ctx.defAt ? ctx.defAt(ctx.head, id) : definitionNow(ctx.src, ctx.rawCfg ?? cfg, id);
  const names = new Set([...(me.env ?? []), ...(conf.modeEnv?.always ?? [])]);
  // ambient variables with the project's prefixes: read by the JVM, the sidecar, the client scripts or an aliased process.env
  const pre = conf.modeEnv?.prefixes ? new RegExp(conf.modeEnv.prefixes) : null;
  if (pre) for (const n of Object.keys(ctx.env)) if (pre.test(n)) names.add(n);
  const modes = {};
  for (const n of [...names].sort()) {
    if (ctx.plumbing.test(n) || Object.hasOwn(entry.env ?? {}, n)) continue;
    modes[n] = ctx.env[n] ?? null;
  }
  const flags = {};
  if (me.flags?.releaseContext) flags.release = ctx.release;
  if (me.flags?.originMain) flags.originMain = ctx.originMain;
  if (me.flags?.lastTag) flags.lastTag = ctx.lastTag;
  if (me.flags?.repoListing) flags.repoListing = ctx.repoListing;
  const parts = canon({
    v: 1,
    id,
    def,
    client: entry.client,
    clientEntry: ctx.cfg.clients?.[entry.client] ?? null,
    stepEnv: entry.env ?? null,
    inputs: inputs.hash,
    inputFiles: inputs.files,
    ...(set ? { mode: 'coverage', set: sha(set) } : {}),
    ...(bytecode ? { bytecode } : {}),
    fingerprint: fingerprintOf(map, conf, mid, ctx.src),
    snapshots: entry.client === 'none' ? [] : snapshotsOf(ctx, entry),
    toolchain: ctx.toolchain,
    runner: ctx.runner,
    modes,
    flags,
  });
  return { key: sha(parts).slice(0, 24), parts };
}

/** An archived file's fingerprint: "size:mtime", or "missing". A directory's: its sorted listing's names. */
export function externalFingerprint(main, rel) {
  const f = path.join(main, 'artifacts', rel);
  try {
    const st = fs.statSync(f);
    if (st.isDirectory()) return `dir:${sha(fs.readdirSync(f).sort().join('\n')).slice(0, 12)}`;
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/** The hash of a coverage set's files at a commit (git blob ids, sorted). */
export function setHash(set, src, commit) {
  const tree = treeAt(src, commit);
  // `@tests:<pattern>` entries: the test sources that pattern selects at this commit (a new or renamed matching test moves it)
  const pats = set.filter((x) => x.startsWith(TESTS_PREFIX)).map((x) => x.slice(TESTS_PREFIX.length));
  const tests = pats.length ? new Set(testSourcesMatching(pats, tree, ['mod/src/test/java', 'apitest/src/test/java'], (f) => blobText(src, tree.get(f)))) : new Set();
  const m0 = setMatcher(set);
  const m = (p) => m0(p) || tests.has(p);
  const h = crypto.createHash('sha1');
  let n = 0;
  for (const p of [...tree.keys()].sort()) {
    if (!m(p)) continue;
    h.update(`${p}\0${tree.get(p)}\n`);
    n++;
  }
  // absent paths the run statted are in the set by name: their appearance moves the hash
  for (const p of set) if (!/[*?]/.test(p) && !tree.has(p)) h.update(`${p}\0-\n`);
  return { hash: h.digest('hex'), files: n };
}

/** Whether a step records and looks up in coverage mode: an in-game step (its map entry has a class coverage replaces). */
export function coverageMode(ctx, id) {
  const me = ctx.map?.steps?.[mapId(ctx.map, id)];
  const rep = ctx.conf.coverage?.replaces ?? ['jar', 'sidecar', 'world'];
  // the gradle steps themselves (cwd mod: unit-mod, umt, p3-lint) are the build and its tests: whole trees
  const entry = ctx.cfg.steps[id] ?? entryOf(ctx.cfg, id);
  if (/^(run|src):mod/.test(entry?.cwd ?? '')) return false;
  return !!ctx.conf.coverage?.enabled && !!me && (me.classes ?? []).some((c) => rep.includes(c) || c === 'gradle');
}

/**
 * The newest coverage-mode PASS of a step whose set's files are unchanged here: -> { hit, why }. A compile-time constant changed in
 * Java since that PASS invalidates it (javac inlines constants into the classes that use them).
 */
export function lookupCoverage(ctx, id, { limit = 12 } = {}) {
  const dir = path.join(ctx.dir, id.replace(/[^\w.@-]/g, '_'));
  let es = [];
  try {
    es = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    }).filter((e) => e?.mode === 'coverage' && e.status === 'PASS' && Array.isArray(e.coverageSet));
  } catch {
    return { hit: null, why: 'no coverage PASS recorded' };
  }
  if (!es.length) return { hit: null, why: 'no coverage PASS recorded' };
  es.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
  let why = 'no coverage PASS recorded';
  for (const e of es.slice(0, limit)) {
    // a source-keyed PASS (no build artifact then): a constant inlined across classes invalidates it; a bytecode-keyed PASS
    // sees an inlined constant in the class that uses it
    const cc = e.coverageClasses ? new Set() : constantChanges(ctx.src, e.head, ctx.head, ctx.conf.coverage?.javaRoots ?? []);
    if (cc === null || cc.size) {
      why = cc === null ? `its head ${String(e.head).slice(0, 9)} is unknown here` : `a compile-time constant changed since its PASS (${[...cc].slice(0, 3).join(', ')})`;
      continue;
    }
    const k = keyFor(ctx, id, { set: e.coverageSet, classes: e.coverageClasses ?? null });
    if (!k.key) {
      why = k.why;
      continue;
    }
    if (k.key !== e.key) {
      why = `a file its coverage holds changed since ${String(e.head).slice(0, 9)} (or its definition, toolchain or a mode)`;
      continue;
    }
    for (const [rel, fpr] of Object.entries(e.external ?? {})) {
      if (externalFingerprint(ctx.main, rel) !== fpr) {
        why = `an archived input changed: artifacts/${rel}`;
        e.__bad = true;
        break;
      }
    }
    if (e.__bad) continue;
    return { hit: e, why: `coverage PASS at ${e.at} (head ${String(e.head).slice(0, 9)}, ${e.coverageSet.length} set entries)` };
  }
  return { hit: null, why };
}

const entryFile = (ctx, id, key) => path.join(ctx.dir, id.replace(/[^\w.@-]/g, '_'), `${key}.json`);

/** The recorded PASS for a key: -> { hit: entry | null, why }. */
export function lookup(ctx, id, key) {
  let e;
  try {
    e = JSON.parse(fs.readFileSync(entryFile(ctx, id, key), 'utf8'));
  } catch {
    return { hit: null, why: 'no recorded PASS for this key' };
  }
  if (e.status !== 'PASS' || e.key !== key) return { hit: null, why: 'entry mismatch' };
  // the archived files it read under artifacts/ (tag builds, apitest jars): each must still be there, unchanged
  for (const [rel, fpr] of Object.entries(e.external ?? {})) {
    const now = externalFingerprint(ctx.main, rel);
    if (now !== fpr) return { hit: null, why: `an archived input changed: artifacts/${rel} (${fpr} -> ${now})` };
  }
  return { hit: e, why: `PASS at ${e.at} in ${path.basename(e.run ?? '?')} (head ${String(e.head).slice(0, 9)})` };
}

/**
 * Records a step's PASS if it may be cached. rec: the summary step record; opts: { key, parts, run, ev, traceDir, traced,
 * timingPolicy, judgedBench, tier, junit, kitTree }. -> { stored: bool, why, outside? }.
 */
export function record(ctx, id, rec, opts) {
  if (!opts.key) return { stored: false, why: opts.why ?? 'no key' };
  if (rec.status !== 'PASS') return { stored: false, why: rec.status };
  if (rec.timingRecorded?.length) return { stored: false, why: 'timing bars recorded, not judged' };
  if (opts.judgedBench) return { stored: false, why: 'a bench whose timing is judged at release is never cached' };
  if (!opts.traced && !opts.untracedImport) return { stored: false, why: 'the step ran without the input trace (--no-trace)' };
  const tr = (opts.traced ? readTrace(opts.traceDir) : null) ?? new Map();
  const chk = checkTrace(ctx.map, ctx.conf, mapId(ctx.map, id), tr, { tracked: treeAt(ctx.src, ctx.head) });
  let cov = null;
  if (opts.coverage && opts.traced && coverageMode(ctx, id)) {
    // coverage mode: the key runs over what this run touched (its trace, its client's, its JVMs' classes) and the safety set
    const m = manifestOf(ctx);
    cov = coverageSet({ entry: ctx.map.steps[mapId(ctx.map, id)], trace: tr, cov: opts.coverage, conf: ctx.conf, tree: treeAt(ctx.src, ctx.head), src: ctx.src, manifest: m?.ok ? m : null });
    cov.loaded = m?.ok ? [...new Set([...(opts.coverage.classes ?? []), ...(cov.classReads ?? [])])].sort() : null;
    const k = keyFor(ctx, id, { set: cov.set, classes: cov.loaded });
    if (!k.key) return { stored: false, why: k.why };
    opts = { ...opts, key: k.key, parts: k.parts };
  } else if (chk.outside.length) return { stored: false, why: `inputs-map miss: the step read ${chk.outside.length} source path(s) outside its set`, outside: chk.outside };
  const e = {
    id, key: opts.key, status: 'PASS', at: rec.startedAt, recordedAt: new Date().toISOString(), head: ctx.head, tier: opts.tier,
    timingPolicy: opts.timingPolicy,
    run: opts.run, log: rec.log ? path.join(opts.run, rec.log) : null, evidence: opts.ev, seconds: rec.seconds, ok: rec.ok,
    metrics: rec.metrics ?? null, traced: { paths: chk.n }, parts: opts.parts,
    external: Object.fromEntries(chk.external.map((r) => [r, externalFingerprint(ctx.main, r)])),
    ...(opts.untracedImport ? { untraced: opts.untracedImport } : {}),
    ...(cov?.loaded ? { coverageClasses: cov.loaded, build: manifestOf(ctx).hash } : {}),
    ...(cov ? { mode: 'coverage', coverageSet: cov.set, coverage: { classes: cov.classes, unmappedClasses: cov.unmappedClasses.slice(0, 50), mapOutside: chk.outside.length } } : {}),
  };
  const f = entryFile(ctx, id, opts.key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try {
    const old = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (String(old.at) > String(e.at)) return { stored: false, why: `a newer PASS for this key is recorded (${old.at})` };
  } catch {
    // none yet
  }
  if (opts.junit && fs.existsSync(opts.junit)) {
    const j = f.replace(/\.json$/, '.junit.xml');
    fs.copyFileSync(opts.junit, j);
    e.junit = j;
    e.kitTree = opts.kitTree;
  }
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e, null, 1));
  fs.renameSync(tmp, f);
  return { stored: true, why: cov ? `recorded (coverage: ${cov.set.length} set entries, ${cov.classes} classes)` : 'recorded', file: f, key: opts.key, ...(chk.outside.length ? { outside: chk.outside } : {}) };
}

/** The last full nightly that ran to the end: artifacts/nightly/latest.json -> { startedAt, head, run } or null. */
export function lastNightly(main) {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(main, 'artifacts', 'nightly', 'latest.json'), 'utf8'));
    return n.state === 'done' ? n : null;
  } catch {
    return null;
  }
}

/** The judged benches: the release tier's own bench steps (always and rotation). Canaries at release, never cached. */
export function judgedBenches(cfg) {
  const isBench = (id) => (cfg.steps[id]?.resources ?? []).includes('bench');
  const r = cfg.tiers?.release ?? {};
  return new Set([...(r.always ?? []), ...(r.rotate ?? []).flatMap((x) => [...x.options.flat(), ...(x.when?.steps ?? [])])].filter(isBench));
}

/** The steps that are some step's `supersededBy` target: the full twins (the -full, the full ids of the -smoke steps). */
export function fullTwins(cfg) {
  return new Set(Object.values(cfg.steps).map((s) => s.supersededBy).filter(Boolean));
}

/** Whether the release range makes --full the rule: build dependency paths, gradle.properties beyond mod_version, a tag. */
export function autoFullWhy(conf, src, range, files, tags) {
  const af = conf.release?.autoFull ?? {};
  const why = [];
  const re = (g) => globRe(g);
  const hit = files.filter((f) => (af.paths ?? []).some((g) => re(g).test(f)));
  if (hit.length) why.push(`build files changed: ${hit.join(', ')}`);
  if (af.gradleProperties && files.includes(af.gradleProperties) && range) {
    try {
      const d = execFileSync('git', ['-C', src, 'diff', '-U0', range, '--', af.gradleProperties], { encoding: 'utf8' });
      const keys = [...d.matchAll(/^[+-](?![+-])\s*([\w.]+)\s*=/gm)].map((m) => m[1]).filter((k) => !(af.propertiesExcept ?? []).includes(k));
      if (keys.length) why.push(`${af.gradleProperties}: ${[...new Set(keys)].join(', ')} changed (the Minecraft or a dependency version)`);
    } catch {
      why.push(`${af.gradleProperties} changed (no diff)`);
    }
  }
  const eng = files.filter((f) => (af.enginePaths ?? []).some((g) => re(g).test(f)));
  if (eng.length) why.push(`engine list: ${eng.slice(0, 4).join(', ')}${eng.length > 4 ? ` and ${eng.length - 4} more` : ''}`);
  const t = (af.tags ?? []).filter((x) => tags.includes(x));
  if (t.length) why.push(`${t.join(', ')}-touching (impact tags)`);
  return why;
}
