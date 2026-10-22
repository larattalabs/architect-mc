// The step tracer (docs/GATES.md "Affected-only releases"): a `--import` preload the runner puts in a step's NODE_OPTIONS. Every
// node process of the step (the driver, `node --test`, vitest, the node children it spawns with the step's environment) records
// the files of the source checkout it loads as a module, reads, lists or stats, one line per path:
//   <GATE_TRACE_DIR>/<pid>-<rand>.txt:  "# <argv>" then "<kind>\t<repo-relative path>"  (kind m = module, r = read, d = listing, s = stat/exists)
// The runner compares them with the step's input set (tools/step-inputs.json): a step that touched a source file outside its set
// is never cached and is reported as an inputs-map miss. Paths outside GATE_TRACE_ROOT (run worktrees, the seed, caches) are not
// recorded. Off unless GATE_TRACE_DIR and GATE_TRACE_ROOT are set; it never changes what the process does.

import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.env.GATE_TRACE_DIR;
const ROOT = process.env.GATE_TRACE_ROOT;

if (DIR && ROOT) {
  const roots = [...new Set([path.resolve(ROOT), (() => {
    try {
      return fs.realpathSync(ROOT);
    } catch {
      return path.resolve(ROOT);
    }
  })()])].map((r) => r + path.sep);
  const append = fs.appendFileSync;
  const mkdir = fs.mkdirSync;
  let file = null;
  const seen = new Set();
  const rel = (p) => {
    let abs;
    try {
      if (typeof p === 'number' || p == null) return null;
      if (p instanceof URL) {
        if (p.protocol !== 'file:') return null;
        abs = fileURLToPath(p);
      } else if (Buffer.isBuffer(p)) abs = path.resolve(p.toString());
      else if (typeof p === 'string') abs = p.startsWith('file:') ? fileURLToPath(p) : path.resolve(p);
      else return null;
    } catch {
      return null;
    }
    for (const r of roots) if (abs.startsWith(r)) return abs.slice(r.length).split(path.sep).join('/');
    return null;
  };
  const record = (kind, p) => {
    const r = rel(p);
    if (!r) return;
    const k = `${kind}\t${r}`;
    if (seen.has(k)) return;
    seen.add(k);
    try {
      if (!file) {
        mkdir(DIR, { recursive: true });
        file = path.join(DIR, `${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
        append(file, `# ${process.argv.slice(1).join(' ').slice(0, 400)}\n`);
      }
      append(file, `${k}\n`);
    } catch {
      // never fail the step for the trace
    }
  };

  // modules: every resolved file: URL (ESM and require), through the in-thread hooks
  try {
    module.registerHooks({
      resolve(specifier, context, next) {
        const r = next(specifier, context);
        if (r?.url?.startsWith('file:')) record('m', r.url);
        return r;
      },
    });
  } catch {
    // an old node without registerHooks: the reads below still record most of what matters
  }

  // file reads, listings and stats
  const wrap = (obj, name, kind, argIndex = 0) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__gateTrace) return;
    const f = function (...a) {
      record(kind, a[argIndex]);
      return orig.apply(this, a);
    };
    Object.defineProperty(f, '__gateTrace', { value: true });
    Object.defineProperty(f, 'name', { value: orig.name });
    for (const k of Object.keys(orig)) f[k] = orig[k]; // e.g. promisify.custom on fs.exists
    obj[name] = f;
  };
  for (const n of ['readFileSync', 'readFile', 'createReadStream', 'openSync', 'open', 'openAsBlob']) wrap(fs, n, 'r');
  for (const n of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, n, 'd');
  for (const n of ['existsSync', 'exists', 'statSync', 'stat', 'lstatSync', 'lstat', 'accessSync', 'access']) wrap(fs, n, 's');
  for (const n of ['cpSync', 'cp', 'copyFileSync', 'copyFile']) wrap(fs, n, 'r');
  const fp = fs.promises;
  for (const n of ['readFile', 'open']) wrap(fp, n, 'r');
  for (const n of ['readdir', 'opendir']) wrap(fp, n, 'd');
  for (const n of ['stat', 'lstat', 'access']) wrap(fp, n, 's');
  for (const n of ['cp', 'copyFile']) wrap(fp, n, 'r');
  try {
    module.syncBuiltinESMExports();
  } catch {
    // older node
  }
}
