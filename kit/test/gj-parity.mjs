// (7a GJ) The kit/Java parity fixture (not a test file itself): wall IRs (a C38 ring round the D3 town, its gate open, a double door, a
// fence gate and 1 wide; the gate nodes and the wall parts kept) with the kit's besideGates of each, and a district joined through a
// gate with its districtLand. The kit's test (gj.test.mjs) keeps it equal to the kit; the mod's GateJoinTest compares Java to it.
//   node kit/test/gj-parity.mjs --write     re-cut kit/test/fixtures/gj/parity.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { besideData, besideGates } from '../lib/region/beside.mjs';
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

export const ENDPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan', 'valid', 'v7a_gj_endpoint.json');

/**
 * (§11) Plan fixture v7a_gj_endpoint: Steward's plan v1 shape (as v7x_d3_endpoint_reach) east of the walled D3 town: a street zone and a
 * road from it to the town by endpoint.region, which reaches its street through the C38 ring's gate; the reach inputs the mod sends
 * (the town's and the wall region's, flat terrain: the held columns carry the ring).
 */
export async function endpointFixture() {
  const W = await walledTown();
  const terrain = { W: 101, D: 81, x0: 112, z0: 13, y: 64 };
  const C = [terrain.x0, terrain.z0, terrain.x0 + terrain.W - 1, terrain.z0 + terrain.D - 1];
  const { survey: _t, ...town } = W.besideReach.rg1, { survey: _w, ...wall } = W.besideReach.rgW;
  void _t; void _w;
  const lotsV1 = [1, 2].map((i) => ({ id: `q${i}`, type: 'cottage', size: [9, 9], ext: { 'steward_mc:settlement': 's1', 'steward_mc:lot': `q${i}`, 'steward_mc:role': 'home' } }));
  return {
    about: '(7a GJ, §11) Steward\'s plan v1 shape beside a walled town (a C38 ring round it, one gate facing its east street end): a street zone (ew, rotate off, lot ext) and a road from it to the town by endpoint.region, which reaches the town\'s street through the ring\'s standing gate',
    terrain, anchors: { stone: [170, 65, 53] }, covers: ['endpoint.region'],
    standing: [besideData('rg1', W.A, W.town.p.ir, C)],
    besideReach: { rg1: { terrain: { W: 112, D: 112, x0: 0, z0: 0, y: 64 }, held: town.held, standing: town.standing }, rgW: { terrain: { W: W.C[2] - W.C[0] + 1, D: W.C[3] - W.C[1] + 1, x0: W.C[0], z0: W.C[1], y: 64 }, held: wall.held, standing: wall.standing, gates: wall.gates } },
    plan: { schemaVersion: 'plan/0', zones: [{ id: 'quarter', kind: 'standard', required: true, program: { lots: lotsV1, layout: 'street', orientation: 'ew' }, tolerance: { rotate: { allowed: false } }, where: { near: { anchor: 'stone', within: 16 } } }], connectors: [{ id: 'to_town', kind: 'road', from: { part: 'quarter' }, to: { region: 'rg1' } }] },
  };
}

if (process.argv.includes('--endpoint')) {
  fs.writeFileSync(ENDPOINT, `${JSON.stringify(await endpointFixture())}\n`);
  console.log(`wrote ${ENDPOINT} (${fs.statSync(ENDPOINT).size} bytes)`);
}

if (process.argv.includes('--write')) {
  const f = await build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${FIXTURE} (${fs.statSync(FIXTURE).size} bytes)`);
}
