#!/usr/bin/env node
// Remove leaked Architect temp dirs (slice TS; docs/GATES.md "Slice TS as built").
//
//   node tools/tmp-sweep.mjs [--dry-run] [--hours 6] [--no-marker-hours 24] [--json]
//
// Only direct children of os.tmpdir() and of the RAM disk's /Volumes/MCTmp/tmp named `arch-*`; never follows symlinks; skips a dir whose owner (.arch-owner) is a live
// process with the same start time. --dry-run lists what it would remove, with bytes. Always exits 0 (gate-run and the nightly call
// it at their start; a sweep never fails a run).

import { sweepAll, summaryAll, fmtBytes, DEFAULTS } from './lib/tmp-sweep.mjs';

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (k, d) => {
  const v = opt(k);
  if (v === undefined) return d;
  const n = Number(v);
  if (!(Number.isFinite(n) && n >= 0)) {
    console.error(`tmp-sweep: ${k} takes a number of hours`);
    process.exit(0);
  }
  return n;
};

const dryRun = argv.includes('--dry-run');
const r = sweepAll({ dryRun, hours: num('--hours', DEFAULTS.hours), noMarkerHours: num('--no-marker-hours', DEFAULTS.noMarkerHours) });
if (argv.includes('--json')) {
  console.log(JSON.stringify({ ...r, items: r.items.map(({ root, name, kind, action, reason, ageHours, bytes }) => ({ root, name, kind, action, reason, ageHours: Math.round(ageHours * 10) / 10, bytes })) }, null, 2));
} else {
  if (dryRun) for (const it of r.items.filter((i) => i.action === 'remove')) console.log(`  remove ${it.root === r.roots[0]?.root ? '' : 'RAM:'}${it.name} (${it.kind}, ${it.ageHours.toFixed(1)} h, ${fmtBytes(it.bytes ?? 0)}; ${it.reason})`);
  console.log(summaryAll(r));
}
