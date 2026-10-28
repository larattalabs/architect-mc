// (7a GJ) The kit/Java parity fixture (not a test file itself): wall IRs (a C38 ring round the D3 town, its gate open, a double door, a
// fence gate and 1 wide; the gate nodes and the wall parts kept) with the kit's besideGates of each, and a district joined through a
// gate with its districtLand. The kit's test (gj.test.mjs) keeps it equal to the kit; the mod's GateJoinTest compares Java to it.
//   node kit/test/gj-parity.mjs --write     re-cut kit/test/fixtures/gj/parity.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { besideGates } from '../lib/region/beside.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { planBesideWalled, walledTown } from './gj-helpers.mjs';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gj', 'parity.json');

/** The rings of the fixture: [name, gate parts]. */
export const RINGS = [
  ['open', []],
  ['door', [{ id: 'gd', kind: 'gate', wall: 'ring', door: 'door', at: { anchor: 'e' } }]],
  ['fence', [{ id: 'gf', kind: 'gate', wall: 'ring', door: 'fence_gate', width: 3, at: { anchor: 'e' } }]],
  ['narrow', [{ id: 'g1', kind: 'gate', wall: 'ring', width: 1, at: { anchor: 'e' } }]],
];

/** An IR trimmed to what besideGates reads: its gate nodes and its wall parts. */
export const trimWall = (ir) => ({ graph: { nodes: (ir.graph?.nodes ?? []).filter((n) => n.kind === 'gate'), edges: [] }, parts: (ir.parts ?? []).filter((p) => p.id.startsWith('w_')) });

/** The fixture's inputs and the kit's outputs, from scratch. */
export async function build() {
  const walls = [];
  let open = null;
  for (const [name, gates] of RINGS) {
    const W = await walledTown({ gates });
    if (name === 'open') open = W;
    const ir = trimWall(W.ringIr);
    walls.push({ name, id: 'rgW', ir, gates: besideGates('rgW', ir) });
  }
  const q = await planBesideWalled({ W: open });
  const districts = [{ name: 'gate', ir: q.ir, townClaim: open.A, land: districtLand(q.ir, open.A), landRemoved: districtLand(q.ir, open.A, { standingRemoved: 1234567 }) }];
  return { walls, districts };
}

if (process.argv.includes('--write')) {
  const f = await build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${FIXTURE} (${fs.statSync(FIXTURE).size} bytes)`);
}
