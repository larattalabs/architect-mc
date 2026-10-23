// Execution coverage with JaCoCo (tools/lib/jacoco.mjs, tools/lib/GateCovAgent.java, tools/lib/GateCovTool.java; docs/GATES.md
// "Execution coverage (JaCoCo)"): real javac fixtures under the real agent. Each test tries to serve a stale PASS: the key a run
// recorded (its loaded and entered classes, digested against the build it ran) must move whenever a change could reach what the
// run did, and may stay when the change is in code it never entered. Skipped when the pinned jars are not in the vendor dir (CI):
// `node tools/lib/jacoco.mjs fetch`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bytecodeDigest, classManifest } from '../../tools/lib/build-artifact.mjs';
import { agentOption, helpers, readDump, requestDumps, skeletons, verify } from '../../tools/lib/jacoco.mjs';
import { collect, javaLogOption, snapshotStart } from '../../tools/lib/step-coverage.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = path.resolve(SRC, '..', 'architect-mc');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const ready = fs.existsSync(path.join(JAVA_HOME, 'bin', 'javac')) && verify(MAIN).ok && helpers(MAIN).ok;
const skip = ready ? false : `the pinned JaCoCo jars or a JDK are not here (${verify(MAIN).why ?? helpers(MAIN).why ?? JAVA_HOME}): node tools/lib/jacoco.mjs fetch`;

// the fixture: Main drives phases from stdin; what each class's role is
const BASE = {
  Main: `public class Main {
  public static void main(String[] a) throws Exception {
    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
    for (String l; (l = in.readLine()) != null;) {
      if (l.equals("phase1")) {
        int x = Entered.run(2);
        try { Thrower.parse("not a number"); } catch (NumberFormatException e) { x++; }
        Object o = new Object();
        boolean b = o instanceof Loaded || o instanceof Marker || o instanceof Empty;
        Loaded[] arr = new Loaded[0];
        x += arr.length + (b ? 1 : 0) + Loaded.class.getName().length() + new Impl().name().length();
        System.out.println("ok1 " + x);
      } else if (l.equals("phase2")) {
        System.out.println("ok2 " + Late.run());
      }
    }
  }
}`,
  Entered: 'class Entered { static int run(int x) { return x * 2; } static int unused() { return 9; } }',
  // throws before its first probe (JaCoCo marks code only once the probe after it runs): no hits, but entered
  Thrower: 'class Thrower { static int parse(String s) { return Integer.parseInt(s); } }',
  // loaded (instanceof, an array, a class literal), never initialized nor entered
  Loaded: 'class Loaded { static final int K = 4; static int z = init(); static int init() { return 3; } int body() { return 1; } }',
  // a loaded interface with code it never ran (instrumented, never entered)
  Marker: 'interface Marker { default int m() { return 0; } }',
  // an interface with no code: JaCoCo leaves it uninstrumented, so it counts as entered
  Empty: 'interface Empty { }',
  Iface: 'interface Iface { String name(); }',
  Impl: 'class Impl implements Iface { public String name() { return "impl"; } }',
  Late: 'class Late { static int run() { return 7; } }',
  Never: 'class Never { int body() { return 1; } }',
};

function compile(dir, over = {}) {
  const src = path.join(dir, 'src', 'dev', 'larattalabs', 'fx');
  fs.mkdirSync(src, { recursive: true });
  const files = [];
  for (const [n, body] of Object.entries({ ...BASE, ...over })) {
    const f = path.join(src, `${n}.java`);
    fs.writeFileSync(f, `package dev.larattalabs.fx;\n${body}\n`);
    files.push(f);
  }
  const out = path.join(dir, 'classes');
  const r = spawnSync(path.join(JAVA_HOME, 'bin', 'javac'), ['-d', out, ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = { ok: true, classes: classManifest(dir, ['classes']), skel: skeletons(MAIN, [out]) };
  assert.ok(m.skel && Object.keys(m.skel).length >= 10, 'skeletons computed');
  return { dir, out, m };
}

/** Starts the fixture JVM with the gate's JAVA_TOOL_OPTIONS (class-load log + agent) on coverage dir `cov`. */
function startJvm(classes, cov) {
  fs.mkdirSync(cov, { recursive: true });
  const a = agentOption(MAIN, cov);
  assert.ok(a.option, a.why);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_TOOL_OPTIONS: `${javaLogOption(cov)} ${a.option}` };
  const child = spawn(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', classes, 'dev.larattalabs.fx.Main'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const waitFor = async (s) => {
    for (let i = 0; i < 300 && !out.includes(s); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(out.includes(s), `the fixture printed ${s}: ${out}`);
  };
  // the agent writes its marker in premain; wait for it before driving phases
  return { child, waitFor, send: (l) => child.stdin.write(`${l}\n`), stop: () => new Promise((r) => (child.exitCode != null ? r() : (child.once('exit', r), child.stdin.end()))) };
}

const J = 'dev.larattalabs.fx';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'step-jacoco-'));

/** One recorded run: phase1 in a JVM, the step's dump at its end. -> { loaded, entered, base } */
async function recordedRun() {
  const root = tmp();
  const base = compile(path.join(root, 'v0'));
  const cov = path.join(root, 'cov');
  const snap = snapshotStart(cov);
  const jvm = startJvm(base.out, cov);
  jvm.send('phase1');
  await jvm.waitFor('ok1');
  const exec = await requestDumps(cov, { timeoutMs: 15_000 });
  assert.deepEqual(exec.missing, []);
  const c = collect(cov, snap, { exec, readDump });
  await jvm.stop();
  return { root, base, loaded: c.classes, entered: c.entered, jvms: c.jvms };
}

test('execution coverage: entered vs loaded under the real agent (a method that threw before any probe is entered)', { skip }, async () => {
  const r = await recordedRun();
  for (const n of ['Main', 'Entered', 'Thrower', 'Impl']) assert.ok(r.entered.includes(`${J}.${n}`), `${n} entered`);
  assert.ok(r.entered.includes(`${J}.Empty`), 'an uninstrumented class (no code) counts as entered');
  for (const n of ['Loaded', 'Marker']) {
    assert.ok(r.loaded.includes(`${J}.${n}`), `${n} loaded`);
    assert.ok(!r.entered.includes(`${J}.${n}`), `${n} not entered`);
  }
  assert.ok(!r.loaded.includes(`${J}.Never`) && !r.loaded.includes(`${J}.Late`));
  assert.equal(r.jvms.length, 1);
  assert.equal(r.jvms[0].exec, 'dump');
});

test('execution coverage: no stale PASS: a changed entered method, <clinit>, constant, member or interface misses; never-entered bodies may hit', { skip }, async () => {
  const r = await recordedRun();
  const key = (m) => bytecodeDigest(r.loaded, m, r.entered);
  const k0 = key(r.base.m);
  // same sources, recompiled elsewhere: the same key (the build is reproducible)
  assert.equal(key(compile(path.join(r.root, 'same')).m), k0);
  const variant = (name, over) => key(compile(path.join(r.root, name), over).m);
  // MUST MISS
  assert.notEqual(variant('entered-other', { Entered: 'class Entered { static int run(int x) { return x * 2; } static int unused() { return 10; } }' }), k0,
    'an entered class: any change counts (class granularity), even in a method it did not run');
  assert.notEqual(variant('entered-run', { Entered: 'class Entered { static int run(int x) { return x * 3; } static int unused() { return 9; } }' }), k0, 'a method it executed');
  assert.notEqual(variant('thrower', { Thrower: 'class Thrower { static int parse(String s) { return Integer.parseInt(s.trim()); } }' }), k0,
    'a method that threw before its first probe (no hits) is still entered');
  assert.notEqual(variant('clinit', { Loaded: 'class Loaded { static final int K = 4; static int z = init() + 1; static int init() { return 3; } int body() { return 1; } }' }), k0,
    'the static initializer of a class it loaded but never entered');
  assert.notEqual(variant('constant', { Loaded: 'class Loaded { static final int K = 5; static int z = init(); static int init() { return 3; } int body() { return 1; } }' }), k0,
    'a constant value of a loaded class');
  assert.notEqual(variant('member', { Loaded: 'class Loaded { static final int K = 4; static int z = init(); static int init() { return 3; } int body() { return 1; } public String toString() { return "x"; } }' }), k0,
    'a new member (an override) of a loaded class');
  assert.notEqual(variant('default', { Marker: 'interface Marker { default int m() { return 0; } default int d() { return 1; } }' }), k0, 'a default method added to a loaded interface');
  assert.notEqual(variant('hierarchy', { Loaded: 'class Loaded implements Marker { static final int K = 4; static int z = init(); static int init() { return 3; } int body() { return 1; } }' }), k0,
    'a loaded class\'s interfaces (instanceof reads them)');
  // MAY HIT: a body it never entered, a class it never loaded
  assert.equal(variant('body', { Loaded: 'class Loaded { static final int K = 4; static int z = init(); static int init() { return 30; } int body() { return 2; } }' }), k0,
    'a method body of a class it loaded but never entered');
  assert.equal(variant('default-body', { Marker: 'interface Marker { default int m() { return 5; } }' }), k0, 'a default method body it never ran');
  assert.equal(variant('never', { Never: 'class Never { int body() { return 2; } }', Late: 'class Late { static int run() { return 8; } }' }), k0, 'classes it never loaded');
  // the class-load key (no entered list) misses on that same never-entered body: what execution coverage narrows
  assert.notEqual(bytecodeDigest(r.loaded, compile(path.join(r.root, 'body2'), { Loaded: 'class Loaded { static final int K = 4; static int z = init(); static int init() { return 3; } int body() { return 2; } }' }).m), bytecodeDigest(r.loaded, r.base.m));
});

test('execution coverage: a JVM reused across steps stays cumulative; one killed mid-step counts every class it loaded as entered', { skip }, async () => {
  const root = tmp();
  const base = compile(path.join(root, 'v0'));
  const cov = path.join(root, 'cov');
  const jvm = startJvm(base.out, cov);
  // step 1
  const s1 = snapshotStart(cov);
  jvm.send('phase1');
  await jvm.waitFor('ok1');
  const c1 = collect(cov, s1, { exec: await requestDumps(cov), readDump });
  assert.ok(c1.entered.includes(`${J}.Entered`) && !c1.entered.includes(`${J}.Late`));
  // step 2 on the same JVM: it keeps step 1's classes
  const s2 = snapshotStart(cov);
  assert.equal(s2.alive.size, 1, 'the reused JVM is alive at step 2\'s start');
  jvm.send('phase2');
  await jvm.waitFor('ok2');
  const c2 = collect(cov, s2, { exec: await requestDumps(cov), readDump });
  for (const n of ['Entered', 'Thrower', 'Late']) assert.ok(c2.entered.includes(`${J}.${n}`), `${n}: cumulative`);
  assert.ok(!c2.entered.includes(`${J}.Loaded`));
  // step 3: the JVM is killed before the step's end can ask it: its last dump is step 2's, so it is stale and its loaded classes
  // (Loaded included) all count as entered
  const s3 = snapshotStart(cov);
  process.kill(jvm.child.pid, 'SIGKILL');
  await new Promise((r) => jvm.child.once('exit', r));
  const e3 = await requestDumps(cov, { timeoutMs: 2000 });
  const c3 = collect(cov, s3, { exec: e3, readDump });
  assert.match(c3.jvms[0].exec, /stale/);
  assert.ok(c3.entered.includes(`${J}.Loaded`) && c3.entered.includes(`${J}.Marker`), 'killed: loaded counts as entered');
  const changed = compile(path.join(root, 'body'), { Loaded: 'class Loaded { static final int K = 4; static int z = init(); static int init() { return 3; } int body() { return 2; } }' });
  assert.notEqual(bytecodeDigest(c3.classes, changed.m, c3.entered), bytecodeDigest(c3.classes, base.m, c3.entered), 'the never-entered body now misses');
});

test('execution coverage: a JVM without the agent (or with a broken one) counts every class it loaded as entered', { skip }, async () => {
  const root = tmp();
  const base = compile(path.join(root, 'v0'));
  const cov = path.join(root, 'cov');
  fs.mkdirSync(cov, { recursive: true });
  const snap = snapshotStart(cov);
  // the class-load log only (an agent that failed in premain writes no .agent marker and no dump)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_TOOL_OPTIONS: `${javaLogOption(cov)} -javaagent:${helpers(MAIN).agentJar}=dir=${cov};jar=/nonexistent.jar;pkg=x` };
  const r = spawnSync(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', base.out, 'dev.larattalabs.fx.Main'], { env, input: 'phase1\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok1/, 'the JVM runs normally when the agent fails');
  assert.ok(fs.readdirSync(cov).some((f) => f.endsWith('.agent-error')));
  const c = collect(cov, snap, { exec: await requestDumps(cov, { timeoutMs: 500 }), readDump });
  assert.ok(c.entered.includes(`${J}.Loaded`), 'no dump: loaded counts as entered');
  assert.match(c.jvms[0].exec, /no dump/);
});
