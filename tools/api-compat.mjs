#!/usr/bin/env node
// Binary compatibility of the public API (docs/CONTRACT.md "Phase 5a contract", "Java API (1.6.0)"): every method, constructor and
// field of dev.larattalabs.architect.api that a compiled jar references (its constant pool: Methodref, InterfaceMethodref,
// Fieldref) must still exist, with the same descriptor, in the mod's freshly compiled classes.
//
//   node tools/api-compat.mjs <old.jar> [classesDir]
//   node tools/api-compat.mjs --surface <old architect_mc.jar> [classesDir]
//                     every public or protected member of every class under dev/larattalabs/architect/api in the old MOD jar
//                     (its whole 1.x surface, not only what one jar calls) must still exist with the same descriptor.
//
//   node tools/api-compat.mjs --gate6c0a [--artifacts <dir>] [classesDir]
//                     phase 6c slice 0a: the unchanged 0.12.0, 0.11.0 and 0.10.0 apitest jars (API 1.9.0, 1.8.0, 1.7.0) and the 0.12.0
//                     mod jar's 1.9.0 surface (artifacts/gate6c0a/v0120/).
//
//   node tools/api-compat.mjs --gate6c0b [--artifacts <dir>] [classesDir]
//                     phase 6c slice 0b: the unchanged 0.13.0, 0.12.0 and 0.11.0 apitest jars (API 1.10.0, 1.9.0, 1.8.0) and the 0.13.0
//                     mod jar's 1.10.0 surface (artifacts/gate6c0b/v0130/, built from the v0.13.0 tag).
//
//   node tools/api-compat.mjs --gate6b [--artifacts <dir>] [classesDir]
//                     phase 6b (docs/CONTRACT.md "# Phase 6b contract" §6.1): the unchanged 1.8.0, 1.7.0 and 1.6.0 apitest jars by
//                     reference (artifacts/gate6b/v0110/architect_apitest-0.11.0.jar, gate6a/v0100/...-0.10.0.jar,
//                     gate5b/v090/...-0.9.0.jar) and the 0.11.0 mod jar's 1.8.0 surface (gate6b/v0110/architect_mc-0.11.0.jar).
//                     <dir> defaults to $ARCHITECT_ARTIFACTS, else ./artifacts, else ~/Developer/LarattaLabs/architect-mc/artifacts
//                     (the main checkout: artifacts/ is gitignored, so a worktree has none). Exit 1 when any check fails.
//
// classesDir defaults to mod/build/classes/java/{main,client} (run the mod's build first). JAVA_HOME's javap is used (else the PATH's).
// Also lists the old jar's switch maps over api enums (a $SwitchMap resolves constants by name, so inserted constants are safe
// for them; a pattern switch would show up as a MatchException reference). Exit 1 when a reference is missing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--gate6b' || process.argv[2] === '--gate6c0a' || process.argv[2] === '--gate6c0b') {
  const c0b = process.argv[2] === '--gate6c0b';
  const c0a = process.argv[2] === '--gate6c0a';
  const rest = process.argv.slice(3);
  let dir = process.env.ARCHITECT_ARTIFACTS;
  const ai = rest.indexOf('--artifacts');
  if (ai >= 0) {
    dir = rest[ai + 1];
    rest.splice(ai, 2);
  }
  if (!dir) {
    const local = path.join(root, 'artifacts');
    dir = fs.existsSync(path.join(local, c0a ? 'gate6c0a' : 'gate6b', c0a ? 'v0120' : 'v0110')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts');
  }
  // (6c 0a) the unchanged 0.12.0, 0.11.0 and 0.10.0 apitest jars (API 1.9.0, 1.8.0, 1.7.0) and the 0.12.0 mod jar's 1.9.0 surface
  const checks = c0b ? [
    ['1.10.0 apitest', [path.join(dir, 'gate6c0b', 'v0130', 'architect_apitest-0.13.0.jar')]],
    ['1.9.0 apitest', [path.join(dir, 'gate6c0a', 'v0120', 'architect_apitest-0.12.0.jar')]],
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.10.0 surface', ['--surface', path.join(dir, 'gate6c0b', 'v0130', 'architect_mc-0.13.0.jar')]],
  ] : c0a ? [
    ['1.9.0 apitest', [path.join(dir, 'gate6c0a', 'v0120', 'architect_apitest-0.12.0.jar')]],
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.7.0 apitest', [path.join(dir, 'gate6a', 'v0100', 'architect_apitest-0.10.0.jar')]],
    ['1.9.0 surface', ['--surface', path.join(dir, 'gate6c0a', 'v0120', 'architect_mc-0.12.0.jar')]],
  ] : [
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.7.0 apitest', [path.join(dir, 'gate6a', 'v0100', 'architect_apitest-0.10.0.jar')]],
    ['1.6.0 apitest', [path.join(dir, 'gate5b', 'v090', 'architect_apitest-0.9.0.jar')]],
    ['1.8.0 surface', ['--surface', path.join(dir, 'gate6b', 'v0110', 'architect_mc-0.11.0.jar')]],
  ];
  let failed = 0;
  for (const [name, a] of checks) {
    const jarPath = a[a.length - 1];
    if (!fs.existsSync(jarPath)) {
      console.log(`FAIL ${name}: ${jarPath} is missing`);
      failed++;
      continue;
    }
    try {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...a, ...rest], { encoding: 'utf8', maxBuffer: 64 << 20 });
      console.log(`ok   ${name}: ${out.trim().split('\n').pop()}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}:\n${(e.stdout || '') + (e.stderr || '')}`);
    }
  }
  console.log(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks clean`);
  process.exit(failed ? 1 : 0);
}
const surface = process.argv[2] === '--surface';
const args = surface ? process.argv.slice(3) : process.argv.slice(2);
const jar = args[0];
const classDirs = args[1] ? [path.resolve(args[1])] : ['main', 'client'].map((s) => path.join(root, 'mod', 'build', 'classes', 'java', s));
if (!jar) {
  console.error('usage: node tools/api-compat.mjs [--surface] <old.jar> [classesDir]');
  process.exit(2);
}
const javap = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javap') : 'javap';
const API = 'dev/larattalabs/architect/api/';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-compat-'));
execFileSync('unzip', ['-q', '-o', path.resolve(jar), '-d', tmp]);
const classFiles = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.class')) classFiles.push(p);
  }
};
walk(tmp);

// ---- 1. the references (or, with --surface, the old api's public and protected members)
const refs = new Map(); // "owner.name:desc" -> kind
let patternSwitch = false;
const switchMaps = new Set();
for (const f of surface ? [] : classFiles) {
  const out = execFileSync(javap, ['-v', '-p', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const line of out.split('\n')) {
    const m = /=\s+(Methodref|InterfaceMethodref|Fieldref)\s+#\d+\.#\d+\s+\/\/\s+(\S+)\.("?[^:"]+"?):(\S+)/.exec(line);
    if (m && m[2].startsWith(API)) refs.set(`${m[2]}.${m[3].replace(/"/g, '')}:${m[4]}`, m[1]);
    if (/java\/lang\/MatchException/.test(line)) patternSwitch = true;
    const sm = /\$SwitchMap\$(dev\$larattalabs\$architect\$api\$[A-Za-z0-9$]+)/.exec(line);
    if (sm) switchMaps.add(sm[1].replace(/\$/g, '.'));
  }
}

if (surface) {
  for (const f of classFiles) {
    const rel = path.relative(tmp, f).replace(/\\/g, '/');
    if (!rel.startsWith(API) || !rel.endsWith('.class')) continue;
    const cls = rel.slice(0, -'.class'.length);
    const out = execFileSync(javap, ['-protected', '-s', f], { encoding: 'utf8' }).split('\n');
    for (let i = 0; i < out.length; i++) {
      const d = /^\s+descriptor: (\S+)/.exec(out[i]);
      if (!d) continue;
      const sig = out[i - 1].trim().replace(/;$/, '');
      let name;
      if (sig.includes('(')) {
        const before = sig.slice(0, sig.indexOf('('));
        name = before.split(/\s+/).pop();
        name = sig === 'static {}' ? '<clinit>' : name === cls.replace(/\//g, '.') ? '<init>' : name.split('.').pop();
      } else name = sig.split(/\s+/).pop();
      if (name === '<clinit>') continue;
      refs.set(`${cls}.${name}:${d[1]}`, 'member');
    }
  }
}

// ---- 2. what the new classes declare (and inherit through their api supertypes)
const declared = new Map(); // class -> Set("name:desc")
const supers = new Map();
const load = (cls) => {
  if (declared.has(cls)) return declared.get(cls);
  const file = classDirs.map((d) => path.join(d, `${cls}.class`)).find((f) => fs.existsSync(f));
  const set = new Set();
  declared.set(cls, set);
  if (!file) return set;
  const out = execFileSync(javap, ['-p', '-s', file], { encoding: 'utf8' });
  const lines = out.split('\n');
  const head = lines.find((l) => /\b(class|interface|enum|record)\b/.test(l) && l.includes('{')) ?? '';
  const sup = [];
  for (const m of head.matchAll(/(?:extends|implements)\s+([\w.$<>, ]+?)(?=\s+(?:implements|\{))/g)) {
    for (const s of m[1].split(',')) sup.push(s.trim().replace(/<.*$/, '').replace(/\./g, '/'));
  }
  supers.set(cls, sup);
  for (let i = 0; i < lines.length; i++) {
    const d = /^\s+descriptor: (\S+)/.exec(lines[i]);
    if (!d) continue;
    const sig = lines[i - 1].trim().replace(/;$/, '');
    let name;
    if (sig.includes('(')) {
      const before = sig.slice(0, sig.indexOf('('));
      name = before.split(/\s+/).pop();
      if (sig === 'static {}') name = '<clinit>';
      else name = name === cls.replace(/\//g, '.') ? '<init>' : name.split('.').pop();
    } else {
      name = sig.split(/\s+/).pop();
    }
    set.add(`${name}:${d[1]}`);
  }
  return set;
};
// what java.lang.Enum / Object / Record give every api type
const INHERITED = new Set(['name:()Ljava/lang/String;', 'ordinal:()I', 'toString:()Ljava/lang/String;', 'hashCode:()I', 'equals:(Ljava/lang/Object;)Z',
  'getClass:()Ljava/lang/Class;']);
const has = (cls, member, seen = new Set()) => {
  if (seen.has(cls)) return false;
  seen.add(cls);
  if (load(cls).has(member)) return true;
  if (load(cls).size && INHERITED.has(member)) return true;
  return (supers.get(cls) ?? []).some((s) => s.startsWith(API) && has(s, member, seen));
};

const missing = [];
for (const [ref, kind] of [...refs].sort()) {
  const dot = ref.indexOf('.', API.length + 1) >= 0 ? ref.lastIndexOf('.', ref.indexOf(':')) : -1;
  const cls = ref.slice(0, dot);
  const member = ref.slice(dot + 1);
  // enum helpers and record methods the compiler made exist on the class too
  if (!has(cls, member)) missing.push(`${kind} ${cls.replace(/\//g, '.')}.${member}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(surface ? `${refs.size} public/protected api members of ${path.basename(jar)}, checked against ${classDirs.map((d) => path.relative(root, d)).join(' + ')}` : `${refs.size} api references in ${path.basename(jar)} (${classFiles.length} classes), checked against ${classDirs.map((d) => path.relative(root, d)).join(' + ')}`);
if (switchMaps.size) console.log(`switch maps over api enums (resolved by name, safe for inserted constants): ${[...switchMaps].sort().join(', ')}`);
console.log(patternSwitch ? 'WARN: a pattern switch (MatchException) exists in the jar: inserted enum constants may reach its default' : 'no pattern switches (MatchException) in the jar');
if (missing.length) {
  console.log(`MISSING ${missing.length}:`);
  for (const m of missing) console.log(`  ${m}`);
  process.exit(1);
}
console.log('every referenced api member exists with the same descriptor');
