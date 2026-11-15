// The temp sweep (slice TS, docs/GATES.md "Slice TS as built"): what tools/tmp-sweep.mjs removes, among the direct children of
// each root (os.tmpdir() and the RAM disk's tmp/, tools/lib/ram-tmp.mjs). It keys on the owner marker (.arch-owner, written by
// tools/lib/arch-tmp.mjs):
//   - a dir with a valid marker: kept while its owner is a live process with the same start time, else removed past `hours`;
//   - only with `unmarked: true` (tools/tmp-sweep.mjs --unmarked, by hand: the one-time cleanup of pre-TS dirs, after Noah's OK):
//     a dir without one, past `noMarkerHours`, ONLY when its name is a known Architect temp name (tools/tmp-prefixes.json: the
//     pre-TS prefixes plus mkdtemp's 6-character suffix), and a symlink with a known name (unlinked itself, never followed);
//   - by default (gate-run, the nightly) no unmarked dir or symlink is ever selected; any other unmarked name never is, and plain
//     files are never touched (other tools share $TMPDIR).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PREFIX, OWNER_FILE } from './arch-tmp.mjs';
import { RAM_TMP, ORIGINAL_TMPDIR, freeBytes, systemTmpDir } from './ram-tmp.mjs';

const PREFIX_FILE = new URL('../tmp-prefixes.json', import.meta.url);
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The known unmarked Architect temp names: (name) => boolean, from tools/tmp-prefixes.json (or a given { prefixes, patterns }). */
export function knownNames(spec = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'))) {
  const res = [...(spec.prefixes ?? []).map((p) => new RegExp(`^${escRe(p)}[A-Za-z0-9]{6}$`)), ...(spec.patterns ?? []).map((p) => new RegExp(p))];
  return (name) => res.some((re) => re.test(name));
}

export const DEFAULTS = { hours: 6, noMarkerHours: 24 };
/** A marker's start time (Node's timeOrigin) matches the live process's (ps, whole seconds, truncated) when the process started
 *  at most EARLY_MS after the marker's time and at most LATE_MS before it (Node's boot under load). A reused pid starts after
 *  the marker's process ended, so it never matches. */
export const START_EARLY_MS = 1_000;
export const START_LATE_MS = 60_000;
const HOUR = 3_600_000;

/** Every live process's start time (epoch ms), by pid, from one `ps` call. Empty on failure (then nothing counts as held by pid
 *  start, so a marker's pid that is alive by kill(0) is still treated as held: see isHeld). */
export function processStarts() {
  const out = new Map();
  try {
    const txt = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 << 20 });
    for (const line of txt.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const t = Date.parse(m[2]);
      if (Number.isFinite(t)) out.set(Number(m[1]), t);
    }
  } catch {
    // no ps: an empty map
  }
  return out;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Whether the owner {pid, startMs} is a live process (the same one: a reused pid has another start time). */
export function isHeld(owner, starts, alive = pidAlive) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  const t = starts.get(owner.pid);
  if (t === undefined) return starts.size ? false : alive(owner.pid); // ps unavailable: fall back to kill(0) (conservative)
  if (!Number.isFinite(owner.startMs)) return true; // alive, start unknown: conservative
  return t <= owner.startMs + START_EARLY_MS && owner.startMs <= t + START_LATE_MS;
}

/** The owner marker of dir, or null (a marker that is a symlink or unreadable doesn't count). */
export function readOwner(dir) {
  const f = path.join(dir, OWNER_FILE);
  try {
    if (!fs.lstatSync(f).isFile()) return null;
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return o && typeof o === 'object' && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
  } catch {
    return null;
  }
}

/** The newest mtime of the dir and its direct children (lstat; no descent). */
function lastTouched(dir, st) {
  let t = st.mtimeMs;
  try {
    for (const n of fs.readdirSync(dir)) {
      try {
        t = Math.max(t, fs.lstatSync(path.join(dir, n)).mtimeMs);
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // unreadable
  }
  return t;
}

/** Bytes under p (lstat walk; symlinks count as themselves, never followed). */
export function treeBytes(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const q = stack.pop();
    let st;
    try {
      st = fs.lstatSync(q);
    } catch {
      continue;
    }
    total += st.size;
    if (st.isDirectory()) {
      try {
        for (const n of fs.readdirSync(q)) stack.push(path.join(q, n));
      } catch {
        // unreadable
      }
    }
  }
  return total;
}

/**
 * What the sweep would do with each candidate child of root: [{ name, kind: 'dir'|'symlink', action: 'remove'|'keep', reason,
 * ageHours, owner }]. Names it never touches (unmarked and unknown) and plain files are not listed at all.
 */
export function selectSweep({ root = os.tmpdir(), hours = DEFAULTS.hours, noMarkerHours = DEFAULTS.noMarkerHours, now = Date.now(), starts = processStarts(), alive = pidAlive, unmarked = false, known = unmarked ? knownNames() : () => false } = {}) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const listed = known(name);
    const p = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      if (!unmarked || !listed) continue; // a symlink has no marker: only the --unmarked cleanup, and only a known name
      const ageHours = (now - st.mtimeMs) / HOUR;
      out.push({ name, kind: 'symlink', ageHours, owner: null, action: ageHours >= noMarkerHours ? 'remove' : 'keep', reason: ageHours >= noMarkerHours ? 'old symlink' : 'young symlink' });
      continue;
    }
    if (!st.isDirectory()) continue; // a plain file: never touched
    const owner = readOwner(p);
    if (!owner && !(unmarked && listed)) continue; // unmarked: only the --unmarked cleanup, and only a known Architect name
    const ageHours = (now - lastTouched(p, st)) / HOUR;
    if (owner && isHeld(owner, starts, alive)) {
      out.push({ name, kind: 'dir', ageHours, owner, action: 'keep', reason: `held by live pid ${owner.pid}` });
      continue;
    }
    const limit = owner ? hours : noMarkerHours;
    const old = ageHours >= limit;
    out.push({ name, kind: 'dir', ageHours, owner, action: old ? 'remove' : 'keep', reason: `${owner ? 'owner gone' : 'no marker'}, ${old ? '>=' : '<'} ${limit} h` });
  }
  return out;
}

/** Run the sweep: remove what selectSweep picks (unless dryRun). Never throws. Returns { removed, kept, bytes, failed, items }. */
export function sweep({ root = os.tmpdir(), dryRun = false, bytes = true, ...opts } = {}) {
  const res = { root, dryRun, removed: 0, kept: 0, bytes: 0, failed: 0, items: [] };
  let items;
  try {
    items = selectSweep({ root, ...opts });
  } catch (e) {
    res.error = String(e?.message ?? e);
    return res;
  }
  res.items = items;
  for (const it of items) {
    if (it.action !== 'remove') {
      res.kept++;
      continue;
    }
    const p = path.join(root, it.name);
    try {
      const st = fs.lstatSync(p); // again, just before acting: a dir swapped for a symlink is unlinked, not followed
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : null;
      if (!kind || kind !== it.kind) {
        res.kept++;
        continue;
      }
      it.bytes = bytes && kind === 'dir' ? treeBytes(p) : st.size;
      if (!dryRun) {
        if (kind === 'symlink') fs.unlinkSync(p);
        else fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      }
      res.removed++;
      res.bytes += it.bytes;
    } catch {
      res.failed++;
    }
  }
  return res;
}

export const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

/** The one-line summary. */
export const summaryLine = (r) =>
  `tmp-sweep${r.dryRun ? ' (dry run)' : ''}: ${r.dryRun ? 'would remove' : 'removed'} ${r.removed} temp entr${r.removed === 1 ? 'y' : 'ies'} (${fmtBytes(r.bytes)}), kept ${r.kept}${r.failed ? `, ${r.failed} failed` : ''}${r.error ? `, error: ${r.error}` : ''}`;

/** The roots swept: the process's own and the OS's temp dir, and the RAM disk's tmp/ when it exists (by real path, once each; never through a symlinked root). */
export function sweepRoots({ ram = RAM_TMP } = {}) {
  const out = [];
  for (const r of [ORIGINAL_TMPDIR, systemTmpDir(), os.tmpdir(), ram].filter(Boolean)) {
    try {
      const real = fs.realpathSync(r);
      if (fs.statSync(real).isDirectory() && !out.includes(real)) out.push(real);
    } catch {
      // absent
    }
  }
  return out;
}

/** sweep() on every root, summed: { removed, kept, bytes, failed, roots: [{ root, ...}], items }. */
export function sweepAll({ roots = sweepRoots(), ...opts } = {}) {
  const all = { dryRun: !!opts.dryRun, removed: 0, kept: 0, bytes: 0, failed: 0, roots: [], items: [] };
  for (const root of roots) {
    const r = sweep({ root, ...opts });
    for (const k of ['removed', 'kept', 'bytes', 'failed']) all[k] += r[k];
    if (r.error) all.error = r.error;
    all.roots.push({ root, removed: r.removed, kept: r.kept, bytes: r.bytes, failed: r.failed, free: freeBytes(root) });
    all.items.push(...r.items.map((i) => ({ ...i, root })));
  }
  return all;
}

/** The one-line summary of sweepAll, per root. */
export const summaryAll = (a) =>
  `tmp-sweep${a.dryRun ? ' (dry run)' : ''}: ${a.roots.map((r) => `${r.root === RAM_TMP ? 'RAM disk' : 'TMPDIR'} ${a.dryRun ? 'would remove' : 'removed'} ${r.removed} (${fmtBytes(r.bytes)}), kept ${r.kept}${r.failed ? `, ${r.failed} failed` : ''}${r.free !== null ? `, ${fmtBytes(r.free)} free` : ''}`).join('; ') || 'no roots'}${a.error ? `, error: ${a.error}` : ''}`;
