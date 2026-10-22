// Step input sets (docs/GATES.md "Affected-only releases"): for each gate step, the files whose content can change its result.
// A set is the union of
//   - classes (tools/gate-cache.json): the jar's inputs, the sidecar and the kit it runs, the scenarios, a gradle test tree; by the
//     step's client, its cwd and the modules in its closure;
//   - the module closure of its drivers (the tools/*.mjs|sh its command names, the test files its globs name), statically: import
//     and export specifiers, literal dynamic imports, `new URL('…', import.meta.url)`, literal repo paths and path.join(…) tails;
//     a computed import the scan can't resolve is left to the trace (below), which records every module a run loads;
//   - the data its traced runs read (tools/lib/step-trace.mjs), widened to the directory, merged by `tools/step-inputs.mjs merge`.
// The committed map is tools/step-inputs.json; `tools/step-inputs.mjs check` (CI) fails when a driver's closure gains a file
// outside its recorded set. The key of a set is a hash of its files' git blob ids at a commit: a clean tree only (step-cache.mjs).

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MAP_FILE = 'tools/step-inputs.json';
export const CONF_FILE = 'tools/gate-cache.json';
const TOP = ['tools', 'kit', 'scenarios', 'mod', 'sidecar', 'devserver', 'apitest', 'eval', 'docs'];

// ------------------------------------------------------------------ globs

const reCache = new Map();
/** `**` any depth (also none), `*` within a segment, `?` one char; anchored, repo-relative. */
export function globRe(g) {
  if (!reCache.has(g)) {
    let s = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          s += '(?:.*/)?';
          i += 2;
        } else {
          s += '.*';
          i += 1;
        }
      } else if (c === '*') s += '[^/]*';
      else if (c === '?') s += '[^/]';
      else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    reCache.set(g, new RegExp(`^${s}$`));
  }
  return reCache.get(g);
}
/** A matcher for a list of globs, `!glob` excluding: a path matches when a positive glob matches and no negative one does. */
export function matcher(globs) {
  const pos = globs.filter((g) => !g.startsWith('!')).map(globRe);
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  return (p) => pos.some((r) => r.test(p)) && !neg.some((r) => r.test(p));
}

// ------------------------------------------------------------------ git

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 }).toString();
const trees = new Map();
/** Every tracked file at a commit -> its blob id (cached per commit). */
export function treeAt(src, commit) {
  const sha = git(src, 'rev-parse', `${commit}^{commit}`).trim();
  if (!trees.has(sha)) {
    const m = new Map();
    for (const rec of git(src, 'ls-tree', '-r', '-z', '--full-tree', sha).split('\0')) {
      const t = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(rec);
      if (t) m.set(t[2], t[1]);
    }
    trees.set(sha, m);
  }
  return trees.get(sha);
}
/** The working tree's files (tracked and untracked, not ignored) as a Set: what `build` and `check` scan (a new driver counts before
 * it is committed). Keys never use this: they hash a commit's tree. */
export function workingFiles(src) {
  return new Set(git(src, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter((p) => p && fs.existsSync(path.join(src, p))));
}

/** Paths that differ from HEAD in the working tree (modified, staged, untracked and not ignored). */
export function dirtyPaths(src) {
  const out = git(src, 'status', '--porcelain', '-z', '--untracked-files=all');
  const paths = [];
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const st = r.slice(0, 2);
    paths.push(r.slice(3));
    if (st[0] === 'R' || st[0] === 'C') paths.push(recs[++i]); // the rename's source
  }
  return paths;
}

// ------------------------------------------------------------------ the static module closure

const IMPORT_RE = /(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?\sfrom\s*(['"])([^'"\n]+)\1|(?:^|[^\w.$])import\s*(['"])([^'"\n]+)\3|import\(\s*(['"])([^'"\n]+)\5\s*[,)]/gm;
const URL_RE = /new URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const LIT_PATH_RE = /(['"`])((?:tools|kit|scenarios|mod|sidecar|devserver|apitest|eval)\/[\w@./-]*[\w-])\1/g;
const JOIN_RE = /path\.(?:join|resolve)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const DYN_RE = /import\(\s*(?!['"])([^;\n]{0,160})/g;
const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;

/** The repo-relative file, or a directory glob, a literal path names; null when nothing tracked is there. */
function resolveRepoPath(rel, files, dirs) {
  const p = path.posix.normalize(rel).replace(/\/$/, '');
  if (p.startsWith('..') || p === '.') return null;
  if (files.has(p)) return { file: p };
  if (dirs.has(p)) return { glob: `${p}/**` };
  return null;
}

/**
 * The closure of `roots` (repo-relative files) over the tracked tree `files` (a Map path -> blob, or a Set): the files, the
 * directory globs literal paths name, the unresolved dynamic imports (each widened to a tree) and the env names read.
 * `read(p)` -> the file's text (default: from `src`'s working tree).
 */
export function moduleClosure(roots, files, { src, read } = {}) {
  const has = files instanceof Map ? new Set(files.keys()) : files;
  const dirs = new Set();
  for (const f of has) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  const readText = read ?? ((p) => fs.readFileSync(path.join(src, p), 'utf8'));
  const out = { files: new Set(), globs: new Set(), dynamic: [], env: new Set() };
  const stack = roots.filter((r) => has.has(r));
  for (const r of roots) if (!has.has(r)) out.dynamic.push({ from: '(root)', expr: r, widened: rootWiden(r, has) });
  while (stack.length) {
    const f = stack.pop();
    if (out.files.has(f)) continue;
    out.files.add(f);
    if (!/\.(mjs|js|cjs|sh|ts)$/.test(f)) continue;
    let text;
    try {
      text = readText(f);
    } catch {
      continue;
    }
    const dir = path.posix.dirname(f);
    const add = (rel, viaModule) => {
      const r = resolveRepoPath(rel, has, dirs);
      if (!r) return false;
      if (r.file) {
        if (viaModule || /\.(mjs|js|cjs)$/.test(r.file)) stack.push(r.file);
        else out.files.add(r.file);
      } else if (r.glob.split('/').length > 2) out.globs.add(r.glob);
      // a top-level directory (KIT = path.join(ROOT, 'kit')) is a base for computed paths, not an input: the trace has what it reads
      return true;
    };
    for (const m of text.matchAll(IMPORT_RE)) {
      const s = m[2] ?? m[4] ?? m[6];
      if (s?.startsWith('.')) add(path.posix.join(dir, s), true);
    }
    for (const m of text.matchAll(URL_RE)) if (m[2].startsWith('.')) add(path.posix.join(dir, m[2]), false);
    for (const m of text.matchAll(LIT_PATH_RE)) add(m[2], false);
    for (const m of text.matchAll(JOIN_RE)) {
      // the literal tail of a path.join/resolve: 'kit', 'lib', 'x.mjs' -> kit/lib/x.mjs; KIT, 'lib', 'x.mjs' -> kit/lib/x.mjs
      const args = m[1].split(',').map((a) => a.trim());
      const lits = [];
      for (let i = args.length - 1; i >= 0; i--) {
        const l = /^(['"])([^'"]*)\1$/.exec(args[i]);
        if (!l) break;
        lits.unshift(l[2]);
      }
      if (!lits.length) continue;
      const tail = lits.join('/');
      const lead = args.length > lits.length ? args[args.length - lits.length - 1] : '';
      const cands = [tail, /kit/i.test(lead) ? `kit/${tail}` : null, /\.\.|ROOT|root|SRC|MAIN|repo/.test(lead) ? tail : null, path.posix.join(dir, tail)].filter(Boolean);
      for (const c of cands) if (add(c, false)) break;
    }
    for (const m of text.matchAll(DYN_RE)) {
      const expr = m[1];
      if (/^pathToFileURL\(path\.(?:join|resolve)\(([^()]*)\)\)/.test(expr)) {
        const inner = /^pathToFileURL\(path\.(?:join|resolve)\(([^()]*)\)\)/.exec(expr)[1];
        if (inner.split(',').slice(1).every((a) => /^\s*(['"])[^'"]*\1\s*$/.test(a))) continue; // all literal after the base: JOIN_RE resolved it
      }
      // a computed import: the trace records what it loads (a PASS is cached only when its trace stays inside the set, so a
      // module it loads that the map lacks makes an inputs-map miss, never a stale PASS); listed here for review
      out.dynamic.push({ from: f, expr: expr.slice(0, 100) });
    }
    for (const m of text.matchAll(ENV_RE)) out.env.add(m[1] ?? m[2]);
  }
  return out;
}
function rootWiden(r, has) {
  // a root glob such as kit/test/*.test.mjs: the matching files are roots; nothing tracked matches -> widen to its directory
  return `${path.posix.dirname(r)}/**`;
}

/** The roots a chain entry runs: the tools/… and kit/… files its shell or cmd names, and the globs it passes to node (kit/test/*.test.mjs). */
export function stepRoots(entry) {
  const text = entry.shell ?? (entry.cmd ?? []).join(' ');
  const cwd = (entry.cwd ?? '').replace(/^(run|src):/, '');
  const roots = new Set();
  for (const m of text.matchAll(/(?:^|[\s'"=])((?:\.\/)?(?:tools|kit|scenarios|sidecar)\/[\w@./*-]+\.(?:mjs|js|sh|ts))/g)) roots.add(m[1].replace(/^\.\//, ''));
  if (cwd) for (const m of text.matchAll(/(?:^|[\s'"])((?:\.\/)?[\w-]+\/[\w@./*-]+\.(?:mjs|js))/g)) roots.add(path.posix.join(cwd, m[1].replace(/^\.\//, '')));
  return [...roots].sort();
}
const expandRoots = (roots, has) => {
  const out = [];
  for (const r of roots) {
    if (r.includes('*')) {
      const re = globRe(r);
      const hits = [...has].filter((p) => re.test(p));
      out.push(...(hits.length ? hits : [r]));
    } else out.push(r);
  }
  return [...new Set(out)].sort();
};

// ------------------------------------------------------------------ the map

/** The static part of one step's set: classes, roots, closure, globs, env names, and the flags its closure raises. */
export function staticEntry(id, entry, conf, files, opts) {
  const has = files instanceof Map ? new Set(files.keys()) : files;
  const roots = expandRoots(stepRoots(entry), has);
  const classes = new Set();
  const cr = conf.classRules ?? {};
  if (entry.client && entry.client !== 'none') for (const c of cr.client ?? []) classes.add(c);
  const cwd = entry.cwd ?? '';
  if (/^(run|src):mod/.test(cwd)) for (const c of cr.gradleCwd ?? []) classes.add(c);
  if (/^(run|src):sidecar/.test(cwd)) for (const c of cr.sidecarCwd ?? []) classes.add(c);
  const allRoots = [...roots];
  if (classes.has('jar')) allRoots.push(...(conf.classes.jarRoots ?? []));
  const cl = moduleClosure(allRoots, has, opts);
  for (const [mod, cs] of Object.entries(cr.closureModules ?? {})) if (cl.files.has(mod)) for (const c of cs) classes.add(c);
  // a closure module that spawns node with a fresh environment (env: { PATH: ... }, the plantime timings): that child runs
  // untraced (no NODE_OPTIONS), so the step gets the trees such a child can read
  const readMod = opts?.read ?? ((p) => fs.readFileSync(path.join(opts.src, p), 'utf8'));
  for (const f of cl.files) {
    if (!/\.mjs$/.test(f)) continue;
    let t = '';
    try {
      t = readMod(f);
    } catch {
      continue;
    }
    if (/env:\s*\{\s*PATH:\s*process\.env\.PATH/.test(t)) for (const c of cr.untracedNode ?? []) classes.add(c);
  }
  if (classes.has('jar') && !roots.some((r) => cl.files.has(r))) {
    // nothing to add: the jar roots were already in allRoots
  }
  const flags = {};
  if (cl.files.has('tools/release-context.mjs')) flags.releaseContext = true;
  // a closure module that diffs against origin/main or a merge base reads git objects outside HEAD's tree
  const readText = opts?.read ?? ((p) => fs.readFileSync(path.join(opts.src, p), 'utf8'));
  const runner = new Set(conf.runnerFiles ?? []);
  for (const f of cl.files) {
    if (!/\.mjs$/.test(f) || !f.startsWith('tools/') || runner.has(f)) continue;
    let t = '';
    try {
      t = readText(f);
    } catch {
      continue;
    }
    if (/origin\/main|merge-base/.test(t) && /\bgit\b/.test(t)) (flags.originMain ??= []).push(f);
    // the newest reachable v* tag (git describe --tags; release-version's lastTag) and the whole repo's file list (git ls-files)
    if (/['"]describe['"][^\n]*['"]--tags['"]|describe --tags/.test(t)) (flags.lastTag ??= []).push(f);
    if (/['"]ls-files['"]|git ls-files/.test(t)) (flags.repoListing ??= []).push(f);
  }
  for (const k of ['originMain', 'lastTag', 'repoListing']) if (flags[k]) flags[k].sort();
  // the Java test filters its source-checkout gradle runs can use (`--tests <pattern>`): every literal pattern in the modules that
  // run gradle tests; a run with no --tests at all, or one built from a template, makes them incomplete (the whole test tree counts)
  const testFilters = new Set();
  let filtersComplete = true;
  let runsTests = false;
  for (const f of cl.files) {
    if (!/\.mjs$/.test(f) || !f.startsWith('tools/') || runner.has(f)) continue;
    let t = '';
    try {
      t = readText(f);
    } catch {
      continue;
    }
    if (!/gradlew/.test(t) || !/['"]test['"]/.test(t)) continue;
    runsTests = true;
    if (!/--tests/.test(t)) filtersComplete = false;
    if (/--tests[^\n]*\$\{/.test(t)) filtersComplete = false;
    for (const m of t.matchAll(/(['"])([\w.$*]*Test[\w.$*]*)\1/g)) testFilters.add(m[2]);
  }
  if (!runsTests) filtersComplete = false;
  return {
    classes: [...classes].sort(),
    roots,
    closure: [...cl.files].sort(),
    globs: [...cl.globs].sort(),
    dynamic: cl.dynamic,
    env: [...cl.env].sort(),
    ...(Object.keys(flags).length ? { flags } : {}),
    ...(runsTests ? { testFilters: [...testFilters].sort(), testFiltersComplete: filtersComplete } : {}),
  };
}

/** The whole static map for a chain config at the working tree of `src` (tracked files only). */
export function buildStatic(cfg, conf, src, { read } = {}) {
  const files = workingFiles(src);
  const steps = {};
  for (const [id, entry] of Object.entries(cfg.steps)) steps[id] = staticEntry(id, entry, conf, files, { src, read });
  return steps;
}

/** The globs of a step's input set (classes expanded, closure files, globs, data). */
export function inputGlobs(map, conf, id) {
  const e = map.steps?.[id];
  if (!e) return null;
  const g = [];
  for (const c of e.classes ?? []) g.push(...(conf.classes[c] ?? []).filter((x) => !x.startsWith('!')));
  g.push(...(e.closure ?? []), ...(e.globs ?? []), ...(e.data ?? []));
  const neg = [];
  // a class's exclusions apply to that class's own globs only: keep them by re-including what other parts name
  return { pos: [...new Set(g)], classNeg: Object.fromEntries((e.classes ?? []).map((c) => [c, (conf.classes[c] ?? []).filter((x) => x.startsWith('!'))])), neg };
}

/** -> (path) => boolean: whether a repo path is in step `id`'s input set. */
export function inputMatcher(map, conf, id) {
  const e = map.steps?.[id];
  if (!e) return null;
  const parts = [];
  for (const c of e.classes ?? []) parts.push(matcher(conf.classes[c] ?? []));
  const rest = new Set([...(e.closure ?? [])]);
  const restG = matcher([...(e.globs ?? []), ...(e.data ?? [])]);
  return (p) => rest.has(p) || restG(p) || parts.some((m) => m(p));
}

/** The derived globs (untracked build outputs) a path falls under, with the tracked files they stand for. */
export function derivedOf(conf, p) {
  for (const [g, from] of Object.entries(conf.derived ?? {})) if (!g.startsWith('$') && globRe(g).test(p)) return { glob: g, from };
  return null;
}

/**
 * The hash of step `id`'s input set at a commit: sha1 over the sorted "path blob" lines of every tracked file in the set, the
 * derived globs' sources included. -> { hash, files: n }.
 */
export function inputsHash(map, conf, id, src, commit) {
  const tree = treeAt(src, commit);
  const m = inputMatcher(map, conf, id);
  if (!m) return null;
  const e = map.steps[id];
  const extra = matcher([...new Set((e.derived ?? []).flatMap((g) => conf.derived?.[g] ?? []))]);
  const h = crypto.createHash('sha1');
  let n = 0;
  for (const p of [...tree.keys()].sort()) {
    if (m(p) || extra(p)) {
      h.update(`${p}\0${tree.get(p)}\n`);
      n++;
    }
  }
  return { hash: h.digest('hex'), files: n };
}

/** The fingerprinted untracked inputs a step reads (conf.fingerprint), hashed by content from the working tree. */
export function fingerprintOf(map, conf, id, src) {
  const e = map.steps?.[id];
  const globs = (e?.fingerprint ?? []);
  if (!globs.length) return null;
  const m = matcher(globs);
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(src, d), { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = d ? `${d}/${x.name}` : x.name;
      if (x.isDirectory()) walk(p);
      else if (m(p)) h.update(`${p}\0`).update(fs.readFileSync(path.join(src, p))).update('\n');
    }
  };
  for (const g of globs) walk(g.replace(/\/?\*\*.*$/, '').replace(/\/[^/]*\*.*$/, ''));
  return h.digest('hex');
}

// ------------------------------------------------------------------ traces

/** Reads a step's trace dir: -> Map(path -> Set(kinds)). */
export function readTrace(dir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    return null;
  }
  for (const f of names) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [k, p] = line.split('\t');
      if (!p) continue;
      if (!out.has(p)) out.set(p, new Set());
      out.get(p).add(k);
    }
  }
  return out;
}

/** Paths a trace never needs in the set: the runner's and tracer's own files, caches keyed by content. */
const TRACE_IGNORE = [/^artifacts\//, /^\.git(\/|$)/, /^tools\/lib\/step-trace\.mjs$/, /^\.claude\//, /^scratchpad\//];

/**
 * Compares a step's trace with its set: -> { outside: [paths not in the set], derived: [derived globs touched], fingerprint:
 * [ignored local data touched], external: [artifacts/ files read], n }. A stat of a path that doesn't exist counts like a read of
 * it (its absence is an input). Run-time state (conf.state: the game dir, logs) is not an input.
 */
export function checkTrace(map, conf, id, trace, { tracked } = {}) {
  const m = inputMatcher(map, conf, id);
  const fp = matcher(conf.fingerprint?.globs ?? []);
  const state = matcher(conf.state?.globs ?? []);
  const extIgnore = matcher(conf.external?.ignore ?? []);
  const outside = [];
  const derived = new Set();
  const fpHit = new Set();
  const external = [];
  for (const [p, kinds] of trace) {
    if (p.startsWith('@artifacts/')) {
      const r = p.slice('@artifacts/'.length);
      if (r && !extIgnore(r) && !(kinds.size === 1 && kinds.has('d'))) external.push(r);
      continue;
    }
    if (TRACE_IGNORE.some((r) => r.test(p))) continue;
    if (m(p)) continue;
    if (state(p)) continue;
    const d = derivedOf(conf, p);
    if (d) {
      derived.add(d.glob);
      if ((map.steps[id].derived ?? []).includes(d.glob)) continue;
      outside.push(p);
      continue;
    }
    if (fp(p)) {
      const g = (conf.fingerprint.globs ?? []).find((x) => globRe(x).test(p));
      fpHit.add(g);
      if ((map.steps[id].fingerprint ?? []).includes(g)) continue;
      outside.push(p);
      continue;
    }
    // a directory the set covers by a glob (a listing of kit/regions when kit/regions/** is in): fine
    if (m(`${p}/x`) && (!tracked || !tracked.has(p))) continue;
    outside.push(p);
  }
  return { outside: outside.sort(), derived: [...derived].sort(), fingerprint: [...fpHit].sort(), external: external.sort(), n: trace.size };
}

/**
 * Widens a step's map entry with what its trace read outside the set: a file -> its directory (recursive), a listing -> the
 * listed directory; derived and fingerprinted paths -> their globs. -> the globs added.
 */
export function widenFromTrace(map, conf, id, trace, tracked) {
  const e = map.steps[id];
  const { outside, derived, fingerprint } = checkTrace(map, conf, id, trace, { tracked });
  const added = [];
  for (const g of derived) if (!(e.derived ??= []).includes(g)) {
    e.derived.push(g);
    added.push(`derived ${g}`);
  }
  for (const g of fingerprint) if (!(e.fingerprint ??= []).includes(g)) {
    e.fingerprint.push(g);
    added.push(`fingerprint ${g}`);
  }
  for (const p of outside) {
    if (derivedOf(conf, p)) continue;
    const kinds = trace.get(p);
    let g;
    if (!tracked.has(p) && [...tracked.keys()].some((t) => t.startsWith(`${p}/`))) g = `${p}/**`; // a directory
    else {
      const d = path.posix.dirname(p);
      g = d === '.' ? p : `${d}/**`;
    }
    if (g.split('/')[0] && TOP.includes(g.split('/')[0]) && g.split('/').length < 3 && g.endsWith('/**')) {
      // never widen to a whole top-level tree from one read (kit/** from kit/x.json): keep the file
      g = p;
    }
    void kinds;
    if (!(e.data ??= []).includes(g) && !matcher(e.data)(p)) {
      e.data.push(g);
      added.push(g);
    }
  }
  for (const k of ['data', 'derived', 'fingerprint']) if (e[k]) e[k].sort();
  return added;
}

// ------------------------------------------------------------------ load / save

export function loadConf(src) {
  return JSON.parse(fs.readFileSync(path.join(src, CONF_FILE), 'utf8'));
}
export function loadMap(src) {
  try {
    return JSON.parse(fs.readFileSync(path.join(src, MAP_FILE), 'utf8'));
  } catch {
    return null;
  }
}
export function saveMap(src, map) {
  const tmp = path.join(src, `${MAP_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(map, null, 1)}\n`);
  fs.renameSync(tmp, path.join(src, MAP_FILE));
}
