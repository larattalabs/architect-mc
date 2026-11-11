// (Slice PG) The kit/Java parity fixture for passage gates (not a test file itself): walled towns with a K3 gatehouse (alone, with a
// portcullis, with a swing, beside a K1 door gate), each IR trimmed to what besideGates and the standing's walls read (gate and passage
// nodes, the wall parts, the lots), with the kit's besideGates and besideStanding(...).walls of each. kit/test/pg.test.mjs keeps it equal to
// the kit; the mod's GateJoinTest compares Java to it.
//   node kit/test/pg-parity.mjs --write     re-cut kit/test/fixtures/gj/pg-parity.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { besideGates, besideStanding } from '../lib/region/beside.mjs';
import { encodeColumns } from '../lib/region/pack.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';
import { reachInputs } from './d3-helpers.mjs';
import { checkPlanLocal } from './plan-helpers.mjs';

const A = [0, 0, 159, 159];
const world = worldOf({ flat: 64 });
const LOTS = [{ id: 'gatehouse_1', type: 'gatehouse', size: [13, 11] }, { id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, ...Array.from({ length: 5 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [9, 9] }))];

/**
 * A plan/0 walled town (a street zone, its own K1 ring at [8, 14]): `gatehouse` the gate lot east of it (`mech` its mechanism), `k1` a K1
 * gate's anchor (a wooden-door gate) or none. Returns {plan, ir, meta, check, R (the reach inputs the mod would send)}.
 */
export async function passageTown({ gatehouse = true, mech = null, k1 = null } = {}) {
  const plan = { schemaVersion: 'plan/0',
    zones: [{ id: 'town', program: { lots: gatehouse ? LOTS : LOTS.slice(1), layout: 'street', orientation: 'ew' }, where: { near: { anchor: 'stone', within: 16 } } }],
    connectors: [{ id: 'town_wall', kind: 'wall', where: { around: { feature: { part: 'town' }, ring: [8, 14] } }, height: 5,
      ...(gatehouse ? { lots: [{ lot: 'gatehouse_1', at: 'gate', near: { anchor: 'east' }, ...(mech ? { mech } : {}) }] } : {}) },
    ...(k1 ? [{ id: 'tg', kind: 'gate', wall: 'town_wall', door: 'door', width: 3, at: { anchor: k1 } }] : [])] };
  const r = await checkPlanLocal(plan, { survey: encodeColumns(columnsOf(world, 0, 0, 160, 160)), claim: { minX: 0, minZ: 0, maxX: 159, maxZ: 159, minY: -64, maxY: 319 },
    anchors: { stone: [80, 65, 80], east: [154, 65, 80], north: [80, 65, 5], south: [80, 65, 154] } });
  const ir = r.res.ir;
  const t = reachInputs({ id: 'rg1', ir, world, claim: A });
  return { plan, ir, meta: r.res.meta, check: r.check, R: { ...t.besideReach, gates: besideGates('rg1', ir) } };
}


export const PG_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gj', 'pg-parity.json');

/** The towns: [name, passageTown's options]. */
export const PG_TOWNS = [['gatehouse', {}], ['portcullis', { mech: 'portcullis' }], ['swing', { mech: 'swing' }], ['mixed', { k1: 'north' }]];

/** An IR trimmed to what besideGates and the standing's walls read. */
export const trimPassage = (ir) => ({ graph: { nodes: (ir.graph?.nodes ?? []).filter((n) => n.kind === 'gate' || n.kind === 'passage'), edges: [] },
  parts: (ir.parts ?? []).filter((p) => p.id.startsWith('w_')), lots: ir.lots ?? [] });

/** The fixture from scratch. */
export async function buildPg() {
  const walls = [];
  for (const [name, o] of PG_TOWNS) {
    const T = await passageTown(o);
    const ir = trimPassage(T.ir);
    walls.push({ name, id: 'rg1', ir, gates: besideGates('rg1', ir), standingWalls: besideStanding('rg1', [0, 0, 159, 159], ir).walls });
  }
  return { walls };
}

if (process.argv.includes('--write')) {
  const f = await buildPg();
  fs.mkdirSync(path.dirname(PG_FIXTURE), { recursive: true });
  fs.writeFileSync(PG_FIXTURE, `${JSON.stringify(f)}\n`);
  console.log(`wrote ${PG_FIXTURE} (${fs.statSync(PG_FIXTURE).size} bytes)`);
}
