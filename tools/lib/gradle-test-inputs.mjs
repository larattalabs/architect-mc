// (TI) The kit and scenario files the mod's Java tests read are inputs of mod/build.gradle's `test` task (8a ST, chore/TF, RTE3), so
// an edit to one never leaves the task UP-TO-DATE on a stale PASS. `node tools/step-inputs.mjs check` (CI) runs this over the tree.
//
// A path a test names must be declared in that block:
// - a literal path (`"../kit/x"`, `"kit/x"`, `Path.of("..", "kit", "x", ...)`, the literal head of the chain);
// - (TI2) a computed path: a Path constant or local (`KIT = Path.of("..", "kit")`) and its resolve chain up to the first computed
//   argument (`KIT.resolve("examples").resolve(id)` -> kit/examples), a concatenation's literal head (`"../kit/x/" + id`,
//   `kit.resolve("regions/" + p + ".mjs")`): its directory, as a directory;
// - (TI2) the module closure of every node script a test runs (a literal or computed .mjs path it names; tools/lib/step-inputs.mjs
//   moduleClosure: imports, JSON modules, literal paths and path.join tails, directory globs): each file and directory of it.
// A file is declared by `inputs.files` naming it, an `inputs.dir` holding it, or a `fileTree` holding it and not excluding it; a
// directory only by an `inputs.dir` of it or of a parent, or a fileTree that excludes nothing under it. Single files declared under a
// directory are not enough: the test may read any file there (v0.89.0 review P3).
// What stays the author's: a path with no literal anchor in the repo (a parameter passed whole), a node child's computed reads (the
// unit-mod trace shows them: `node tools/step-inputs.mjs test-trace <run dir>`), and reads outside the repo. No file access here.

import { globRe, moduleClosure } from './step-inputs.mjs';

/** Repo directories a mod test may read (mod/ itself is the task's own project). */
export const TEST_READ_TOPS = ['kit', 'scenarios', 'tools', 'sidecar', 'devserver', 'apitest', 'eval', 'docs'];
const TOPS_RE = TEST_READ_TOPS.join('|');

/** The `test { }` block's declared inputs: -> { dirs, files, trees: [{ dir, excludes }] } (repo paths; "../x" reads as "x"), or null. */
export function declaredTestInputs(gradle) {
  const at = gradle.search(/^test \{/m);
  if (at < 0) return null;
  let depth = 0;
  let end = gradle.length;
  for (let i = gradle.indexOf('{', at); i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    else if (gradle[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const out = { dirs: [], files: [], trees: [] };
  let block = gradle.slice(at, end);
  // fileTree("../x") { exclude "a", "b" }: a tree less its excludes (gradle patterns, relative to the tree)
  block = block.replace(/fileTree\(\s*"\.\.\/([^"]+)"\s*\)\s*\{([^{}]*)\}/g, (_, dir, body) => {
    const excludes = [];
    for (const ex of body.matchAll(/exclude\s*\(?([^\n)]*)/g)) for (const q of ex[1].matchAll(/"([^"]+)"/g)) excludes.push(q[1]);
    out.trees.push({ dir: dir.replace(/\/$/, ''), excludes });
    return '';
  });
  for (const m of block.matchAll(/inputs\.(dir|files)\(([^)]*)\)/g)) {
    for (const q of m[2].matchAll(/"\.\.\/([^"]+)"/g)) (m[1] === 'dir' ? out.dirs : out.files).push(q[1].replace(/\/$/, ''));
  }
  return out;
}

const stripComments = (java) => java.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The literal repo paths a Java source names (comments dropped). */
export function literalTestPaths(java) {
  const text = stripComments(java);
  const found = [];
  for (const m of text.matchAll(new RegExp(`"(?:\\.\\./)?((?:${TOPS_RE})/[\\w./-]*)"`, 'g'))) found.push(m[1]);
  for (const m of text.matchAll(/Paths?\.(?:of|get)\(\s*"\.\."((?:\s*,\s*"[\w.-]+")+)/g)) found.push([...m[1].matchAll(/"([\w.-]+)"/g)].map((x) => x[1]).join('/'));
  return found.map((p) => p.replace(/\/+$/, '')).filter((p) => new RegExp(`^(${TOPS_RE})/`).test(p));
}

// ------------------------------------------------------------------ (TI2) computed paths

const STR = /^"((?:[^"\\]|\\.)*)"$/;
/** The top-level arguments of the call whose `(` is at `open`: -> { args: [text], end } (end: the index after `)`). */
function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        args.push(text.slice(start, i).trim());
        return { args: args.filter((a, k) => a || k > 0), end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}
/** A string argument: -> { lit } for a literal, { head, tail } for a concatenation that starts with one, else null. */
function strArg(a) {
  const l = STR.exec(a);
  if (l) return { lit: l[1] };
  const parts = a.split(/\s*\+\s*/);
  const h = STR.exec(parts[0]);
  if (h && parts.length > 1) return { head: h[1], tail: STR.exec(parts.at(-1))?.[1] ?? '' };
  return null;
}
/** Appends a relative path to a value { segs, computed, out }; `..` past the repo root leaves it (out). */
function join(v, rel) {
  for (const s of rel.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (v.segs.length) v.segs.pop();
      else v.out = true;
    } else v.segs.push(s);
  }
}
/** Applies one path argument: a literal joins; a concatenation joins its literal head's directory and ends the chain (computed). */
function apply(v, a) {
  const s = strArg(a);
  if (s?.lit !== undefined) join(v, s.lit);
  else {
    if (s) join(v, s.head.slice(0, s.head.lastIndexOf('/') + 1));
    v.computed = true;
    v.suffix = s?.tail ?? '';
  }
}
const TRANSPARENT = new Set(['toAbsolutePath', 'normalize', 'toString', 'toUri', 'toFile', 'toRealPath', 'toPath']);
/**
 * The path an expression at `at` evaluates to: a Path.of/Paths.get call or a bound name, then its .resolve/.getParent chain.
 * The test task's working directory is mod/. -> { segs, computed, suffix, out, end } or null.
 */
function evalAt(text, at, lookup) {
  let v;
  let i;
  const call = /^(?:java\.nio\.file\.)?Paths?\.(?:of|get)\s*\(/.exec(text.slice(at, at + 40));
  if (call) {
    const c = callArgs(text, at + call[0].length - 1);
    if (!c) return null;
    v = { segs: ['mod'], computed: false, suffix: '', out: false };
    for (const a of c.args) {
      apply(v, a);
      if (v.computed) break;
    }
    i = c.end;
  } else {
    const name = /^\w+/.exec(text.slice(at))?.[0];
    const b = name && lookup(name, at);
    if (!b) return null;
    v = { ...b, segs: [...b.segs] };
    i = at + name.length;
  }
  for (;;) {
    const m = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(i, i + 60));
    if (!m) break;
    const c = callArgs(text, i + m[0].length - 1);
    if (!c) break;
    if (m[1] === 'resolve') {
      if (!v.computed) apply(v, c.args[0] ?? '');
    } else if (m[1] === 'getParent') {
      if (!v.computed) v.segs.pop();
    } else if (!TRANSPARENT.has(m[1])) break;
    i = c.end;
  }
  return { ...v, end: i };
}

/**
 * (TI2) Every repo path a Java source reads through a computed or bound path expression: -> [{ path, computed, suffix }]. A Path
 * binding (`Path KIT = Path.of("..", "kit")`, `var kit = ...`) holds until the next binding of that name.
 */
export function computedTestPaths(java) {
  const text = stripComments(java);
  const binds = [];
  const lookup = (name, at) => {
    let best = null;
    for (const b of binds) if (b.name === name && b.at < at) best = b;
    return best?.v ?? null;
  };
  for (const m of text.matchAll(/\b(?:java\.nio\.file\.Path|Path|var)\s+(\w+)\s*=\s*/g)) {
    const v = evalAt(text, m.index + m[0].length, lookup);
    binds.push({ name: m[1], at: m.index, v: v && !v.out ? v : null });
  }
  const names = [...new Set(binds.filter((b) => b.v).map((b) => b.name))];
  const starts = new RegExp(`(?:^|[^\\w.])((?:java\\.nio\\.file\\.)?Paths?\\.(?:of|get)\\s*\\(${names.length ? `|(?:${names.join('|')})\\b` : ''})`, 'g');
  const out = [];
  for (const m of text.matchAll(starts)) {
    const at = m.index + m[0].length - m[1].length;
    const v = evalAt(text, at, lookup);
    if (v && !v.out) out.push({ path: v.segs.join('/'), computed: v.computed, suffix: v.suffix });
  }
  // a concatenation outside a Path call: "../kit/x/" + id
  for (const m of text.matchAll(new RegExp(`"((?:\\.\\./)?(?:${TOPS_RE})/[^"]*)"\\s*\\+`, 'g'))) {
    const v = { segs: ['mod'], computed: false, suffix: '', out: false };
    apply(v, `"${m[1]}" + x`);
    out.push({ path: v.segs.join('/'), computed: true, suffix: '' });
  }
  const tops = new RegExp(`^(${TOPS_RE})(/|$)`);
  return out.filter((r) => tops.test(r.path));
}

/** -> { fileOk(p), dirOk(p) }: whether the declared inputs `decl` cover a tracked file, or a whole directory of `files`. */
export function coverOf(decl, files) {
  const under = (p, d) => p === d || p.startsWith(`${d}/`);
  const underDir = (p) => decl.dirs.some((d) => under(p, d));
  const trees = decl.trees.map((t) => ({ ...t, ex: t.excludes.map((g) => globRe(g)) }));
  const rel = (t, p) => p.slice(t.dir.length + 1);
  const inTree = (t, p) => under(p, t.dir) && !t.ex.some((r) => r.test(rel(t, p)) || r.test(`${rel(t, p)}/x`));
  const fileOk = (p) => decl.files.includes(p) || underDir(p) || trees.some((t) => inTree(t, p));
  const dirOk = (p) => underDir(p) || trees.some((t) => inTree(t, p) && [...files].every((f) => !under(f, p) || inTree(t, f)));
  return { fileOk, dirOk };
}

/**
 * The gaps: -> ["mod/build.gradle: <path> (read by A, B) ..."]. `gradle` is mod/build.gradle's text, `sources` [[repo path, text]] of
 * the Java tests, `files` the tree's paths (a Set), `known` paths (and their subtrees) accepted as undeclared; `read(p)` -> a tracked
 * file's text (for the node scripts' closures; without it they are not followed).
 */
export function gradleTestInputGaps(gradle, sources, files, known = [], { read } = {}) {
  const decl = declaredTestInputs(gradle);
  if (!decl) return ['mod/build.gradle: no `test {` block'];
  const under = (p, d) => p === d || p.startsWith(`${d}/`);
  const { fileOk, dirOk } = coverOf(decl, files);
  const isDir = (p) => [...files].some((t) => t.startsWith(`${p}/`));
  const gaps = new Map(); // path -> { by: Set, why }
  const add = (p, by, why) => {
    if (known.some((k) => under(p, k))) return;
    if (!gaps.has(p)) gaps.set(p, { by: new Set(), why });
    gaps.get(p).by.add(by);
  };
  const roots = new Map(); // node script -> Set(tests)
  for (const [f, text] of sources) {
    const by = f.split('/').pop().replace(/\.java$/, '');
    const reads = [...literalTestPaths(text).map((p) => ({ path: p, computed: false, suffix: '' })), ...computedTestPaths(text)];
    for (const r of reads) {
      const p = r.path;
      const file = !r.computed && files.has(p);
      const dir = !file && isDir(p);
      if (!file && !dir) continue; // not a repo path (a name in a message, a generated file)
      if (!r.computed && dir && !p.includes('/')) continue; // a top-level directory is a base for the paths built on it
      if (file && /\.(mjs|js)$/.test(p)) (roots.get(p) ?? roots.set(p, new Set()).get(p)).add(by);
      if (r.computed && /\.(mjs|js)$/.test(r.suffix)) for (const t of files) if (t.startsWith(`${p}/`) && t.endsWith(r.suffix.slice(r.suffix.lastIndexOf('.')))) (roots.get(t) ?? roots.set(t, new Set()).get(t)).add(by);
      if (file ? fileOk(p) : dirOk(p)) continue;
      add(p, by, file ? '' : r.computed ? ' (a computed name in a directory: declare it, or a parent, with inputs.dir)' : ' (a directory: declare it, or a parent, with inputs.dir)');
    }
  }
  if (read) {
    for (const [root, by] of [...roots].sort()) {
      const cl = moduleClosure([root], files, { read });
      for (const p of cl.files) if (!p.startsWith('mod/') && !fileOk(p)) for (const b of by) add(p, `${b}`, ` (in the closure of ${root})`);
      for (const g of cl.globs) {
        const d = g.replace(/\/\*\*$/, '');
        if (!d.startsWith('mod/') && !dirOk(d)) for (const b of by) add(d, `${b}`, ` (a directory in the closure of ${root}: declare it with inputs.dir)`);
      }
    }
  }
  return [...gaps].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, g]) => `mod/build.gradle: ${p} (read by ${[...g.by].join(', ')}) is no input of the test task${g.why}: declare it there (and in unit-mod's data in tools/step-inputs.json)`);
}

/**
 * (TI2) A unit-mod trace (tools/lib/step-trace.mjs: what the node children of the JVM tests read) against the test block: -> the
 * tracked repo paths read and not declared. `trace` is readTrace's Map(path -> kinds), `tracked` the commit's files.
 */
export function tracedTestInputGaps(gradle, trace, tracked) {
  const has = tracked instanceof Map ? new Set(tracked.keys()) : tracked;
  const decl = declaredTestInputs(gradle);
  if (!decl) return ['mod/build.gradle: no `test {` block'];
  const { fileOk } = coverOf(decl, has);
  const tops = new RegExp(`^(${TOPS_RE})/`);
  return [...trace.keys()].filter((p) => tops.test(p) && has.has(p) && !fileOk(p)).sort();
}
