#!/usr/bin/env node
// Execution coverage with JaCoCo (docs/GATES.md "Execution coverage (JaCoCo)"): gate and test tooling only, never in the mod.
//
//   node tools/lib/jacoco.mjs fetch     download the pinned JaCoCo jars from Maven Central into the shared vendor dir and check
//                                       their sha256 (approved by Noah, 2026-10-23); nothing is committed
//   node tools/lib/jacoco.mjs status    what is there, whether it verifies, and the compiled helpers
//
// The jars live in <main checkout>/artifacts/vendor/jacoco/<version>/ (untracked, shared by every worktree and the nightly's;
// GATE_JACOCO_DIR overrides). The two helpers (tools/lib/GateCovAgent.java, the per-JVM agent; tools/lib/GateCovTool.java, the
// class skeleton digests) are compiled on first use into <vendor>/helpers/<sources hash>/. A missing jar, a sha256 mismatch or a
// failed compile turns execution coverage off for the run (the class-load coverage stays): never a wrong key.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JACOCO = {
  version: '0.8.15',
  // the runtime agent's internal package: version-specific (its Premain-Class), pinned with the jar
  pkg: 'internal_bac9136',
  files: {
    agent: { name: 'org.jacoco.agent-0.8.15-runtime.jar', url: 'https://repo1.maven.org/maven2/org/jacoco/org.jacoco.agent/0.8.15/org.jacoco.agent-0.8.15-runtime.jar', sha256: 'fb5b0036a0899ea97edfa0fc2c7985b55f3f7c5695028163e5e60d4f3cf6075d' },
    cli: { name: 'org.jacoco.cli-0.8.15-nodeps.jar', url: 'https://repo1.maven.org/maven2/org/jacoco/org.jacoco.cli/0.8.15/org.jacoco.cli-0.8.15-nodeps.jar', sha256: 'd2b74b20b415163c1f53261e7c5ef4445b788327094208ff821e0c2baf9bc8f1' },
  },
  // what an execution-coverage key says it is (in the key: a change to the rule or the tool moves every such key)
  granularity: 'entered-class/jacoco-0.8.15/skel-v1',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** The vendor dir: GATE_JACOCO_DIR, else <main>/artifacts/vendor/jacoco/<version>. */
export function vendorDir(main, env = process.env) {
  return path.resolve(env.GATE_JACOCO_DIR ?? path.join(main, 'artifacts', 'vendor', 'jacoco', JACOCO.version));
}

const verified = new Map();
/** -> { ok, agentJar, cliJar, why }: both jars present with their pinned sha256. */
export function verify(main, env = process.env) {
  const dir = vendorDir(main, env);
  if (verified.has(dir)) return verified.get(dir);
  const out = { ok: true, dir, agentJar: path.join(dir, JACOCO.files.agent.name), cliJar: path.join(dir, JACOCO.files.cli.name) };
  for (const [k, f] of Object.entries(JACOCO.files)) {
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) {
      Object.assign(out, { ok: false, why: `${f.name} missing in ${dir} (node tools/lib/jacoco.mjs fetch)` });
      break;
    }
    const got = sha256(p);
    if (got !== f.sha256) {
      Object.assign(out, { ok: false, why: `${k} jar ${p}: sha256 ${got} is not the pinned ${f.sha256}` });
      break;
    }
  }
  verified.set(dir, out);
  return out;
}

/** Downloads the pinned jars (curl, Maven Central) and verifies them; a mismatch deletes the download. */
export function fetchJars(main, env = process.env) {
  const dir = vendorDir(main, env);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of Object.values(JACOCO.files)) {
    const p = path.join(dir, f.name);
    if (fs.existsSync(p) && sha256(p) === f.sha256) continue;
    const tmp = `${p}.${process.pid}.part`;
    const r = spawnSync('curl', ['-sSfL', '-o', tmp, f.url], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`download failed: ${f.url}`);
    const got = sha256(tmp);
    if (got !== f.sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`${f.name}: sha256 ${got} is not the pinned ${f.sha256}`);
    }
    fs.renameSync(tmp, p);
  }
  verified.delete(dir);
  return verify(main, env);
}

const javaBin = (env, tool) => path.join(env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', 'bin', tool);
const helperCache = new Map();
/**
 * The compiled helpers -> { ok, agentJar, toolCp, why }: the agent jar (Premain-Class GateCovAgent) and the skeleton tool's
 * classes, compiled once per hash of their sources and the JDK into <vendor>/helpers/<hash>/ (atomic: a racing compile loses).
 */
export function helpers(main, env = process.env, src = SRC) {
  const v = verify(main, env);
  if (!v.ok) return { ok: false, why: v.why };
  const agentSrc = path.join(src, 'tools', 'lib', 'GateCovAgent.java');
  const toolSrc = path.join(src, 'tools', 'lib', 'GateCovTool.java');
  const h = crypto.createHash('sha1');
  for (const f of [agentSrc, toolSrc]) h.update(fs.readFileSync(f));
  h.update(`${env.JAVA_HOME ?? ''}\n${JACOCO.version}\n`);
  const hash = h.digest('hex').slice(0, 16);
  const ck = `${v.dir}\0${hash}`;
  if (helperCache.has(ck)) return helperCache.get(ck);
  const out = path.join(v.dir, 'helpers', hash);
  const res = { ok: true, agentJar: path.join(out, 'gate-cov-agent.jar'), toolCp: `${path.join(out, 'tool')}${path.delimiter}${v.cliJar}`, cliJar: v.cliJar, runtimeJar: v.agentJar, hash };
  if (!fs.existsSync(path.join(out, 'ok'))) {
    const tmp = `${out}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'agent'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'tool'), { recursive: true });
    const run = (bin, args) => {
      const r = spawnSync(javaBin(env, bin), args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${bin} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout || r.error?.message || '').slice(0, 600)}`);
    };
    try {
      run('javac', ['-nowarn', '-d', path.join(tmp, 'agent'), agentSrc]);
      fs.writeFileSync(path.join(tmp, 'MANIFEST.MF'), 'Manifest-Version: 1.0\nPremain-Class: GateCovAgent\n');
      run('jar', ['--create', '--file', path.join(tmp, 'gate-cov-agent.jar'), '--manifest', path.join(tmp, 'MANIFEST.MF'), '-C', path.join(tmp, 'agent'), '.']);
      run('javac', ['-nowarn', '-cp', v.cliJar, '-d', path.join(tmp, 'tool'), toolSrc]);
      fs.writeFileSync(path.join(tmp, 'ok'), `${new Date().toISOString()}\n`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        fs.renameSync(tmp, out);
      } catch {
        fs.rmSync(tmp, { recursive: true, force: true }); // another process compiled it first
      }
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      const r = { ok: false, why: `compiling the coverage helpers: ${e.message}` };
      helperCache.set(ck, r);
      return r;
    }
  }
  helperCache.set(ck, res);
  return res;
}

/** The -javaagent option for a JVM whose coverage goes to `dir`, or null (with why) when execution coverage is unavailable. */
export function agentOption(main, dir, { env = process.env, includes = 'dev.larattalabs.*' } = {}) {
  const h = helpers(main, env);
  if (!h.ok) return { option: null, why: h.why };
  if (/[\s;]/.test(dir) || /\s/.test(h.agentJar) || /[\s;]/.test(h.runtimeJar)) return { option: null, why: 'a path holds whitespace or ";" (JAVA_TOOL_OPTIONS splits on whitespace)' };
  return { option: `-javaagent:${h.agentJar}=dir=${dir};jar=${h.runtimeJar};pkg=${JACOCO.pkg};includes=${includes}`, why: null };
}

/** The skeleton digests of every class under `roots` (class dirs) -> { fqn: sha1 } or null when the tool can't run. */
export function skeletons(main, roots, { env = process.env } = {}) {
  const h = helpers(main, env);
  if (!h.ok) return null;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-skel-')), 'skel.json');
  try {
    // a java child (not node) with no JAVA_TOOL_OPTIONS: the gate's agents never run inside the tool
    const r = spawnSync(javaBin(env, 'java'), ['-cp', h.toolCp, 'GateCovTool', 'skel', out, ...roots], { encoding: 'utf8', maxBuffer: 64 << 20, env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '' } });
    if (r.status !== 0) return null;
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    return null;
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** The JVMs with the agent in a coverage dir: [{ pid, alive }]. */
export function agentJvms(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((n) => /^jvm-(\d+)\.agent$/.exec(n)).filter(Boolean).map((m) => ({ pid: Number(m[1]), alive: alive(Number(m[1])) }));
}

/** A JVM's last dump: { token, at, entered: Set, uninstrumented: Set } or null. */
export function readDump(dir, pid) {
  let t;
  try {
    t = fs.readFileSync(path.join(dir, `jvm-${pid}.entered`), 'utf8');
  } catch {
    return null;
  }
  const out = { token: null, at: 0, entered: new Set(), uninstrumented: new Set() };
  for (const line of t.split('\n')) {
    if (line.startsWith('# token ')) out.token = line.slice(8).trim();
    else if (line.startsWith('# at ')) out.at = Number(line.slice(5));
    else if (line.startsWith('e ')) out.entered.add(line.slice(2).replaceAll('/', '.'));
    else if (line.startsWith('u ')) out.uninstrumented.add(line.slice(2).replaceAll('/', '.'));
  }
  return out;
}

/**
 * At a step's end: asks every live agent JVM of the coverage dir to dump (a new token in dump.req) and waits, bounded, until each
 * has written that token. -> { token, waited: [pids answered], missing: [pids that did not] }. A JVM that did not answer is
 * counted by its class-load log (collect).
 */
export async function requestDumps(dir, { timeoutMs = 15_000, pollMs = 100 } = {}) {
  const token = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(dir, `dump.req.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${token}\n`);
  fs.renameSync(tmp, path.join(dir, 'dump.req'));
  const t0 = Date.now();
  let pending = agentJvms(dir).filter((j) => j.alive).map((j) => j.pid);
  const answered = [];
  while (pending.length && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    pending = pending.filter((pid) => {
      const d = readDump(dir, pid);
      if (d && (d.token === token || d.token === 'exit')) {
        answered.push(pid);
        return false;
      }
      return alive(pid); // a JVM that died while we waited: collect decides by its exit dump
    });
  }
  return { token, answered, missing: pending };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = path.resolve(SRC, '..', 'architect-mc');
  const cmd = process.argv[2];
  if (cmd === 'fetch') {
    const v = fetchJars(main);
    console.log(v.ok ? `JaCoCo ${JACOCO.version}: verified in ${v.dir}` : `not verified: ${v.why}`);
    const h = helpers(main);
    console.log(h.ok ? `helpers compiled: ${h.agentJar}` : `helpers: ${h.why}`);
    process.exit(v.ok && h.ok ? 0 : 1);
  } else if (cmd === 'status') {
    const v = verify(main);
    console.log(v.ok ? `JaCoCo ${JACOCO.version}: verified in ${v.dir}` : `JaCoCo ${JACOCO.version}: ${v.why}`);
    if (v.ok) {
      const h = helpers(main);
      console.log(h.ok ? `helpers ${h.hash}: ${h.agentJar}` : `helpers: ${h.why}`);
    }
  } else {
    console.error('usage: node tools/lib/jacoco.mjs fetch|status');
    process.exit(2);
  }
}
