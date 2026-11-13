#!/usr/bin/env node
// (7b DM, docs/CONTRACT.md "Slice DM as built") Re-score recorded S5/S6 scenario runs' disturbance under the current rule
// (tools/lib/scenario-sb.mjs DISTURBANCE_RULE), $0 and offline, from each run dir's own evidence: raw/plan/ir.json, raw/before.arwd.gz,
// raw/after.arwd.gz and the recorded sb-metrics.json. The raw cut is recomputed and checked against the record; fill is the record's (the
// library entries are not evidence, and the rule never touches fill).
//   node tools/sb-rescore.mjs <scenario run dir>... [--json out.json]
// Exits 1 when a lot's recomputed raw cut differs from its record (the dumps and the record disagree: no new number is reported for it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rescoreDisturbance } from './lib/scenario-sb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
if (!args.length) { console.error('usage: node tools/sb-rescore.mjs <scenario run dir>... [--json out.json]'); process.exit(2); }
const { decodeArwd } = await import(path.join(root, 'kit/lib/region/vworld.mjs'));
const out = [];
let bad = false;
for (const dir of args) {
  const read = (f) => fs.readFileSync(path.join(dir, f));
  const ir = JSON.parse(read('raw/plan/ir.json'));
  const recorded = JSON.parse(read('sb-metrics.json')).disturbance;
  const r = await rescoreDisturbance({ ir, before: await decodeArwd(read('raw/before.arwd.gz')), after: await decodeArwd(read('raw/after.arwd.gz')), recorded });
  out.push({ dir, ...r });
  console.log(`${dir}\n  rule ${r.lots[0]?.oldRule ?? '?'} -> ${r.rule}: worst ${r.oldWorst.toFixed(4)} -> ${r.newWorst.toFixed(4)}`);
  for (const p of r.lots) {
    if (p.mismatch) bad = true;
    console.log(`  ${p.lot.padEnd(10)} ${String(p.fit).padEnd(11)} ${p.old.toFixed(4)} -> ${p.mismatch ? 'MISMATCH' : p.disturbance.toFixed(4)}  cut ${p.cut} (interior ${p.cutInterior}, shell ${p.cutShell}, counted ${p.cutCounted}) fill ${p.fill} / ${p.volume}${p.mismatch ? ` recorded cut ${p.mismatch.cut}` : ''}`);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
process.exit(bad ? 1 : 0);
