#!/usr/bin/env node
// (6c P0) Diff two plan capability catalogues (docs/CONTRACT.md P0 §4): added ids, reserved -> supported, retirements, schemaVersion
// bumps and `until` moves; ids are never removed (a removal exits 1). With --pending <file> ([{part?, block}], Steward's recorded
// unsupported answers, or a plan check's JSON), the pending parts the new catalogue now supports are listed to recheck.
//   node tools/plan-catalogue-diff.mjs <old.json> <new.json> [--pending f.json] [--json]
// A file may be a catalogue ({entries}), a plan check ({catalogue}) or kit/schemas/plan.json ({x-catalogue}).
import fs from 'node:fs';
import { diffCatalogues } from '../kit/lib/plan/catalogue.mjs';

function load(f) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(j.entries)) return j;
  if (j.catalogue?.entries) return j.catalogue;
  if (j['x-catalogue']?.entries) return { catalogueVersion: j['x-catalogue'].catalogueVersion, api: 'schema', ...j['x-catalogue'] };
  throw new Error(`${f}: no catalogue (entries, catalogue.entries or x-catalogue.entries)`);
}
function pendingOf(f) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.parts)) return j.parts.filter((p) => p.class === 'unsupported').map((p) => ({ part: p.part, block: p.block }));
  throw new Error(`${f}: pending is [{part?, block}] or a plan check ({parts})`);
}

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--pending');
if (files.length !== 2) { console.error('usage: plan-catalogue-diff.mjs <old.json> <new.json> [--pending f.json] [--json]'); process.exit(2); }
const pi = args.indexOf('--pending');
const d = diffCatalogues(load(files[0]), load(files[1]), { pending: pi >= 0 ? pendingOf(args[pi + 1]) : [] });
if (args.includes('--json')) console.log(JSON.stringify(d, null, 2));
else {
  console.log(`catalogue ${d.from.catalogueVersion} (API ${d.from.api}) -> ${d.to.catalogueVersion} (API ${d.to.api})`);
  const line = (t, xs) => console.log(`${t}: ${xs.length ? xs.join(', ') : 'none'}`);
  line('added', d.added.map((a) => `${a.id} (${a.state})`));
  line('reserved -> supported', d.reservedToSupported);
  line('retired', d.retired.map((r) => `${r.id}${r.replacedBy ? ` -> ${r.replacedBy}` : ''}`));
  line('schemaVersion bumps', d.schemaVersionBumps.map((b) => `${b.id} ${b.from} -> ${b.to}`));
  line('until moved', d.untilChanged.map((u) => `${u.id} ${u.from} -> ${u.to}`));
  line('other state changes', d.otherStateChanges.map((s) => `${s.id} ${s.from} -> ${s.to}`));
  line('REMOVED (never allowed)', d.removed);
  line('recheck (pending parts now supported)', d.recheck.map((p) => `${p.part ?? '?'} {${p.block}}`));
}
process.exit(d.removed.length ? 1 : 0);
