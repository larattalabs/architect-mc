// (7a K3) The sim's stand-in for a wall lot (sim.ts simWallLot, kit/lib/wallLotDesigns.mjs standInDesign) with the REAL kit: a tower or
// gatehouse request carrying Steward's wall-lot signs builds a design of exactly the lot's box, every face closed at rows 1..3 but the
// tower's front door / the gatehouse's passage and back doors (safe for any outer-face set, so WallLotCheck binds it); `sim:outerdoor`
// puts round 1's door in an outer face, and a versionOf repair (its notes may still carry the token) comes back with the door fixed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, simFaults, simWallLot, simWallLotOf } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'lib', 'wallLotDesigns.mjs'));
const BRIEF = 'keep the faces outside the wall closed at ground level (doors face in)';
const REFUSAL = 'lot tower_1 on wall curtain_wall: the design leaves the wall open at 4,65,0 4,66,0 (2 cells)';

interface H {
  sc: Sidecar;
  close(): Promise<void>;
}

async function harness(): Promise<H> {
  const root = tempDir('arch-k3-sim-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 5;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, close: async () => { await sc.close(); rmrf(root); } };
}

async function done(h: H, over: Record<string, unknown>): Promise<string> {
  const d = h.sc.requestDesign(DesignRequest.parse(request(over)));
  await until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(d.id)!.status), 60_000);
  const x = h.sc.designs.get(d.id)!;
  expect(x.status, x.error).toBe('done');
  return x.blueprintId!;
}

/** The installed head's cells: "x,y,z" -> block state (air left out) and its size. */
async function cellsOf(h: H, e: string): Promise<{ at: (x: number, y: number, z: number) => string; size: { x: number; y: number; z: number } }> {
  const { loadVersion } = (await import(pathToFileURL(path.join(KIT, 'lib', 'diff.mjs')).href)) as { loadVersion: (f: string) => { cells: Array<{ d: number[]; v: string }> } };
  const v = loadVersion(path.join(h.sc.config.libraryDir, e, `${e}.nbt`));
  const m = new Map(v.cells.filter((c) => !/:(cave_|void_)?air$/.test(c.v.replace(/\[.*$/, ''))).map((c) => [c.d.join(','), c.v]));
  const j = JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, e, `${e}.blueprint.json`), 'utf8')) as { size: { x: number; y: number; z: number } };
  return { at: (x, y, z) => m.get(`${x},${y},${z}`) ?? 'minecraft:air', size: j.size };
}

const open = (b: string) => /(^|:)air$|_door\b|_door\[|fence_gate|trapdoor/.test(b.replace(/\[.*$/, '')) || /_door$/.test(b.replace(/\[.*$/, ''));
const isDoor = (b: string) => /_door$/.test(b.replace(/\[.*$/, ''));

/** Every face cell (rows 1..3) of a W x D box that is open (air, a door, a gate, a trapdoor), as "x,y,z" with its block. */
function openFaceCells(c: { at: (x: number, y: number, z: number) => string }, W: number, D: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    if (x !== 0 && x !== W - 1 && z !== 0 && z !== D - 1) continue;
    for (let y = 1; y <= 3; y++) if (open(c.at(x, y, z))) out.push([`${x},${y},${z}`, c.at(x, y, z)]);
  }
  return out;
}

const passageReserved = (W: number, D: number, cols: number[]) => ({ front: 'south' as const, size: [W, D] as [number, number], cells: cols.flatMap((u) => Array.from({ length: D }, (_, v) => [0, 1, 2].map((y) => [u, y, v] as [number, number, number])).flat()) });

describe('the wall-lot stand-in: which requests take it, the token', () => {
  it('only tower / gatehouse requests with a maxSize and a wall-lot sign', () => {
    const m = { x: 9, y: 40, z: 9 };
    expect(simWallLot({ type: 'tower', maxSize: m, notes: BRIEF })).toMatchObject({ type: 'tower', size: [9, 40, 9], passage: null, outerDoor: false });
    expect(simWallLot({ type: 'tower', maxSize: m, notes: 'a tall watchtower' })).toBeUndefined();
    expect(simWallLot({ type: 'tower', notes: BRIEF })).toBeUndefined();
    expect(simWallLot({ type: 'house', maxSize: m, notes: BRIEF })).toBeUndefined();
    expect(simWallLot({ type: 'tower', maxSize: m, context: `site: ${BRIEF}` })).toBeDefined();
    const g = simWallLot({ type: 'gatehouse', maxSize: { x: 11, y: 40, z: 9 }, reserved: passageReserved(11, 9, [4, 5, 6]) })!;
    expect([g.size, [...new Set(g.passage!.map(([u]) => u))]]).toEqual([[11, 40, 9], [4, 5, 6]]);
    // the token alone is a sign; matched anywhere in the notes as a whole token
    expect(simWallLot({ type: 'tower', maxSize: m, notes: 'sim:outerdoor' })).toMatchObject({ outerDoor: true });
    expect(simWallLot({ type: 'tower', maxSize: m, notes: `${BRIEF}. Also sim:outerdoor, please` })).toMatchObject({ outerDoor: true });
    expect(simFaults({ notes: 'xsim:outerdoor sim:outerdoors sim:outerdoor_x' }).has('outerdoor')).toBe(false);
    expect(simWallLot({ type: 'tower', maxSize: m, notes: `${BRIEF} sim:outerdoors` })).toMatchObject({ outerDoor: false });
    expect(simWallLotOf('export const standIn = {"type":"tower","size":[9,40,9],"passage":null,"outerDoor":true};\n')).toMatchObject({ outerDoor: true });
    expect(simWallLotOf("export const id = 'x';")).toBeUndefined();
    expect(simWallLot({ type: 'tower', maxSize: m, ext: { 'architect:wallLot': { outerFaces: [0, 0, 0, 2] } } })).toMatchObject({ outerFaces: [0, 0, 0, 2] });
    expect(simWallLot({ type: 'tower', maxSize: m, notes: BRIEF, ext: { 'architect:wallLot': { outerFaces: [0, 0, 0] } } })!.outerFaces).toBeUndefined();
  });
});

describe.skipIf(!hasKit)('the wall-lot stand-in (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a tower: exactly the box, its only opening the front door (rows 1..3 closed elsewhere); sim:outerdoor and the versionOf repair', async () => {
    h = await harness();
    const W = 9, D = 9;
    const e = await done(h, { type: 'tower', name: 'Tower 1', maxSize: { x: W, y: 40, z: D }, notes: BRIEF });
    const c = await cellsOf(h, e);
    expect([c.size.x, c.size.z]).toEqual([W, D]);
    expect(c.size.y).toBeLessThanOrEqual(40);
    const holes = openFaceCells(c, W, D);
    expect(holes.length).toBeGreaterThan(0);
    expect(holes.every(([k, b]) => isDoor(b) && k.endsWith(`,${D - 1}`)), JSON.stringify(holes)).toBe(true);
    expect(holes.filter(([k]) => /^\d+,[12],/.test(k)).length).toBe(2);

    // sim:outerdoor: round 1's door on the back face
    const f = await done(h, { type: 'tower', name: 'Tower 2', maxSize: { x: W, y: 40, z: D }, notes: `${BRIEF} sim:outerdoor` });
    const c1 = await cellsOf(h, f);
    const h1 = openFaceCells(c1, W, D);
    expect(h1.length).toBeGreaterThan(0);
    expect(h1.every(([k, b]) => isDoor(b) && k.endsWith(',0')), JSON.stringify(h1)).toBe(true);
    // the repair: a versionOf whose notes still carry the token comes back with the door on the front
    const r = await done(h, { type: 'tower', name: 'Tower 2', maxSize: { x: W, y: 40, z: D }, notes: `${REFUSAL} (${BRIEF} sim:outerdoor)`, versionOf: { entryId: f } });
    expect(r).toBe(f);
    const c2 = await cellsOf(h, f);
    expect([c2.size.x, c2.size.y, c2.size.z]).toEqual([c1.size.x, c1.size.y, c1.size.z]);
    const h2 = openFaceCells(c2, W, D);
    expect(h2.length).toBeGreaterThan(0);
    expect(h2.every(([k, b]) => isDoor(b) && k.endsWith(`,${D - 1}`)), JSON.stringify(h2)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, f, `${f}.blueprint.json`), 'utf8')).version).toBe(2);
  }, 180_000);

  it('a gatehouse: exactly the box, the reserved passage open on a standable floor, doors on the back face only; sim:outerdoor and the repair', async () => {
    h = await harness();
    const W = 11, D = 9, cols = [4, 5, 6];
    const reserved = passageReserved(W, D, cols);
    const e = await done(h, { type: 'gatehouse', name: 'Gate 1', maxSize: { x: W, y: 40, z: D }, notes: BRIEF, reserved });
    const c = await cellsOf(h, e);
    expect([c.size.x, c.size.z]).toEqual([W, D]);
    for (const u of cols) for (let v = 0; v < D; v++) {
      for (let y = 1; y <= 3; y++) expect(c.at(u, y, v), `passage ${u},${y},${v}`).toBe('minecraft:air');
      expect(c.at(u, 0, v), `floor ${u},0,${v}`).not.toMatch(/air$|fence|slab|stairs|carpet/);
    }
    const passage = (k: string) => cols.includes(Number(k.split(',')[0]));
    const holes = openFaceCells(c, W, D).filter(([k]) => !passage(k));
    expect(holes.length).toBeGreaterThan(0);
    expect(holes.every(([k, b]) => isDoor(b) && k.endsWith(',0')), JSON.stringify(holes)).toBe(true);

    // sim:outerdoor: round 1 adds a door in the front face beside the passage; the versionOf repair drops it
    const f = await done(h, { type: 'gatehouse', name: 'Gate 2', maxSize: { x: W, y: 40, z: D }, notes: `sim:outerdoor ${BRIEF}`, reserved });
    const h1 = openFaceCells(await cellsOf(h, f), W, D).filter(([k]) => !passage(k));
    expect(h1.some(([k, b]) => isDoor(b) && k.endsWith(`,${D - 1}`)), JSON.stringify(h1)).toBe(true);
    await done(h, { type: 'gatehouse', name: 'Gate 2', maxSize: { x: W, y: 40, z: D }, notes: `${REFUSAL.replace('tower_1', 'gatehouse_1')} sim:outerdoor`, reserved, versionOf: { entryId: f } });
    const c2 = await cellsOf(h, f);
    const h2 = openFaceCells(c2, W, D).filter(([k]) => !passage(k));
    expect(h2.every(([k, b]) => isDoor(b) && k.endsWith(',0')), JSON.stringify(h2)).toBe(true);
    for (const u of cols) for (let v = 0; v < D; v++) for (let y = 1; y <= 3; y++) expect(c2.at(u, y, v)).toBe('minecraft:air');
  }, 180_000);

  it('a corner tower with its outer faces (ext architect:wallLot): the door off them, in round 1 and after the repair', async () => {
    h = await harness();
    const W = 9, D = 9;
    // castle_city's tower_1: the back row, the west side and the front's east half outer (rows 0..2 in the frame)
    const outer: number[] = [];
    for (let u = 0; u < W; u++) outer.push(u, 0, 0, 2);
    for (let v = 1; v < D; v++) outer.push(W - 1, v, 0, 2);
    for (let v = 1; v < 5; v++) outer.push(0, v, 0, 2);
    for (let u = 4; u < W - 1; u++) outer.push(u, D - 1, 0, 2);
    const isOuter = (k: string) => { const [x, , z] = k.split(',').map(Number); for (let i = 0; i < outer.length; i += 4) if (outer[i] === x && outer[i + 1] === z) return true; return false; };
    const ext = { 'architect:wallLot': { outerFaces: outer } };
    const f = await done(h, { type: 'tower', name: 'Corner', maxSize: { x: W, y: 40, z: D }, notes: `${BRIEF} sim:outerdoor`, ext });
    expect(openFaceCells(await cellsOf(h, f), W, D).some(([k]) => isOuter(k))).toBe(true);
    await done(h, { type: 'tower', name: 'Corner', maxSize: { x: W, y: 40, z: D }, notes: `${REFUSAL} sim:outerdoor`, ext, versionOf: { entryId: f } });
    const h2 = openFaceCells(await cellsOf(h, f), W, D);
    expect(h2.length).toBeGreaterThan(0);
    expect(h2.every(([k, b]) => isDoor(b) && !isOuter(k) && k.endsWith(`,${D - 1}`)), JSON.stringify(h2)).toBe(true);
  }, 180_000);

  it('a tower request without the wall-lot signs keeps the kit example', async () => {
    h = await harness();
    const e = await done(h, { type: 'tower', name: 'Watch', maxSize: { x: 64, y: 64, z: 64 } });
    expect(fs.readFileSync(path.join(h.sc.config.libraryDir, e, `${e}.mjs`), 'utf8')).not.toMatch(/standIn/);
  }, 120_000);
});
