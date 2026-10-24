// (speed set C) Work one gate run needs in several steps, parts or shards, done once. The runner gives every step $GATE_RUN_SHARED, a
// directory under the run's own dir (shared by all its shards, new for every run, so nothing is ever reused across runs or heads);
// without it (by hand, a named chain's old runner) the work is only memoised in this process.
//
//   const v = await sharedOnce('rs-twin', key, async () => value);   // value: JSON, built by the first process to ask
//
// The first caller takes `<dir>/<key>.lock` (mkdir, atomic), builds, publishes `<dir>/<key>.json` by rename and drops the lock; the
// others wait for the file. A builder that throws drops its lock without publishing, and a waiter then builds for itself (a failure
// of one part never fails another). A lock whose pid is dead is taken over. After `waitMs` a waiter builds for itself, unpublished.
// `onHit(value)` runs for a value another process built (the caller may check that the files it names are still there; return false
// to build instead).
import fs from 'node:fs';
import path from 'node:path';

const memo = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export const sharedRoot = () => process.env.GATE_RUN_SHARED || null;

export async function sharedOnce(ns, key, build, { waitMs = 50 * 60_000, pollMs = 2000, onHit = null, log = () => {} } = {}) {
  const mk = `${ns}/${key}`;
  if (memo.has(mk)) return memo.get(mk);
  const p = (async () => {
    const root = sharedRoot();
    if (!root) return { ...(await build()), shared: 'built' };
    const dir = path.join(root, ns);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}.json`);
    const lock = path.join(dir, `${key}.lock`);
    const read = () => {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return onHit && onHit(v) === false ? null : v;
      } catch { return null; }
    };
    const end = Date.now() + waitMs;
    let announced = false;
    for (;;) {
      const hit = read();
      if (hit) { log(`  ${ns}: ${key.slice(0, 10)} built by another process of this run: reused`); return { ...hit, shared: 'reused' }; }
      let mine = false;
      try { fs.mkdirSync(lock); mine = true; } catch { /* held */ }
      if (mine) {
        fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
        try {
          const v = await build();
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(v));
          fs.renameSync(tmp, file);
          return { ...v, shared: 'built' };
        } finally {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      }
      let holder = 0;
      try { holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* just taken: no pid yet */ }
      if (holder && !alive(holder)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > end) { log(`  ${ns}: ${key.slice(0, 10)} still not built after ${Math.round(waitMs / 60_000)} min: built here, not shared`); return { ...(await build()), shared: 'built' }; }
      if (!announced) { announced = true; log(`  ${ns}: ${key.slice(0, 10)} is being built by pid ${holder || '?'}: waiting for it`); }
      await sleep(pollMs);
    }
  })();
  memo.set(mk, p);
  p.catch(() => memo.delete(mk));
  return p;
}
