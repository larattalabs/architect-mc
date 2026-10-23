// The step result cache and its input sets (tools/lib/step-cache.mjs, tools/lib/step-inputs.mjs; docs/GATES.md
// "Affected-only releases"), on a throwaway git repo: what changes a key, what is never recorded, what a lookup refuses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheContext, entryByKey, entryStillValid, keyFor, lookup, record } from '../../tools/lib/step-cache.mjs';
import { checkTrace, globRe, inputMatcher, matcher, moduleClosure, staticEntry, treeAt, widenFromTrace } from '../../tools/lib/step-inputs.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cache-'));
  git(root, 'init', '-q', '-b', 'slice/x');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  write(root, 'tools/gate-a.mjs', "import { b } from './lib/b.mjs';\nconst u = new URL('../kit/data/x.json', import.meta.url);\nconst m = process.env.GATE_A_MODE;\nawait import(path.join(KIT, name));\n");
  write(root, 'tools/lib/b.mjs', "export const b = 1; const p = 'kit/fixtures/one.json';\n");
  write(root, 'tools/gate-other.mjs', 'export const o = 1;\n');
  write(root, 'kit/data/x.json', '{}\n');
  write(root, 'kit/fixtures/one.json', '1\n');
  write(root, 'kit/fixtures/two.json', '2\n');
  write(root, 'kit/lib/unrelated.mjs', 'export const u = 1;\n');
  write(root, 'docs/README.md', 'docs\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}
const conf = {
  classes: { jar: ['mod/**'], sidecar: ['kit/**', '!kit/fixtures/**'] },
  classRules: { client: ['jar', 'sidecar'] },
  derived: {},
  fingerprint: { globs: [] },
  state: { globs: ['mod/run/**'] },
  external: { ignore: ['gate-runs*/**'] },
  uncacheable: { 'u-step': 'fresh seeds' },
  modeEnv: { always: ['GATE_P3'], plumbing: '^(PATH|HOME|.*_OUT|.*_PORT)$' },
};
const cfgOf = () => ({
  steps: {
    a: { shell: 'node tools/gate-a.mjs', client: 'none', timeoutMin: 5 },
    'u-step': { shell: 'node tools/gate-other.mjs', client: 'none', timeoutMin: 5 },
  },
  clients: {},
});
function setup() {
  const root = repo();
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cache-main-'));
  const cfg = cfgOf();
  const files = treeAt(root, 'HEAD');
  const map = { steps: Object.fromEntries(Object.entries(cfg.steps).map(([id, e]) => [id, staticEntry(id, e, conf, files, { src: root })])) };
  const ctx = (env = {}) => {
    const c = cacheContext({ src: root, main, cfg, conf, map, snapDir: null, env: { GATE_A_MODE: 'x', ...env } });
    c.rawCfg = cfg;
    return c;
  };
  return { root, main, cfg, map, ctx };
}
const pass = (over = {}) => ({ id: 'a', status: 'PASS', startedAt: new Date().toISOString(), seconds: 3, ok: 2, log: 'a.log', ...over });

test('globs: ** spans directories, * one segment, ! excludes', () => {
  assert.ok(globRe('kit/**').test('kit/a/b.mjs'));
  assert.ok(globRe('kit/**/x.json').test('kit/x.json'));
  assert.ok(!globRe('kit/*.mjs').test('kit/a/b.mjs'));
  const m = matcher(['kit/**', '!kit/test/**']);
  assert.ok(m('kit/lib/a.mjs'));
  assert.ok(!m('kit/test/a.test.mjs'));
});

test('the closure: imports, new URL, literal paths; a computed import is listed, not widened; env names', () => {
  const { root, map } = setup();
  const c = moduleClosure(['tools/gate-a.mjs'], treeAt(root, 'HEAD'), { src: root });
  assert.deepEqual([...c.files].sort(), ['kit/data/x.json', 'kit/fixtures/one.json', 'tools/gate-a.mjs', 'tools/lib/b.mjs']);
  assert.equal(c.dynamic.length, 1);
  assert.ok(c.env.has('GATE_A_MODE'));
  assert.deepEqual(map.steps.a.roots, ['tools/gate-a.mjs']);
});

test('a key moves with an input, not with a file outside the set; docs never move it', () => {
  const { root, ctx } = setup();
  const k0 = keyFor(ctx(), 'a').key;
  assert.ok(k0);
  write(root, 'kit/lib/unrelated.mjs', 'export const u = 2;\n');
  write(root, 'docs/README.md', 'docs 2\n');
  git(root, 'commit', '-qam', 'outside');
  assert.equal(keyFor(ctx(), 'a').key, k0, 'unrelated kit file and docs');
  write(root, 'kit/fixtures/one.json', '1b\n');
  git(root, 'commit', '-qam', 'input');
  assert.notEqual(keyFor(ctx(), 'a').key, k0, 'a fixture in the set');
});

test('the mode environment is in the key (the closure\'s variables and GATE_P3); plumbing is not', () => {
  const { ctx } = setup();
  const k0 = keyFor(ctx(), 'a').key;
  assert.notEqual(keyFor(ctx({ GATE_A_MODE: 'y' }), 'a').key, k0);
  assert.notEqual(keyFor(ctx({ GATE_P3: 'ingame' }), 'a').key, k0);
  assert.equal(keyFor(ctx({ SOME_OUT: '/elsewhere' }), 'a').key, k0);
});

test('a dirty tree (modified or untracked) has no key; an uncacheable step has none', () => {
  const { root, ctx } = setup();
  write(root, 'kit/lib/unrelated.mjs', 'export const u = 3;\n');
  assert.equal(keyFor(ctx(), 'a').key, null);
  git(root, 'checkout', '-q', '--', '.');
  write(root, 'tools/new.mjs', 'x\n');
  assert.match(keyFor(ctx(), 'a').why, /dirty/);
  fs.rmSync(path.join(root, 'tools/new.mjs'));
  assert.match(keyFor(ctx(), 'u-step').why, /uncacheable/);
});

test('record: only a traced PASS inside its set, no bar recorded, not a judged bench; lookup serves it', () => {
  const { root, main, ctx } = setup();
  const c = ctx();
  const k = keyFor(c, 'a');
  const tdir = path.join(main, 'trace-a');
  write(tdir, '1.txt', '# node\nm\ttools/gate-a.mjs\nr\tkit/fixtures/one.json\n');
  const base = { key: k.key, parts: k.parts, run: main, ev: main, traceDir: tdir, traced: true, timingPolicy: 'recorded', judgedBench: false, tier: 'slice' };
  assert.equal(record(c, 'a', pass({ status: 'FAIL' }), base).stored, false);
  assert.equal(record(c, 'a', pass({ timingRecorded: ['FAIL BAR mspt'] }), base).stored, false);
  assert.equal(record(c, 'a', pass(), { ...base, judgedBench: true }).stored, false);
  assert.equal(record(c, 'a', pass(), { ...base, traced: false }).stored, false);
  assert.equal(lookup(c, 'a', k.key).hit, null);
  const r = record(c, 'a', pass(), base);
  assert.equal(r.stored, true, r.why);
  assert.equal(lookup(c, 'a', k.key).hit.status, 'PASS');
  void root;
});

test('a judged bench is recorded only from the nightly, judged and isolated; entryStillValid holds until its key moves', () => {
  const { main, ctx } = setup();
  const c = ctx();
  const k = keyFor(c, 'a');
  const tdir = path.join(main, 'trace-a');
  write(tdir, '1.txt', '# node\nm\ttools/gate-a.mjs\nr\tkit/fixtures/one.json\n');
  const base = { key: k.key, parts: k.parts, run: main, ev: main, traceDir: tdir, traced: true, judgedBench: true, tier: 'release' };
  // a release, a slice (recorded timing) or a contended nightly run never records a judged bench
  assert.equal(record(c, 'a', pass(), { ...base, timingPolicy: 'judged' }).stored, false);
  assert.equal(record(c, 'a', pass(), { ...base, timingPolicy: 'recorded', nightly: true }).stored, false);
  assert.equal(record(c, 'a', pass(), { ...base, timingPolicy: 'judged', nightly: true, contended: true }).stored, false);
  const r = record(c, 'a', pass(), { ...base, timingPolicy: 'judged', nightly: true });
  assert.equal(r.stored, true, r.why);
  const e = entryByKey(c, 'a', k.key);
  assert.deepEqual([e.nightly, e.benchJudged, e.timingPolicy], [true, true, 'judged']);
  assert.equal(entryStillValid(c, 'a', e).ok, true);
  assert.equal(entryStillValid(c, 'a', { ...e, key: 'another' }).ok, false);
  assert.match(entryStillValid(c, 'a', { ...e, key: 'another' }).why, /its key moved/);
});

test('a trace outside the set is an inputs-map miss: not recorded; merge widens the map; then it records', () => {
  const { root, main, map, ctx } = setup();
  const c = ctx();
  const k = keyFor(c, 'a');
  const tdir = path.join(main, 'trace-b');
  write(tdir, '1.txt', 'r\tkit/fixtures/two.json\ns\tmod/run/options.txt\n');
  const r = record(c, 'a', pass(), { key: k.key, parts: k.parts, run: main, ev: main, traceDir: tdir, traced: true, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, false);
  assert.deepEqual(r.outside, ['kit/fixtures/two.json'], 'run state (mod/run) is not an input');
  const tr = new Map([['kit/fixtures/two.json', new Set(['r'])]]);
  const added = widenFromTrace(map, conf, 'a', tr, treeAt(root, 'HEAD'));
  assert.deepEqual(added, ['kit/fixtures/**']);
  assert.ok(inputMatcher(map, conf, 'a')('kit/fixtures/two.json'));
  assert.deepEqual(checkTrace(map, conf, 'a', tr, { tracked: treeAt(root, 'HEAD') }).outside, []);
  const k2 = keyFor(c, 'a'); // the set grew: another key
  assert.notEqual(k2.key, k.key);
  assert.equal(record(c, 'a', pass(), { key: k2.key, parts: k2.parts, run: main, ev: main, traceDir: tdir, traced: true, timingPolicy: 'judged', judgedBench: false, tier: 'release' }).stored, true);
});

test('an archived input under artifacts/ is fingerprinted: changing it makes the lookup miss', () => {
  const { main, ctx } = setup();
  const c = ctx();
  const k = keyFor(c, 'a');
  write(main, 'artifacts/gate6c-x/v0160/surface.json', '{"a":1}\n');
  write(main, 'artifacts/gate-runs-x/r/own.log', 'evidence\n');
  const tdir = path.join(main, 'trace-c');
  write(tdir, '1.txt', 'r\t@artifacts/gate6c-x/v0160/surface.json\nr\t@artifacts/gate-runs-x/r/own.log\n');
  const r = record(c, 'a', pass(), { key: k.key, parts: k.parts, run: main, ev: main, traceDir: tdir, traced: true, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  assert.ok(lookup(c, 'a', k.key).hit);
  write(main, 'artifacts/gate6c-x/v0160/surface.json', '{"a":22}\n');
  assert.match(lookup(c, 'a', k.key).why, /archived input changed/);
});

// ------------------------------------------------------------------ coverage mode (tools/lib/step-coverage.mjs)

import { coverageSet, constantChanges, collect, snapshotStart } from '../../tools/lib/step-coverage.mjs';
import { lookupCoverage, coverageMode } from '../../tools/lib/step-cache.mjs';

function covRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-'));
  git(root, 'init', '-q', '-b', 'slice/x');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  const J = 'mod/src/main/java/dev/larattalabs/architect';
  write(root, 'tools/gate-g.mjs', "import { k } from '../kit/lib/used.mjs';\n");
  write(root, 'kit/lib/used.mjs', 'export const k = 1;\n');
  write(root, 'kit/lib/forms/unused.mjs', 'export const f = 1;\n');
  write(root, `${J}/journal/Journal.java`, 'package dev.larattalabs.architect.journal; public class Journal { public static final int LIMIT = 4; }\n');
  write(root, `${J}/region/RegionFluids.java`, 'package dev.larattalabs.architect.region; public class RegionFluids { int x = 1; }\n');
  write(root, `${J}/mixin/LevelMixin.java`, 'package dev.larattalabs.architect.mixin; class LevelMixin {}\n');
  write(root, 'mod/build.gradle', '// build\n');
  write(root, 'docs/x.md', 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}
const covConf = {
  ...conf,
  classes: { jar: ['mod/**', '!mod/src/test/**'], sidecar: ['kit/**'] },
  coverage: { enabled: true, replaces: ['jar', 'sidecar', 'world'], packagePrefix: 'dev.larattalabs.', javaRoots: ['mod/src/main/java'], always: ['mod/build.gradle', 'mod/src/*/java/**/mixin/**'], alwaysRoots: [] },
};

test('coverage: a class or kit module the run never touched is outside the set; touched, mixins and build files are in', () => {
  const root = covRepo();
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-main-'));
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs', client: '6b', timeoutMin: 5 } }, clients: { '6b': { world: 'W' } } };
  const files = treeAt(root, 'HEAD');
  const map = { steps: { g: staticEntry('g', cfg.steps.g, covConf, files, { src: root }) } };
  const ctx = () => {
    const c = cacheContext({ src: root, main, cfg, conf: covConf, map, snapDir: null, env: {} });
    c.rawCfg = cfg;
    return c;
  };
  assert.ok(coverageMode(ctx(), 'g'));
  // the run's JVM loaded Journal only; its node touched used.mjs only
  const covDir = path.join(main, 'cov');
  write(covDir, 'jvm-1.log', '[0.1s] dev.larattalabs.architect.journal.Journal source: file:/x\n[0.1s] java.lang.Object source: jrt:/java.base\n');
  const cov = collect(covDir, { t: 0, alive: new Set() });
  assert.deepEqual(cov.classes, ['dev.larattalabs.architect.journal.Journal']);
  const tdir = path.join(main, 'trace-g');
  write(tdir, '1.txt', 'm\ttools/gate-g.mjs\nm\tkit/lib/used.mjs\n');
  const c0 = ctx();
  const r = record(c0, 'g', pass({ id: 'g' }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: cov, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  const e = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(e.mode, 'coverage');
  for (const p of ['mod/src/main/java/dev/larattalabs/architect/journal/Journal.java', 'kit/lib/used.mjs', 'mod/build.gradle']) assert.ok(e.coverageSet.includes(p), p);
  assert.ok(!e.coverageSet.some((p) => p.includes('RegionFluids') || p.includes('forms')));
  assert.ok(lookupCoverage(ctx(), 'g').hit, 'unchanged: served');
  // an untouched class and an untouched kit module change: still served
  write(root, 'mod/src/main/java/dev/larattalabs/architect/region/RegionFluids.java', 'package dev.larattalabs.architect.region; public class RegionFluids { int x = 2; }\n');
  write(root, 'kit/lib/forms/unused.mjs', 'export const f = 2;\n');
  git(root, 'commit', '-qam', 'outside');
  assert.ok(lookupCoverage(ctx(), 'g').hit, 'changes outside the coverage: served');
  // a mixin (always in) changes: miss
  write(root, 'mod/src/main/java/dev/larattalabs/architect/mixin/LevelMixin.java', 'package dev.larattalabs.architect.mixin; class LevelMixin { int y; }\n');
  git(root, 'commit', '-qam', 'mixin');
  assert.equal(lookupCoverage(ctx(), 'g').hit, null, 'a mixin is always in');
});

test('coverage: a touched file changing, or a compile-time constant anywhere, re-runs the step', () => {
  const root = covRepo();
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-main-'));
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs', client: '6b', timeoutMin: 5 } }, clients: { '6b': { world: 'W' } } };
  const map = { steps: { g: staticEntry('g', cfg.steps.g, covConf, treeAt(root, 'HEAD'), { src: root }) } };
  const ctx = () => Object.assign(cacheContext({ src: root, main, cfg, conf: covConf, map, snapDir: null, env: {} }), { rawCfg: cfg });
  const covDir = path.join(main, 'cov');
  write(covDir, 'jvm-1.log', '[0.1s] dev.larattalabs.architect.region.RegionFluids source: file:/x\n');
  const tdir = path.join(main, 'trace-g');
  write(tdir, '1.txt', 'm\ttools/gate-g.mjs\n');
  const r = record(ctx(), 'g', pass({ id: 'g' }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: collect(covDir, { t: 0, alive: new Set() }), timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  // Journal (not loaded) changes a compile-time constant: javac inlines it elsewhere, so every coverage PASS is invalid
  write(root, 'mod/src/main/java/dev/larattalabs/architect/journal/Journal.java', 'package dev.larattalabs.architect.journal; public class Journal { public static final int LIMIT = 5; }\n');
  git(root, 'commit', '-qam', 'constant');
  assert.ok(constantChanges(root, 'HEAD~1', 'HEAD', ['mod/src/main/java']).size === 1);
  assert.match(lookupCoverage(ctx(), 'g').why, /compile-time constant/);
  // a fresh PASS at the new head; then the touched class changes: miss
  const r2 = record(ctx(), 'g', pass({ id: 'g', startedAt: new Date(Date.now() + 1000).toISOString() }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: collect(covDir, { t: 0, alive: new Set() }), timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r2.stored, true);
  assert.ok(lookupCoverage(ctx(), 'g').hit);
  write(root, 'mod/src/main/java/dev/larattalabs/architect/region/RegionFluids.java', 'package dev.larattalabs.architect.region; public class RegionFluids { int x = 3; }\n');
  git(root, 'commit', '-qam', 'touched');
  assert.equal(lookupCoverage(ctx(), 'g').hit, null);
});

test('coverage: a JVM alive at a step\'s start counts (a reused client), one that ended before does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-snap-'));
  write(dir, `jvm-${process.pid}.log`, '[0.1s] dev.larattalabs.A source: x\n'); // this process: alive
  write(dir, 'jvm-999999.log', '[0.1s] dev.larattalabs.Dead source: x\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'jvm-999999.log'), old, old);
  const snap = snapshotStart(dir);
  assert.deepEqual(collect(dir, snap).classes, ['dev.larattalabs.A']);
  void coverageSet;
});

test('coverage: the sidecar still stats kit/tools/region.mjs before it spawns the untraced region CLI (whenTouched relies on it)', () => {
  const src = fs.readFileSync(new URL('../../sidecar/src/regions.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('private async runKit('), src.indexOf('private async runKit(') + 2500);
  assert.match(body, /const script = path\.join\(kit, 'tools', 'region\.mjs'\);\s*\n\s*if \(!fs\.existsSync\(script\)\)/, 'runKit must stat the script (the trace sees that stat) before the permission-model spawn');
  assert.match(body, /env: minimalEnv\(\)/);
  const gc = JSON.parse(fs.readFileSync(new URL('../../tools/gate-cache.json', import.meta.url), 'utf8'));
  assert.equal(gc.coverage.whenTouched['kit/tools/region.mjs'].kinds, 's');
});

test('coverage: a step whose trace shows the region CLI stat gets the CLI closure and every region program', () => {
  const root = covRepo();
  write(root, 'kit/tools/region.mjs', "import '../lib/region/plan.mjs';\n");
  write(root, 'kit/lib/region/plan.mjs', "import '../forms/unused.mjs';\nexport const KIT_VERSION = '1';\n");
  write(root, 'kit/regions/demo.mjs', "import '../lib/used.mjs';\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'region cli');
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs', client: '6b', timeoutMin: 5 } } };
  const files = treeAt(root, 'HEAD');
  const entry = staticEntry('g', cfg.steps.g, covConf, files, { src: root });
  const conf2 = { ...covConf, coverage: { ...covConf.coverage, whenTouched: { 'kit/tools/region.mjs': { kinds: 's', roots: ['kit/tools/region.mjs', 'kit/regions/*.mjs'], globs: ['kit/regions/**'] } } } };
  const without = coverageSet({ entry, trace: new Map(), cov: { classes: [], node: new Map() }, conf: conf2, tree: files, src: root }).set;
  assert.ok(!without.includes('kit/lib/forms/unused.mjs'));
  const withCli = coverageSet({ entry, trace: new Map(), cov: { classes: [], node: new Map([['kit/tools/region.mjs', new Set(['s'])]]) }, conf: conf2, tree: files, src: root }).set;
  for (const p of ['kit/tools/region.mjs', 'kit/lib/region/plan.mjs', 'kit/lib/forms/unused.mjs', 'kit/regions/**']) assert.ok(withCli.includes(p), p);
});

test('coverage, bytecode mode: keyed by the loaded classes\' class-file digests from the build artifact; no artifact, no key', () => {
  const root = covRepo();
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-main-'));
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs', client: '6b', timeoutMin: 5 } }, clients: { '6b': { world: 'W' } } };
  const map = { steps: { g: staticEntry('g', cfg.steps.g, covConf, treeAt(root, 'HEAD'), { src: root }) } };
  const J = 'dev.larattalabs.architect';
  let manifest = { ok: true, hash: 'b1', classes: { [`${J}.journal.Journal`]: 'aa', [`${J}.region.RegionFluids`]: 'bb' } };
  const ctx = () => Object.assign(cacheContext({ src: root, main, cfg, conf: covConf, map, snapDir: null, env: {} }), { rawCfg: cfg, manifest });
  const covDir = path.join(main, 'cov');
  write(covDir, 'jvm-1.log', `[0.1s] ${J}.journal.Journal source: x\n`);
  const tdir = path.join(main, 'trace-g');
  write(tdir, '1.txt', 'm\ttools/gate-g.mjs\n');
  const r = record(ctx(), 'g', pass({ id: 'g' }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: collect(covDir, { t: 0, alive: new Set() }), timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  const e = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(e.coverageClasses, [`${J}.journal.Journal`]);
  assert.ok(!e.coverageSet.some((p) => p.endsWith('Journal.java')), 'a class the artifact compiled is keyed by bytecode, not source');
  // a source edit in Journal.java that compiles to the same bytecode (a comment): still served
  write(root, 'mod/src/main/java/dev/larattalabs/architect/journal/Journal.java', '// a comment\npackage dev.larattalabs.architect.journal; public class Journal { public static final int LIMIT = 4; }\n');
  git(root, 'commit', '-qam', 'comment');
  assert.ok(lookupCoverage(ctx(), 'g').hit, 'same bytecode: served');
  // another class's bytecode moves (a constant inlined into it, say): still served; the loaded one's moves: miss
  manifest = { ...manifest, hash: 'b2', classes: { ...manifest.classes, [`${J}.region.RegionFluids`]: 'cc' } };
  assert.ok(lookupCoverage(ctx(), 'g').hit);
  manifest = { ...manifest, hash: 'b3', classes: { ...manifest.classes, [`${J}.journal.Journal`]: 'dd' } };
  assert.equal(lookupCoverage(ctx(), 'g').hit, null);
  // a failed build: no coverage key at all
  manifest = { ok: false, hash: 'b4', error: 'gradle exited 1' };
  assert.match(lookupCoverage(ctx(), 'g').why, /build artifact|differs|changed|unknown|recorded/);
  assert.equal(lookupCoverage(ctx(), 'g').hit, null);
});

test('coverage: test filters resolve at each commit (a new test a wildcard selects by method name moves the key)', async () => {
  const { setHash } = await import('../../tools/lib/step-cache.mjs');
  const { testSourcesMatching } = await import('../../tools/lib/step-coverage.mjs');
  const root = covRepo();
  write(root, 'mod/src/test/java/dev/larattalabs/architect/AlphaTest.java', 'class AlphaTest { void irStaleReads() {} }\n');
  write(root, 'mod/src/test/java/dev/larattalabs/architect/BetaTest.java', 'class BetaTest { void other() {} }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'tests');
  const tree = treeAt(root, 'HEAD');
  const show = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.deepEqual(testSourcesMatching(['*irStale*'], tree, ['mod/src/test/java'], show), ['mod/src/test/java/dev/larattalabs/architect/AlphaTest.java']);
  assert.deepEqual(testSourcesMatching(['dev.larattalabs.architect.BetaTest.other'], tree, ['mod/src/test/java'], show), ['mod/src/test/java/dev/larattalabs/architect/BetaTest.java']);
  const set = ['mod/build.gradle', '@tests:*irStale*'];
  const h0 = setHash(set, root, 'HEAD').hash;
  write(root, 'mod/src/test/java/dev/larattalabs/architect/BetaTest.java', 'class BetaTest { void other() {} void irStaleToo() {} }\n');
  git(root, 'commit', '-qam', 'a method the wildcard now selects');
  assert.notEqual(setHash(set, root, 'HEAD').hash, h0);
  const h1 = setHash(set, root, 'HEAD').hash;
  write(root, 'mod/src/test/java/dev/larattalabs/architect/GammaTest.java', 'class GammaTest { void unrelated() {} }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'an unrelated test');
  assert.equal(setHash(set, root, 'HEAD').hash, h1);
});

test('coverage: drivers count by their eager imports; a lazy import() only when a run executed it; a driver edit that starts executing it moves the key', () => {
  const root = covRepo();
  write(root, 'kit/lib/lazy.mjs', 'export const lazy = 1;\n');
  write(root, 'tools/gate-g.mjs', "import { k } from '../kit/lib/used.mjs';\nif (process.argv[2] === 'scenario') await import('../kit/lib/lazy.mjs');\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'a driver with a lazy subcommand');
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-main-'));
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs base', client: '6b', timeoutMin: 5 } }, clients: { '6b': { world: 'W' } } };
  const map = { steps: { g: staticEntry('g', cfg.steps.g, covConf, treeAt(root, 'HEAD'), { src: root }) } };
  assert.ok(map.steps.g.closure.includes('kit/lib/lazy.mjs'), 'the full static closure (the CI check) has the lazy import');
  assert.ok(!map.steps.g.eager.includes('kit/lib/lazy.mjs') && map.steps.g.eager.includes('kit/lib/used.mjs'));
  const ctx = () => Object.assign(cacheContext({ src: root, main, cfg, conf: covConf, map, snapDir: null, env: {} }), { rawCfg: cfg });
  const tdir = path.join(main, 'trace-g');
  write(tdir, '1.txt', 'm\ttools/gate-g.mjs\nm\tkit/lib/used.mjs\n'); // `base`: the lazy path never ran
  const r = record(ctx(), 'g', pass({ id: 'g' }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: { classes: [], node: new Map() }, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  write(root, 'kit/lib/lazy.mjs', 'export const lazy = 2;\n');
  git(root, 'commit', '-qam', 'the lazy module changes');
  assert.ok(lookupCoverage(ctx(), 'g').hit, 'a lazy module the run never loaded: served');
  write(root, 'tools/gate-g.mjs', "import { k } from '../kit/lib/used.mjs';\nawait import('../kit/lib/lazy.mjs');\n");
  git(root, 'commit', '-qam', 'the driver now always executes the lazy import');
  assert.equal(lookupCoverage(ctx(), 'g').hit, null, 'the driver itself changed: re-run (and re-traced)');
});

test('coverage, execution mode (JaCoCo): a loaded class never entered counts by its skeleton; an entered one whole; load-mode PASSes still validate', () => {
  const root = covRepo();
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-main-'));
  const cfg = { steps: { g: { shell: 'node tools/gate-g.mjs', client: '6b', timeoutMin: 5 } }, clients: { '6b': { world: 'W' } } };
  const map = { steps: { g: staticEntry('g', cfg.steps.g, covConf, treeAt(root, 'HEAD'), { src: root }) } };
  const J = 'dev.larattalabs.architect';
  const JN = `${J}.journal.Journal`;
  const RF = `${J}.region.RegionFluids`;
  let manifest = { ok: true, hash: 'b1', classes: { [JN]: 'aa', [RF]: 'bb' }, skel: { [JN]: 's-aa', [RF]: 's-bb' } };
  const ctx = () => Object.assign(cacheContext({ src: root, main, cfg, conf: covConf, map, snapDir: null, env: {} }), { rawCfg: cfg, manifest });
  const covDir = path.join(main, 'cov');
  write(covDir, 'jvm-1.log', `[0.1s] ${JN} source: x\n[0.1s] ${RF} source: x\n`);
  // the JVM's dump answered this step's token: it entered Journal, only loaded RegionFluids
  write(covDir, 'jvm-1.entered', `# token t1\n# at 1\ne ${JN.replaceAll('.', '/')}\n`);
  const { readDump } = { readDump: (d, pid) => ({ token: 't1', entered: new Set([JN]), uninstrumented: new Set(), pid, d }) };
  const cov = collect(covDir, { t: 0, alive: new Set() }, { exec: { token: 't1' }, readDump });
  assert.deepEqual(cov.entered, [JN]);
  const tdir = path.join(main, 'trace-g');
  write(tdir, '1.txt', 'm\ttools/gate-g.mjs\n');
  const r = record(ctx(), 'g', pass({ id: 'g' }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: cov, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(r.stored, true, r.why);
  const e = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(e.coverageEntered, [JN]);
  assert.match(e.coverageGranularity, /^entered-class\//);
  // a load-mode PASS of the same step (no entered list), recorded before: it still validates on its own terms
  const legacy = record(ctx(), 'g', pass({ id: 'g', startedAt: new Date(Date.now() - 5000).toISOString() }), { key: 'x', run: main, ev: main, traceDir: tdir, traced: true, coverage: { ...cov, entered: null }, timingPolicy: 'judged', judgedBench: false, tier: 'release' });
  assert.equal(legacy.stored, true, legacy.why);
  assert.notEqual(legacy.key, r.key, 'the granularity is in the key');
  assert.ok(entryStillValid(ctx(), 'g', JSON.parse(fs.readFileSync(legacy.file, 'utf8'))).ok);
  // RegionFluids' body moves, its skeleton doesn't: the execution PASS holds, the load-mode one doesn't
  manifest = { ...manifest, hash: 'b2', classes: { ...manifest.classes, [RF]: 'cc' } };
  assert.ok(entryStillValid(ctx(), 'g', e).ok, 'a body of a class it never entered');
  assert.equal(entryStillValid(ctx(), 'g', JSON.parse(fs.readFileSync(legacy.file, 'utf8'))).ok, false);
  // its skeleton moves (a constant, a member, <clinit>): miss
  manifest = { ...manifest, hash: 'b3', skel: { ...manifest.skel, [RF]: 's-cc' } };
  assert.equal(entryStillValid(ctx(), 'g', e).ok, false);
  // the entered class moves anywhere: miss; a manifest without skeletons counts every class whole: miss
  manifest = { ...manifest, hash: 'b4', skel: { ...manifest.skel, [RF]: 's-bb' }, classes: { ...manifest.classes, [RF]: 'bb', [JN]: 'zz' } };
  assert.equal(entryStillValid(ctx(), 'g', e).ok, false);
  manifest = { ok: true, hash: 'b5', classes: { [JN]: 'aa', [RF]: 'bb' } };
  assert.equal(entryStillValid(ctx(), 'g', e).ok, false, 'no skeletons: the never-entered class counts whole, so the key moves');
});

test('coverage: a hidden lambda class counts as its host (keyed by the host\'s bytecode, never its source)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-hidden-'));
  write(dir, 'jvm-1.log', '[0.1s] dev.larattalabs.a.Roads source: x\n[0.2s] dev.larattalabs.a.Roads$$Lambda/0x000003e0025628a8 source: dev.larattalabs.a.Roads\n[0.3s] dev.larattalabs.b.Only$$Lambda/0x01 source: x\n');
  const c = collect(dir, { t: 0, alive: new Set() }, { exec: { token: 't' }, readDump: () => ({ token: 't', entered: new Set(), uninstrumented: new Set() }) });
  assert.deepEqual(c.classes, ['dev.larattalabs.a.Roads', 'dev.larattalabs.b.Only']);
  assert.deepEqual(c.entered, ['dev.larattalabs.a.Roads', 'dev.larattalabs.b.Only'], 'a spun lambda means its host ran the invokedynamic: entered');
});

test('coverage: a dump older than its JVM\'s agent start (a reused pid) is stale: that JVM counts every loaded class as entered', async () => {
  const { readDump } = await import('../../tools/lib/jacoco.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-cov-pid-'));
  write(dir, 'jvm-7.log', '[0.1s] dev.larattalabs.a.A source: x\n[0.1s] dev.larattalabs.a.B source: x\n[0.1s] dev.larattalabs.a.mixin.Helper source: x\n');
  write(dir, 'jvm-7.entered', '# token exit\n# at 1000\ne dev/larattalabs/a/A\n');
  write(dir, 'jvm-7.agent', 'pid 7\nstarted 2000\n');
  let c = collect(dir, { t: 0, alive: new Set() }, { exec: { token: 't' }, readDump });
  assert.match(c.jvms[0].exec, /stale/);
  assert.deepEqual(c.entered, ['dev.larattalabs.a.A', 'dev.larattalabs.a.B', 'dev.larattalabs.a.mixin.Helper']);
  // the same dump written after the agent started is this JVM's: A entered; B loaded only; a mixin-package class always entered
  write(dir, 'jvm-7.agent', 'pid 7\nstarted 500\n');
  c = collect(dir, { t: 0, alive: new Set() }, { exec: { token: 't' }, readDump });
  assert.deepEqual(c.entered, ['dev.larattalabs.a.A', 'dev.larattalabs.a.mixin.Helper']);
});
