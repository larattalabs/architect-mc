// Coverage-based inputs for the in-game steps (docs/GATES.md "Coverage-based inputs"). The whole-tree classes (the jar, the
// sidecar's kit, the scenarios) made every mod/src/main or kit/lib change re-run every in-game step. In coverage mode a step's
// cached PASS is keyed by what that run actually touched:
//   - Java: every class a JVM of the step's shard loaded while the step ran, cumulative over a reused client (JAVA_TOOL_OPTIONS
//     -Xlog:class+load into <run>/coverage/<shard>/jvm-<pid>.log), mapped to its source file. Loaded is a superset of executed
//     (JaCoCo's class level), with no agent to install;
//   - Node: every file the step's own processes and the runner-started client's processes (the sidecar, its workers, the node
//     children that keep the environment) loaded, read, listed or statted (tools/lib/step-trace.mjs);
//   - the safety set, always in (tools/gate-cache.json coverage.always / alwaysRoots): build files and resources, mixins (applied
//     as bytes, never "loaded" under their name), registries, codecs and serialization, the entrypoints, the sidecar's own source
//     (one bundle), the kit tools the sidecar spawns without the tracer's environment, the region worker, the kit files in the jar;
//   - the step's static, non-class inputs (its drivers' closure, literal globs, traced data);
//   - and a compile-time constant changed anywhere in Java invalidates every coverage entry (javac inlines constants across classes).
// A changed file outside that set skips the step; a changed file a step touched re-runs it, which re-records its coverage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { globRe, matcher, moduleClosure } from './step-inputs.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 }).toString();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** The JVM option that logs every class load of a JVM to <dir>/jvm-<pid>.log. */
export const javaLogOption = (dir) => `-Xlog:class+load=info:file=${dir}/jvm-%p.log:uptime:filecount=0`; // no rotation: one file per JVM

/** The coverage files of a shard: jvm-<pid>.log and the client tracer's <pid>-<rand>.txt under node/. */
function coverageFiles(dir) {
  const out = [];
  const scan = (d, re) => {
    let names = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const m = re.exec(n);
      if (m) out.push({ file: path.join(d, n), pid: Number(m[1]) });
    }
  };
  scan(dir, /^jvm-(\d+)\.log$/);
  scan(path.join(dir, 'node'), /^(\d+)-\w+\.txt$/);
  return out;
}

/** At a step's start: the shard's coverage files whose process is alive (a reused client), and the time. */
export function snapshotStart(dir) {
  return { t: Date.now(), alive: new Set(coverageFiles(dir).filter((f) => alive(f.pid)).map((f) => f.file)) };
}

/** At its end: the classes and node paths of the files alive at its start or begun since. */
export function collect(dir, snap, { prefix = 'dev.larattalabs.' } = {}) {
  const classes = new Set();
  const node = new Map();
  for (const { file } of coverageFiles(dir)) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    // alive at the step's start (a reused client: everything it loaded before counts), or written since (begun during the step)
    if (!snap.alive.has(file) && st.mtimeMs < snap.t) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.log')) {
      for (const m of text.matchAll(/^\[[^\]]*\]\s+(\S+)\s+source:/gm)) if (m[1].startsWith(prefix)) classes.add(m[1]);
    } else {
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const [k, p] = line.split('\t');
        if (!p) continue;
        if (!node.has(p)) node.set(p, new Set());
        node.get(p).add(k);
      }
    }
  }
  return { classes: [...classes].sort(), node };
}

/** FQN of a top-level class -> its source file, over the tracked tree's Java roots. */
export function javaIndex(tree, roots) {
  const idx = new Map();
  for (const p of tree.keys()) {
    if (!p.endsWith('.java')) continue;
    const root = roots.find((r) => p.startsWith(`${r}/`));
    if (!root) continue;
    idx.set(p.slice(root.length + 1, -5).replaceAll('/', '.'), p);
  }
  return idx;
}

/** Loaded classes -> source files; a class with no source of its own (generated, a second top-level class) -> its package dirs. */
export function classesToFiles(classes, idx, roots) {
  const files = new Set();
  const globs = new Set();
  const unmapped = [];
  for (const c of classes) {
    const top = c.split('$')[0];
    const f = idx.get(top);
    if (f) {
      files.add(f);
      continue;
    }
    unmapped.push(c);
    const pkg = top.split('.').slice(0, -1).join('/');
    for (const r of roots) globs.add(`${r}/${pkg}/*.java`);
  }
  return { files, globs, unmapped };
}

/** The safety set's globs at a tree: the configured ones, the entrypoints of every fabric.mod.json, the closures of alwaysRoots. */
export function safetyGlobs(cov, tree, src, read) {
  const g = new Set(cov.always ?? []);
  const has = new Set(tree.keys());
  const idx = javaIndex(tree, cov.javaRoots ?? []);
  for (const p of has) {
    if (!/\/fabric\.mod\.json$/.test(p)) continue;
    let j;
    try {
      j = JSON.parse(read ? read(p) : fs.readFileSync(path.join(src, p), 'utf8'));
    } catch {
      continue;
    }
    for (const list of Object.values(j.entrypoints ?? {})) for (const e of list) {
      const cls = typeof e === 'string' ? e : e?.value;
      const f = cls && idx.get(String(cls).split('::')[0]);
      if (f) g.add(f);
    }
  }
  const cl = moduleClosure((cov.alwaysRoots ?? []).filter((r) => has.has(r)), has, { src, read });
  for (const f of cl.files) g.add(f);
  for (const x of cl.globs) g.add(x);
  return [...g].sort();
}

/**
 * The coverage set of one run of a step: sorted globs/paths. `entry`: its input-map entry; `trace`: its own trace (Map path ->
 * kinds); `cov`: collect()'s result for its shard; `conf`: tools/gate-cache.json; `tree`: the commit's tracked files.
 */
export function coverageSet({ entry, trace, cov, conf, tree, src, read }) {
  const c = conf.coverage ?? {};
  const set = new Set();
  // the static, non-class part: its drivers' module closure, the data its traced runs read, derived sources, fingerprinted data.
  // Not the map's literal-path globs (kit/lib/** for a literal 'kit/lib'): those guess at reads the trace now records exactly
  for (const x of [...(entry.closure ?? []), ...(entry.data ?? [])]) set.add(x);
  for (const d of entry.derived ?? []) for (const x of conf.derived?.[d] ?? []) set.add(x);
  for (const x of entry.fingerprint ?? []) set.add(x);
  // classes other than the ones coverage replaces; gradle only when the step really ran gradle in the source checkout
  const ranGradle = [...(trace?.keys() ?? [])].some((p) => p.startsWith('mod/.gradle/gate-gradle.lock'));
  for (const cls of entry.classes ?? []) {
    if ((c.replaces ?? ['jar', 'sidecar', 'world']).includes(cls)) continue;
    if (cls === 'gradle' && !ranGradle) continue;
    for (const x of conf.classes?.[cls] ?? []) set.add(x);
  }
  for (const x of safetyGlobs(c, tree, src, read)) set.add(x);
  // Java: the classes its JVMs loaded
  const roots = c.javaRoots ?? [];
  const j = classesToFiles(cov?.classes ?? [], javaIndex(tree, roots), roots);
  for (const x of j.files) set.add(x);
  for (const x of j.globs) set.add(x);
  // Node: what its processes and its client's touched (a listing or an absent path widens to the directory, as in the map)
  const has = new Set(tree.keys());
  const dirs = new Set();
  for (const f of has) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  for (const m of [trace, cov?.node]) {
    for (const [p, kinds] of m ?? []) {
      if (p.startsWith('@')) continue; // archived inputs: fingerprinted in the entry
      if (has.has(p)) set.add(p);
      else if (dirs.has(p)) set.add(`${p}/**`);
      else if (kinds.has('s') || kinds.has('r') || kinds.has('d')) set.add(p); // absent: its appearance must move the key
    }
  }
  return { set: [...set].sort(), unmappedClasses: j.unmapped, classes: (cov?.classes ?? []).length };
}

/** A matcher for a coverage set (exact paths and globs). */
export function setMatcher(set) {
  const exact = new Set(set.filter((x) => !/[*?]/.test(x)));
  const m = matcher(set.filter((x) => /[*?]/.test(x)));
  return (p) => exact.has(p) || m(p);
}

const constCache = new Map();
const TYPES = '(?:byte|short|int|long|float|double|char|boolean|String|java\\.lang\\.String)';
/** The constant variables a Java source declares: name -> its initialiser, normalised. Comments and string-literal contents that
 * look like code are handled by stripping comments first; a declaration may span lines. Counted: any `final` field or local of a
 * primitive or String type with an initialiser (a constant variable when the initialiser is constant: javac inlines it), and in an
 * interface or annotation, every field of those types (implicitly static final). */
export function constantDecls(text) {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const out = new Map();
  const add = (name, expr) => out.set(name, `${out.has(name) ? `${out.get(name)}|` : ''}${expr.replace(/\s+/g, ' ').trim()}`);
  // `final` anywhere among the modifiers, then the type, then one or more declarators up to the semicolon
  const re = new RegExp(`\\b((?:(?:public|protected|private|static|final|transient|volatile)\\s+)*)${TYPES}(\\s*\\[\\s*\\])?\\s+([^;(){}]+?);`, 'g');
  const iface = /\binterface\s+\w+|@interface\s+\w+/.test(t);
  for (const m of t.matchAll(re)) {
    const mods = m[1] ?? '';
    if (!/\bfinal\b/.test(mods) && !iface) continue;
    if (m[2]) continue; // arrays are never constant variables
    for (const d of m[3].split(/,(?![^(]*\))/)) {
      const eq = d.indexOf('=');
      if (eq < 0) continue;
      add(d.slice(0, eq).trim(), d.slice(eq + 1));
    }
  }
  return out;
}

/**
 * Java files whose constant variables differ between two commits (any declared, removed, or with another initialiser): javac
 * inlines constants into the classes that use them, which load without loading the declaring class. -> Set of paths, or null
 * when a commit is unknown here (the caller treats that as a change).
 */
export function constantChanges(src, from, to, roots) {
  const k = `${src}\0${from}..${to}`;
  if (constCache.has(k)) return constCache.get(k);
  let names;
  try {
    names = git(src, 'diff', '--name-only', from, to, '--', ...roots.map((r) => `${r}/**/*.java`)).split('\n').filter(Boolean);
  } catch {
    constCache.set(k, null);
    return null;
  }
  const show = (c, f) => {
    try {
      return git(src, 'show', `${c}:${f}`);
    } catch {
      return '';
    }
  };
  const out = new Set();
  for (const f of names) {
    const a = constantDecls(show(from, f));
    const b = constantDecls(show(to, f));
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const n of keys) if (a.get(n) !== b.get(n)) {
      out.add(f);
      break;
    }
  }
  constCache.set(k, out);
  return out;
}

export { globRe };
