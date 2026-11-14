// The step cache for explicit lists (--only/--from; tools/lib/explicit-cache.mjs, docs/GATES.md "Slice GX as built"): a wrong hit
// is the risk, so each rule that keeps one out is tested on a throwaway git repo with the real key, record and lookup: own steps
// are never cached, changed inputs never hit, a dirty tree never hits, another Node/JDK or platform never hits, a strict-tier step
// takes only an exact key (never a coverage hit).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheContext, keyFor, lookup, record } from '../../tools/lib/step-cache.mjs';
import { staticEntry, treeAt } from '../../tools/lib/step-inputs.mjs';
import { commandPaths, entryShape, explicitDecision, isStrict, ownSteps, platformNow } from '../../tools/lib/explicit-cache.mjs';

// A platform that is never this one (CI runs on linux-x64, so a fixed linux-x64 would match there).
const OTHER_PLATFORM = platformNow() === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const conf = {
  classes: {}, classRules: {}, derived: {}, fingerprint: { globs: [] }, state: { globs: [] }, external: { ignore: [] }, uncacheable: {},
  modeEnv: { always: [], plumbing: '^(PATH|HOME)$' },
};
const cfg = { steps: { a: { shell: 'node tools/gate-a.mjs', client: 'none', timeoutMin: 5 } }, clients: {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-cache-'));
  git(root, 'init', '-q', '-b', 'slice/x');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  write(root, 'tools/gate-a.mjs', "import { b } from './lib/b.mjs';\n");
  write(root, 'tools/lib/b.mjs', 'export const b = 1;\n');
  write(root, 'kit/lib/other.mjs', 'export const o = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-cache-main-'));
  const map = { steps: { a: staticEntry('a', cfg.steps.a, conf, treeAt(root, 'HEAD'), { src: root }) } };
  const ctx = () => {
    const c = cacheContext({ src: root, main, cfg, conf, map, snapDir: null, env: {} });
    c.rawCfg = cfg;
    return c;
  };
  // a recorded, traced PASS of `a` at HEAD
  const rec = (c) => {
    const k = keyFor(c, 'a');
    const tdir = path.join(main, `trace-${Date.now()}`);
    write(tdir, '1.txt', '# node\nm\ttools/gate-a.mjs\nm\ttools/lib/b.mjs\n');
    const r = record(c, 'a', { id: 'a', status: 'PASS', startedAt: new Date().toISOString(), seconds: 1, ok: 1, log: 'a.log' },
      { key: k.key, parts: k.parts, run: main, ev: main, traceDir: tdir, traced: true, timingPolicy: 'recorded', judgedBench: false, tier: 'change' });
    assert.equal(r.stored, true, r.why);
    return k;
  };
  return { root, main, ctx, rec };
}
const decide = (c, { own = null, strict = false, coverage = null } = {}) => {
  const k = keyFor(c, 'a');
  return explicitDecision({ own, strict, key: k, exact: k.key ? lookup(c, 'a', k.key) : { hit: null, why: k.why }, coverage });
};

test('an unchanged key hits (the recorded PASS of this platform)', () => {
  const { ctx, rec } = setup();
  const k = rec(ctx());
  const d = decide(ctx());
  assert.ok(d.hit, d.why);
  assert.equal(d.hit.key, k.key);
  assert.equal(d.hit.platform, platformNow());
});

test('own steps are never cached, even with an exact recorded PASS', () => {
  const { ctx, rec } = setup();
  rec(ctx());
  const d = decide(ctx(), { own: '--own names it' });
  assert.equal(d.hit, null);
  assert.match(d.why, /own step/);
});

test('changed inputs never hit: an edit to a file in the set moves the key, the old PASS is not served', () => {
  const { root, ctx, rec } = setup();
  const k0 = rec(ctx());
  write(root, 'tools/lib/b.mjs', 'export const b = 2;\n');
  git(root, 'commit', '-qam', 'b');
  const c = ctx();
  assert.notEqual(keyFor(c, 'a').key, k0.key);
  assert.equal(decide(c).hit, null);
  // a file outside the set leaves the key (and the hit) alone
  write(root, 'kit/lib/other.mjs', 'export const o = 2;\n');
  git(root, 'commit', '-qam', 'o');
  assert.equal(decide(ctx()).hit, null, 'the old PASS stays unserved: its key is the old b.mjs');
  rec(ctx());
  write(root, 'kit/lib/other.mjs', 'export const o = 3;\n');
  git(root, 'commit', '-qam', 'o2');
  assert.ok(decide(ctx()).hit, 'outside the set: still a hit');
});

test('a dirty tree never hits (modified or untracked)', () => {
  const { root, ctx, rec } = setup();
  rec(ctx());
  write(root, 'kit/lib/other.mjs', 'export const o = 9;\n');
  let d = decide(ctx());
  assert.equal(d.hit, null);
  assert.match(d.why, /dirty/);
  git(root, 'checkout', '-q', '--', '.');
  write(root, 'tools/new.mjs', 'x\n');
  d = decide(ctx());
  assert.equal(d.hit, null);
  assert.match(d.why, /dirty/);
});

test('a different Node or JDK never hits: the toolchain is in the key', () => {
  const { ctx, rec } = setup();
  rec(ctx());
  for (const tc of [{ node: 'v0.0.1' }, { java: 'openjdk version "99"' }]) {
    const c = ctx();
    c.toolchain = { ...c.toolchain, ...tc };
    assert.equal(decide(c).hit, null, JSON.stringify(tc));
  }
});

test('a different platform never hits; an entry without a platform never serves an explicit list', () => {
  const { main, ctx, rec } = setup();
  const k = rec(ctx());
  const f = path.join(main, 'artifacts', 'step-cache', 'a', `${k.key}.json`);
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...e, platform: OTHER_PLATFORM }));
  assert.equal(lookup(ctx(), 'a', k.key).hit, null, 'lookup refuses another platform');
  assert.equal(decide(ctx()).hit, null);
  const { platform, ...legacy } = e;
  void platform;
  fs.writeFileSync(f, JSON.stringify(legacy));
  const d = decide(ctx());
  assert.equal(d.hit, null);
  assert.match(d.why, /before entries carried a platform/);
});

test('a strict-tier step takes only an exact key: a coverage hit never serves it; a light step may take one', () => {
  const { ctx } = setup();
  const cov = () => ({ hit: { key: 'other', platform: platformNow(), mode: 'coverage', status: 'PASS' }, why: 'coverage PASS' });
  const strict = decide(ctx(), { strict: true, coverage: cov });
  assert.equal(strict.hit, null);
  assert.match(strict.why, /strict tier: exact key only/);
  assert.ok(decide(ctx(), { strict: false, coverage: cov }).hit);
  const foreign = () => ({ hit: { key: 'other', platform: OTHER_PLATFORM, mode: 'coverage', status: 'PASS' }, why: 'coverage PASS' });
  assert.equal(decide(ctx(), { coverage: foreign }).hit, null, 'a coverage hit from another platform is refused too');
});

test('own by diff: a new step, a changed entry, a changed file its command names, --own; a desc or estimate edit is not', () => {
  const base = {
    a: { shell: 'node tools/gate-a.mjs unit', client: 'none', timeoutMin: 5, desc: 'x', estMin: 1 },
    b: { shell: 'node tools/gate-b.mjs', client: 'none' },
    c: { shell: 'node tools/gate-c.mjs && node tools/lib/helper.mjs', client: 'none' },
    d: { shell: 'node tools/gate-d.mjs', client: 'none' },
  };
  const now = {
    a: { ...base.a, desc: 'y', estMin: 9, timeoutMin: 50 },
    b: { ...base.b, env: { X: '1' } },
    c: base.c,
    d: base.d,
    e: { shell: 'node tools/gate-e.mjs', client: 'none' },
  };
  const own = ownSteps({ ids: ['a', 'b', 'c', 'd', 'e', 'd/p2'], now, base, files: ['tools/lib/helper.mjs'], own: ['d'] });
  assert.equal(own.has('a'), false, 'desc/estMin/timeoutMin only');
  assert.match(own.get('b'), /chain entry changed/);
  assert.match(own.get('c'), /tools\/lib\/helper\.mjs/);
  assert.match(own.get('d'), /--own/);
  assert.match(own.get('d/p2'), /--own/, 'a part of an own step is own');
  assert.match(own.get('e'), /new step/);
  // no range (base null): only --own and the files decide
  const noBase = ownSteps({ ids: ['a', 'e'], now, base: null, files: [] });
  assert.equal(noBase.size, 0);
  assert.deepEqual(commandPaths({ shell: 'rc=0; node tools/gate6cd.mjs unit || rc=1; node kit/tools/region.mjs plan' }).sort(), ['kit/tools/region.mjs', 'tools/gate6cd.mjs']);
  assert.equal(entryShape({ shell: 'x', desc: 'a' }), entryShape({ desc: 'b', shell: 'x' }));
});

test('the strict tier in tools/gate-cache.json: the crash, survival, ledger and undo steps are strict; d-unit is not', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../../tools/gate-cache.json', import.meta.url), 'utf8'));
  for (const id of ['rs-survival-smoke', 'rs-survival-smoke/p2', 'jr-crash', 'rl-crash', 'hf-crash', 'ps-crash', 'qt-unit', 'unit-mod', 'p3-lint', '4e-crash', 'pl-undo', 'safety-ingame', 'cu-ingame']) {
    assert.ok(isStrict(real.explicit, id), id);
  }
  for (const id of ['d-unit', 't1-unit', 'd3-unit', 'unit-kit', 'lint-structure', 'slb-ingame']) assert.ok(!isStrict(real.explicit, id), id);
  // by what it checks: a step whose desc names undo, E-flat, a ledger, a bill, a save is strict whatever its id
  const chains = JSON.parse(fs.readFileSync(new URL('../../tools/gate-chains.json', import.meta.url), 'utf8'));
  for (const id of ['y-unit', 'c29-unit', 'pt2-unit', 'slb-ingame', 'h-ingame', '0b-ingame', 'pa-unit']) assert.ok(isStrict(real.explicit, id, chains.steps[id]), id);
  for (const id of ['d-unit', 't1-unit', 'unit-kit', 'lint-structure']) assert.ok(!isStrict(real.explicit, id, chains.steps[id]), id);
});
