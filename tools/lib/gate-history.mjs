// Step-duration history for tools/gate-run.mjs (docs/GATES.md "Scheduling and timeouts"): built from past runs' summary.json files
// (<artifacts>/<out dir>/<stamp>-<chain>/summary.json), kept as a small JSON file next to them. The runner uses it for the
// longest-first schedule, --plan's estimate and the history timeouts. Several runners share the artifacts dir, so the file is
// written atomically (tmp + rename) and a missing or corrupt one is simply rebuilt.

import fs from 'node:fs';
import path from 'node:path';

const KEEP = 30; // newest samples kept per step

/** Nearest-rank percentile of a sorted array. */
export function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Scans <artifactsRoot>/<dir>/<run>/summary.json. A sample is a step that ended PASS or FAIL (a TIMEOUT is cut off at its limit,
 * an ERROR or SKIPPED never ran, NOISY is a bench on a loaded box): its seconds minus its setupSeconds (the client start; the
 * timeout wraps only the step's own process). -> { builtAt, runs, steps: { id: { n, p50, p90, max, samples: [{ at, s, contended? }] } } }
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
        (per[s.id] ??= []).push({ at: s.startedAt ?? sm.startedAt ?? '', s: Math.round(sec), ...(s.contended ? { contended: true } : {}) });
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
  if (!h || h.n < minSamples) return { min: step.timeoutMin, source: `configured (history: ${h?.n ?? 0} sample(s), needs ${minSamples})` };
  const f = contendedBench && !h.samples.some((x) => x.contended) ? factor * 1.5 : factor;
  const m = Math.max((f * h.p90) / 60, floorMin);
  if (m >= step.timeoutMin) return { min: step.timeoutMin, source: `configured (history ${f}x p90 ${(h.p90 / 60).toFixed(1)} min is not less)` };
  return { min: Math.ceil(m), source: `history: max(${f}x p90 ${(h.p90 / 60).toFixed(1)} min of ${h.n}, ${floorMin} min floor), cap ${step.timeoutMin}` };
}
