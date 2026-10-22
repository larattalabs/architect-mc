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
