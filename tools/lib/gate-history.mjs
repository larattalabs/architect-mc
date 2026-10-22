// Step-duration history for tools/gate-run.mjs (docs/GATES.md "Scheduling and timeouts"): built from past runs' summary.json files
// (<artifacts>/<out dir>/<stamp>-<chain>/summary.json), kept as a small JSON file next to them. The runner uses it for the
// longest-first schedule, --plan's estimate and the history timeouts. Several runners share the artifacts dir, so the file is
// written atomically (tmp + rename) and a missing or corrupt one is simply rebuilt.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { entryOf } from './step-split.mjs'; // a split step's part (<id>/p<k>) has its own definition

const KEEP = 30; // newest samples kept per step

/** Nearest-rank percentile of a sorted array. */
export function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Scans <artifactsRoot>/<dir>/<run>/summary.json. A sample is a step that ended PASS or FAIL (a TIMEOUT is cut off at its limit,
 * an ERROR or SKIPPED never ran, NOISY is a bench on a loaded box): its seconds minus its setupSeconds (the client start; the
 * timeout wraps only the step's own process). -> { builtAt, runs, steps: { id: { n, p50, p90, max, samples: [{ at, s, head?, contended? }] } } }
 * (`head`: the run's source commit, which dates the step's definition; see currentHistory.)
 */
export function buildHistory(artifactsRoot) {
  const per = {};
  let runs = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(artifactsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(artifactsRoot, d.name));
  } catch {
    return { builtAt: new Date().toISOString(), runs: 0, steps: {} };
  }
  for (const d of dirs) {
    let subs = [];
    try {
      subs = fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(d, x.name, 'summary.json'));
    } catch {
      continue;
    }
    for (const f of subs) {
      let sm;
      try {
        sm = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue; // missing, or being rewritten by a live run
      }
      if (!Array.isArray(sm.steps)) continue;
      runs++;
      for (const s of sm.steps) {
        if (!['PASS', 'FAIL'].includes(s.status) || typeof s.seconds !== 'number') continue;
        const sec = Math.max(1, s.seconds - (s.setupSeconds ?? 0));
        (per[s.id] ??= []).push({ at: s.startedAt ?? sm.startedAt ?? '', s: Math.round(sec), ...(sm.head ? { head: sm.head } : {}), ...(s.contended ? { contended: true } : {}) });
      }
    }
  }
  const steps = {};
  for (const [id, arr] of Object.entries(per)) {
    arr.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const samples = arr.slice(0, KEEP);
    const v = samples.map((x) => x.s).sort((a, b) => a - b);
    steps[id] = { n: v.length, p50: pct(v, 50), p90: pct(v, 90), max: v[v.length - 1], samples };
  }
  return { builtAt: new Date().toISOString(), runs, steps };
}

/** Rebuilds the history from the artifacts and writes it atomically to `file`; on any write error the in-memory copy still serves. */
export function loadHistory(artifactsRoot, file) {
  const h = buildHistory(artifactsRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(h, null, 1)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // read-only or raced: the in-memory history is enough
  }
  return h;
}

/** Minutes a step is expected to take: its history p50, else the config's estMin, else a third of its timeout. */
export function estimateMin(step, hist) {
  const h = hist?.steps?.[step.id];
  if (h?.n) return { min: h.p50 / 60, source: `history p50 of ${h.n}` };
  if (step.estMin != null) return { min: step.estMin, source: 'estMin' };
  return { min: step.timeoutMin / 3, source: 'timeoutMin/3' };
}

/**
 * The step's effective timeout: max(factor x its history p90, floorMin), capped by the configured timeoutMin, once it has at least
 * minSamples samples; otherwise the configured timeoutMin. `factor` is larger for a bench step that runs next to others while its
 * history is still from isolated runs (no contended samples yet).
 */
export function effectiveTimeout(step, hist, { factor = 2, floorMin = 10, minSamples = 5, contendedBench = false } = {}) {
  const h = hist?.steps?.[step.id];
  const of = h?.dropped != null ? ` of its current definition (${h.dropped} older dropped)` : '';
  if (!h || h.n < minSamples) return { min: step.timeoutMin, source: `configured (history: ${h?.n ?? 0} sample(s)${of}, needs ${minSamples})` };
  const f = contendedBench && !h.samples.some((x) => x.contended) ? factor * 1.5 : factor;
  const m = Math.max((f * h.p90) / 60, floorMin);
  if (m >= step.timeoutMin) return { min: step.timeoutMin, source: `configured (history ${f}x p90 ${(h.p90 / 60).toFixed(1)} min is not less)` };
  return { min: Math.ceil(m), source: `history: max(${f}x p90 ${(h.p90 / 60).toFixed(1)} min of ${h.n}${h.dropped != null ? ' of its current definition' : ''}, ${floorMin} min floor), cap ${step.timeoutMin}` };
}

// ---- a step's definition: its history timeout counts only samples taken under it (PLAN "History timeouts for young steps")

/** The driver files a chain entry's shell runs: the `tools/...mjs|sh` paths it names, sorted. */
export function driverPaths(entry) {
  return [...new Set(String(entry?.shell ?? '').match(/\btools\/[\w./-]+\.(?:mjs|sh)\b/g) ?? [])].sort();
}

/** git's blob id of a file's bytes (what `git ls-tree` prints), so a working-tree file and a commit's file compare directly. */
export function blobId(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

/**
 * A step's definition hash: its chain entry (host, client, shell, env, resources, ...; not the fields that only describe or bound
 * it: desc, estMin, timeoutMin) and the blob ids of the driver files its shell names (`blobOf(path)` -> id, or null when absent).
 * A changed driver or entry is a new definition, whose timeout starts over from the configured one.
 */
export function stepDefinition(entry, blobOf) {
  if (!entry) return null;
  const { desc, estMin, timeoutMin, supersededBy, ...rest } = entry; // supersededBy only picks when the step runs
  const files = driverPaths(entry).map((p) => [p, blobOf(p) ?? null]);
  return crypto.createHash('sha1').update(JSON.stringify(canon({ entry: rest, files }))).digest('hex').slice(0, 16);
}

/** The current definition of a step from a checkout's working tree (the drivers run from there) and a parsed chain config. */
export function definitionNow(srcDir, chains, id) {
  return stepDefinition(entryOf(chains, id), (p) => {
    try {
      return blobId(fs.readFileSync(path.join(srcDir, p)));
    } catch {
      return null;
    }
  });
}

/**
 * A resolver of a step's definition at a past source commit, through git in `repoDir` (cached per commit and per chain-config blob):
 * (head, id) -> hash, or null when the commit is unknown here or the step wasn't in its chains.
 */
export function definitionsAt(repoDir, { chainsPath = 'tools/gate-chains.json' } = {}) {
  const trees = new Map();
  const configs = new Map();
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString();
  const treeOf = (head) => {
    if (!trees.has(head)) {
      let t = null;
      try {
        t = new Map();
        for (const line of git('ls-tree', '-r', head, '--', 'tools/').split('\n')) {
          const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
          if (m) t.set(m[2], m[1]);
        }
      } catch {
        t = null;
      }
      trees.set(head, t);
    }
    return trees.get(head);
  };
  const configOf = (blob) => {
    if (!configs.has(blob)) {
      let c = null;
      try {
        c = JSON.parse(git('cat-file', '-p', blob));
      } catch {
        c = null;
      }
      configs.set(blob, c);
    }
    return configs.get(blob);
  };
  return (head, id) => {
    if (!head) return null;
    const t = treeOf(head);
    const cb = t?.get(chainsPath);
    const c = cb ? configOf(cb) : null;
    return c ? stepDefinition(entryOf(c, id), (p) => t.get(p) ?? null) : null;
  };
}

/**
 * The history with `id`'s samples narrowed to those whose run's head had the step's current definition (`defAt(head, id) ===
 * current`); a sample with no head or an unknown one is dropped. The estimate keeps every sample; only the timeout reads this.
 */
export function currentHistory(id, hist, current, defAt) {
  const h = hist?.steps?.[id];
  if (!h || !current) return hist;
  const samples = h.samples.filter((x) => x.head && defAt(x.head, id) === current);
  const v = samples.map((x) => x.s).sort((a, b) => a - b);
  const mine = { n: v.length, p50: pct(v, 50), p90: pct(v, 90), max: v.length ? v[v.length - 1] : null, samples, dropped: h.samples.length - samples.length };
  return { ...hist, steps: { ...hist.steps, [id]: mine } };
}
