// Report-only timing benches (docs/GATES.md "Speed rules" 9): a unit test still runs the work and checks its correctness; its timing
// is appended with the machine's load to artifacts/benches/<date>.jsonl (gitignored, local evidence) and, past its bound, printed as
// a FLAG line instead of failing. ARCHITECT_TIMING_BARS=1 (a dedicated box, as JournalIndexBenchTest and simcosts already read it)
// judges the bound: the call then throws past it. tools/nightly.mjs summarises the day's rows.
//
//   bench({ id: 'forms-island/cells-per-s', value: 123456, bound: 90000, better: 'higher', unit: 'cells/s' })

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCH_DIR = path.join(ROOT, 'artifacts', 'benches');

/** Within its bound? `better`: 'lower' (a time: value <= bound, the default) or 'higher' (a rate: value >= bound). */
export function withinBound(value, bound, better = 'lower') {
  return better === 'higher' ? value >= bound : value <= bound;
}

/**
 * Records one bench reading and returns the row. Never throws on a slow reading unless ARCHITECT_TIMING_BARS=1; a failed write is
 * reported on stderr, never a test failure. `dir` and `env` are for the tests.
 */
export function bench({ id, value, bound, better = 'lower', unit = 'ms', note }, { dir = BENCH_DIR, env = process.env, log = console.log } = {}) {
  const ok = withinBound(value, bound, better);
  const now = new Date();
  const row = { at: now.toISOString(), id, value: Math.round(value * 1000) / 1000, bound: Math.round(bound * 1000) / 1000, better, unit, ok, load1: Math.round(os.loadavg()[0] * 100) / 100, cpus: os.cpus().length, ...(note ? { note } : {}) };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`bench ${id}: not recorded (${e.message})`);
  }
  const text = `${id} ${row.value} ${unit} (bound ${better === 'higher' ? '>=' : '<='} ${row.bound}; 1-min load ${row.load1} on ${row.cpus} cores)`;
  if (ok) log(`# bench ${text}`);
  else {
    log(`FLAG bench ${text}: past its bound (report-only; ARCHITECT_TIMING_BARS=1 judges it)`);
    if (env.ARCHITECT_TIMING_BARS === '1') throw new Error(`bench ${text}: past its bound (ARCHITECT_TIMING_BARS=1)`);
  }
  return row;
}

/** The rows of the bench reports under `dirs` (each an artifacts/benches directory) at or after `since` (an ISO time). */
export function benchRows(dirs, since) {
  const rows = [];
  for (const d of dirs) {
    let names;
    try {
      names = fs.readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      if (since && n.slice(0, 10) < since.slice(0, 10)) continue;
      for (const l of fs.readFileSync(path.join(d, n), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
          const r = JSON.parse(l);
          if (!since || r.at >= since) rows.push(r);
        } catch {
          // a torn line from a killed run
        }
      }
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? -1 : 1));
}
