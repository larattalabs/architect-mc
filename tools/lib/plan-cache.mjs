// (gate waits, 2026-10-20) A content-keyed cache for the "unchanged against origin/main" items (gate6ch-core, gate6chy-core): each
// fixture is checked and planned by this checkout's kit and by main's, and the two answers and IRs compared. A side's result is a
// pure function of the kit and scenarios trees it runs (kit/test/plan-helpers.mjs reads nothing else), the fixture's plan and
// options, and Node's version, so it is stored under a key of exactly those. Main's side then runs once per main kit; this
// checkout's side too while its kit/ and scenarios/ equal a cached tree. A dirty kit/ or scenarios/ is never cached, and a miss runs
// the fixture exactly as before. Results are hashes: sha256 of the answers' JSON, of the IR (kitVersion masked), and the overall.
//
// Cache: <main checkout>/artifacts/plan-cache/<kit tree>-<scenarios tree>.json (untracked; deleting it only costs a re-run).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** `<kit tree>-<scenarios tree>` of `dir`'s HEAD when both are clean there, else null (never cached). */
export function treesOf(dir) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const st = git('status', '--porcelain', '--', 'kit', 'scenarios');
  const k = git('rev-parse', 'HEAD:kit');
  const s = git('rev-parse', 'HEAD:scenarios');
  if (st.status !== 0 || k.status !== 0 || s.status !== 0 || st.stdout.trim()) return null;
  return `${k.stdout.trim().slice(0, 16)}-${s.stdout.trim().slice(0, 16)}`;
}

const stores = new Map();
function store(root, trees) {
  const file = path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'plan-cache', `${trees}.json`);
  if (!stores.has(file)) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    stores.set(file, { file, data, dirty: false });
  }
  return stores.get(file);
}

/** Writes every store with new entries (atomically; a concurrent writer's entries are merged in). */
export function savePlanCache() {
  for (const s of stores.values()) {
    if (!s.dirty) continue;
    try {
      fs.mkdirSync(path.dirname(s.file), { recursive: true });
      let disk = {};
      try { disk = JSON.parse(fs.readFileSync(s.file, 'utf8')); } catch { /* none */ }
      const tmp = `${s.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...disk, ...s.data }));
      fs.renameSync(tmp, s.file);
      s.dirty = false;
    } catch { /* a cache: never fails a gate */ }
  }
}

/**
 * One side of the comparison, cached: `run()` -> the kit's check result ({res: {irJson}, check: {parts|malformed, overall}}).
 * `trees` from treesOf (null: run, don't cache); `input`: the plan and every option the run reads. -> {answers, ir, overall, cached}.
 */
export async function planSide(root, trees, input, run) {
  const key = trees ? sha256(JSON.stringify([process.version, process.env.ARCHITECT_BIG_REGIONS ?? null, input])) : null;
  const s = trees ? store(root, trees) : null;
  if (key && s.data[key]) return { ...s.data[key], cached: true };
  const r = await run();
  const v = {
    answers: sha256(JSON.stringify(r.check?.parts ?? r.check?.malformed ?? null)),
    ir: sha256((r.res?.irJson ?? '').replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"')),
    overall: r.check?.overall ?? null,
  };
  if (key) { s.data[key] = v; s.dirty = true; }
  return { ...v, cached: false };
}
