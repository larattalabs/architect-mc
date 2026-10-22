// The step result cache and its input sets (tools/lib/step-cache.mjs, tools/lib/step-inputs.mjs; docs/GATES.md
// "Affected-only releases"), on a throwaway git repo: what changes a key, what is never recorded, what a lookup refuses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheContext, keyFor, lookup, record } from '../../tools/lib/step-cache.mjs';
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
