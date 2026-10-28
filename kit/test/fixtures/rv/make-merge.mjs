// (6d RV) Writes kit/test/fixtures/rv/merge.json: a base IR, two revision IRs and the kit's effective IRs after each (mergeEffective), the
// parity fixture of the mod's Revisions.merge (RevisionsTest). rv-a.test.mjs checks the committed file is what this script writes.
//   node kit/test/fixtures/rv/make-merge.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../../../lib/region/plan.mjs';
import { columnsOf, worldOf } from '../../region-helpers.mjs';
import { mergeEffective, reviseIR, revisionStanding } from '../../../lib/region/revise.mjs';
import { canonicalJson, sha256Hex } from '../../../lib/region/pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..', '..', '..');

export async function makeMerge() {
  const world = worldOf({ flat: 64 });
  const claim = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const survey = columnsOf(world, 0, 0, 112, 112);
  const base = (await planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'house', size: [9, 9] }] }, survey, claim, seed: '1', node: 'golden', kitVersion: 'fixture' })).ir;
  const st = (eff) => revisionStanding({ id: 'rg1', claim: [0, 0, 111, 111], effective: eff });
  const r1 = (await reviseIR(base, { parts: [{ id: 'mound', call: { fn: 'columns', cols: [100, 100, 65, 66, 0, 101, 100, 65, 65, 0], materials: ['rock'] } }] }, { rid: 1, position: 1, parent: { rid: 0, irSha: 'base' }, base: { irSha: 'base' }, survey, standing: st(base), node: 'golden', kitVersion: 'fixture' })).ir;
  const e1 = mergeEffective(base, [{ rid: 1, position: 1, ir: r1, irSha: sha256Hex(canonicalJson(r1)) }]);
  const r3 = (await reviseIR(e1, { parts: [{ id: 'shed', call: { fn: 'lot', at: [96, 10], size: [7, 7] } }] }, { rid: 3, position: 2, parent: { rid: 1, irSha: 'r1' }, base: { irSha: 'base' }, survey, standing: st(e1), node: 'golden', kitVersion: 'fixture' })).ir;
  const e3 = mergeEffective(base, [{ rid: 1, position: 1, ir: r1, irSha: sha256Hex(canonicalJson(r1)) }, { rid: 3, position: 2, ir: r3, irSha: sha256Hex(canonicalJson(r3)) }]);
  return { base, revisions: [{ rid: 1, position: 1, irSha: sha256Hex(canonicalJson(r1)), ir: r1, effective: e1 }, { rid: 3, position: 2, irSha: sha256Hex(canonicalJson(r3)), ir: r3, effective: e3 }] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = `${JSON.stringify(await makeMerge())}\n`;
  const f = path.join(HERE, 'merge.json');
  if (process.argv.includes('--check')) { if (fs.readFileSync(f, 'utf8') !== out) { console.error('merge.json is stale'); process.exit(1); } }
  else fs.writeFileSync(f, out);
}
