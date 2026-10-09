#!/usr/bin/env node
// FAKE kit/tools/region.mjs for the sidecar tests (the real one is kit/tools/region.mjs, kit/REGIONS.md):
//   plan <program.mjs> --params p.json --survey s.bin --seed n --claim minX,minZ,maxX,maxZ[,minY,maxY] [--bible b.json] --out dir [--json]
// The program's default export gets ctx and returns IR fields; this writes <out>/ir.json (canonical JSON) and
// prints {ok, irSha, notes}. A throw prints {ok: false, error} and exits 1; bad usage exits 2.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const [cmd, program, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) { console.error(`unexpected ${a}`); process.exit(2); }
  const n = rest[i + 1];
  if (n === undefined || n.startsWith('--')) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = n; i++; }
}
if (cmd !== 'plan' || !program || !flags.out || !flags.survey || !flags.claim) {
  console.error('usage: region.mjs plan <program> --params p.json --survey s.bin --seed n --claim ... --out dir');
  process.exit(2);
}
try {
  const params = flags.params ? JSON.parse(fs.readFileSync(flags.params, 'utf8')) : {};
  const survey = fs.readFileSync(flags.survey);
  if (survey.toString('latin1', 0, 4) !== 'ARSV') throw new Error('the survey is not an ARSV buffer');
  const c = String(flags.claim).split(',').map(Number);
  const claim = { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: c[4] ?? -64, maxY: c[5] ?? 319 };
  const bible = flags.bible ? JSON.parse(fs.readFileSync(flags.bible, 'utf8')) : { roles: {} };
  const mod = await import(pathToFileURL(path.resolve(program)).href);
  const ctx = { claim, survey: { bytes: survey.length }, bible, seed: flags.seed !== undefined ? String(flags.seed) : String(BigInt('0x' + crypto.createHash('sha256').update(path.basename(program) + JSON.stringify(params) + flags.claim).digest('hex').slice(0, 16))), params, kitVersion: 'fake' };
  const got = await mod.default(ctx);
  const ir = { format: 1, id: path.basename(program, '.mjs'), programSha: crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex'), kitVersion: 'fake', node: 'any', params, seed: ctx.seed, claim, roles: bible.roles ?? {}, stages: ['ground'], parts: [], lots: [], roads: [], paths: [], anchors: { entrance: [claim.minX, 64, claim.minZ], spawn: [claim.minX, 64, claim.minZ] }, rules: {}, budget: { cells: 100, removed: 50, added: 50 }, tiles: { ground: { terrain: ['0,0'], path: [] } }, ...got };
  const json = canonical(ir);
  fs.writeFileSync(path.join(flags.out, 'ir.json'), json);
  const irSha = crypto.createHash('sha256').update(json).digest('hex');
  console.log(JSON.stringify({ ok: true, irSha, notes: [`fake plan of ${ir.id}`, ...(got.notes ?? [])] }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `${e?.message ?? e}` }));
  process.exit(1);
}
