#!/usr/bin/env node
// The step input map, tools/step-inputs.json (docs/GATES.md "Affected-only releases"; tools/lib/step-inputs.mjs).
//
//   node tools/step-inputs.mjs build              rebuild the static part (classes, closure, globs, flags) from tools/gate-chains.json
//                                                 and the tree at HEAD; keeps each step's traced data, derived and fingerprint globs
//   node tools/step-inputs.mjs merge <run dir>... widen the map with what those runs' traced steps read outside their sets
//                                                 (<run>/traces/<step>/, written by gate-run.mjs); prints every glob it adds
//   node tools/step-inputs.mjs check              CI: every step's static closure at HEAD (its imports, literal paths, dynamic
//                                                 imports widened) must be inside its recorded set, every step must have an entry,
//                                                 and the recorded static part must equal a rebuild; and (TI) every literal kit/ or
//                                                 scenarios/ path a mod test names must be a declared input of mod/build.gradle's
//                                                 `test` task. Exit 1 with the differences.
//   node tools/step-inputs.mjs show <step>        a step's set: classes, closure, globs, data, flags; and its file count at HEAD
//   node tools/step-inputs.mjs which <path>       the steps whose set holds a path

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentOf } from './lib/step-split.mjs';
import { buildStatic, checkTrace, inputMatcher, inputsHash, loadConf, loadMap, readTrace, saveMap, staticEntry, treeAt, widenFromTrace, workingFiles } from './lib/step-inputs.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'tools', 'gate-chains.json'), 'utf8'));
const conf = loadConf(SRC);
const KEEP = ['data', 'derived', 'fingerprint', 'notes', 'verified'];
const STATIC = ['classes', 'roots', 'closure', 'globs', 'env', 'flags'];

// (TI) The kit and scenario files the mod's Java tests read are inputs of mod/build.gradle's `test` task (8a ST, chore/TF, RTE3), so
// an edit to one never leaves the task UP-TO-DATE on a stale PASS. A literal path a test names (`"../kit/x"`, `"kit/x"`,
// `Path.of("..", "kit", "x", ...)`) must be under an `inputs.dir`/`inputs.files` of that block; a directory the test reads computed
// names in (`Path.of("../kit/examples", id)`) passes when the block declares it, or files under it (the ones the test reads, as
// RTE3's exact lists). Computed paths without a literal (KIT.resolve(id), a node child's own reads) stay the author's to declare.
// Known gaps not yet declared, each a leftover (remove the line when it is declared; empty since TI declared the last ones):
const GRADLE_TEST_UNDECLARED = [];
function gradleTestInputGaps(files) {
  const gradle = fs.readFileSync(path.join(SRC, 'mod', 'build.gradle'), 'utf8');
  const at = gradle.search(/^test \{/m);
  if (at < 0) return ['mod/build.gradle: no `test {` block'];
  let depth = 0;
  let end = at;
  for (let i = gradle.indexOf('{', at); i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    else if (gradle[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const declared = [];
  for (const m of gradle.slice(at, end).matchAll(/inputs\.(?:dir|files)\(([^)]*)\)/g)) for (const q of m[1].matchAll(/"\.\.\/([^"]+)"/g)) declared.push(q[1].replace(/\/$/, ''));
  const covered = (p) => declared.some((d) => p === d || p.startsWith(`${d}/`));
  const named = new Map();
  for (const f of files) {
    if (!f.startsWith('mod/src/test/java/') || !f.endsWith('.java')) continue;
    const text = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const found = [];
    for (const m of text.matchAll(/"(?:\.\.\/)?((?:kit|scenarios)\/[\w./-]*)"/g)) found.push(m[1]);
    for (const m of text.matchAll(/Paths?\.(?:of|get)\(\s*"\.\."((?:\s*,\s*"[\w.-]+")+)/g)) found.push([...m[1].matchAll(/"([\w.-]+)"/g)].map((x) => x[1]).join('/'));
    for (let p of found) {
      p = p.replace(/\/+$/, '');
      if (!/^(kit|scenarios)\//.test(p)) continue;
      const under = [...files].filter((t) => t.startsWith(`${p}/`));
      if (!files.has(p) && !under.length) continue; // not a repo path (a name in a message, a generated file)
      if (covered(p) || declared.some((d) => d.startsWith(`${p}/`)) || GRADLE_TEST_UNDECLARED.some((k) => p === k || p.startsWith(`${k}/`))) continue;
      if (!named.has(p)) named.set(p, new Set());
      named.get(p).add(path.basename(f, '.java'));
    }
  }
  return [...named].sort().map(([p, by]) => `mod/build.gradle: ${p} (read by ${[...by].join(', ')}) is no input of the test task: declare it there (and in unit-mod's data in tools/step-inputs.json)`);
}

function rebuilt(old) {
  const steps = buildStatic(cfg, conf, SRC);
  const map = { $comment: 'Generated by tools/step-inputs.mjs (build: the static part; merge: data from traced runs). Each step: classes (tools/gate-cache.json), roots, closure (its drivers\' module closure), globs (literal paths and unresolved dynamic imports, widened), env (the variables the closure reads), flags (releaseContext; originMain: modules that diff against origin/main), data (directories its traced runs read), derived/fingerprint (untracked inputs). dynamic lists the widened imports.', version: 1, steps: {} };
  for (const [id, e] of Object.entries(steps)) {
    map.steps[id] = { ...e };
    for (const k of KEEP) if (old?.steps?.[id]?.[k]?.length) map.steps[id][k] = old.steps[id][k];
  }
  return map;
}

if (cmd === 'build') {
  const old = loadMap(SRC);
  const map = rebuilt(old);
  saveMap(SRC, map);
  const n = Object.keys(map.steps).length;
  const dyn = Object.values(map.steps).reduce((a, e) => a + e.dynamic.length, 0);
  console.log(`step-inputs: ${n} steps written to tools/step-inputs.json (${dyn} computed imports left to the trace)`);
} else if (cmd === 'merge') {
  const map = loadMap(SRC);
  if (!map) throw new Error('no tools/step-inputs.json: run build first');
  let total = 0;
  for (const run of args) {
    const sm = JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'));
    const tracked = treeAt(SRC, sm.head ?? 'HEAD');
    for (const s of sm.steps) {
      const dir = path.join(run, 'traces', s.id);
      const tr = readTrace(dir);
      const mid = map.steps[s.id] ? s.id : parentOf(s.id); // a split step's part widens its parent's set
      if (!tr || !map.steps[mid]) continue;
      const added = widenFromTrace(map, conf, mid, tr, tracked);
      // a PASS whose trace now sits inside the set verifies it: the computed imports and data reads it made are recorded
      if (s.status === 'PASS') map.steps[mid].verified = `${path.basename(run)} ${s.id}`;
      if (added.length) {
        total += added.length;
        console.log(`${s.id} (${s.status}): + ${added.join(', ')}`);
      }
    }
  }
  saveMap(SRC, map);
  console.log(`step-inputs merge: ${total} glob(s) added`);
} else if (cmd === 'check') {
  const map = loadMap(SRC);
  const bad = [];
  if (!map) bad.push('no tools/step-inputs.json');
  else {
    const files = workingFiles(SRC);
    for (const [id, entry] of Object.entries(cfg.steps)) {
      const rec = map.steps[id];
      if (!rec) {
        bad.push(`${id}: no entry (run node tools/step-inputs.mjs build)`);
        continue;
      }
      const now = staticEntry(id, entry, conf, files, { src: SRC });
      const m = inputMatcher(map, conf, id);
      const missing = [...now.closure.filter((f) => !m(f)), ...now.globs.filter((g) => !(rec.globs ?? []).includes(g) && !(rec.data ?? []).includes(g))];
      if (missing.length) bad.push(`${id}: the closure now reaches ${missing.join(', ')}, outside its recorded set (run node tools/step-inputs.mjs build and commit)`);
      for (const k of ['classes', 'roots', 'env']) {
        const a = JSON.stringify(rec[k] ?? []);
        const b = JSON.stringify(now[k] ?? []);
        if (a !== b) bad.push(`${id}: recorded ${k} ${a} differ from a rebuild's ${b}`);
      }
      if (JSON.stringify(rec.flags ?? {}) !== JSON.stringify(now.flags ?? {})) bad.push(`${id}: recorded flags differ from a rebuild's`);
    }
    for (const id of Object.keys(map.steps)) if (!cfg.steps[id]) bad.push(`${id}: in the map but not in gate-chains.json`);
    bad.push(...gradleTestInputGaps(files));
  }
  if (bad.length) {
    console.error(`step-inputs check: ${bad.length} problem(s)\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`step-inputs check: ${Object.keys(cfg.steps).length} steps, every closure inside its recorded set`);
} else if (cmd === 'show') {
  const map = loadMap(SRC);
  const e = map?.steps?.[args[0]];
  if (!e) throw new Error(`no entry for ${args[0]}`);
  const h = inputsHash(map, conf, args[0], SRC, 'HEAD');
  console.log(JSON.stringify({ ...e, filesAtHead: h.files, hashAtHead: h.hash }, null, 1));
} else if (cmd === 'which') {
  const map = loadMap(SRC);
  const ids = Object.keys(map.steps).filter((id) => inputMatcher(map, conf, id)(args[0]));
  console.log(`${args[0]}: in ${ids.length} step set(s): ${ids.join(' ')}`);
} else if (cmd === 'trace') {
  // trace <run dir> <step>: the step's traced reads outside its set
  const map = loadMap(SRC);
  const sm = JSON.parse(fs.readFileSync(path.join(args[0], 'summary.json'), 'utf8'));
  const tr = readTrace(path.join(args[0], 'traces', args[1]));
  console.log(JSON.stringify(checkTrace(map, conf, map.steps[args[1]] ? args[1] : parentOf(args[1]), tr, { tracked: treeAt(SRC, sm.head) }), null, 1));
} else {
  console.error('usage: node tools/step-inputs.mjs build | merge <run dir>... | check | show <step> | which <path> | trace <run dir> <step>');
  process.exit(2);
}
