// (7a K3, since NEXT; feature wallLots.exactMassing) A wall lot (a request carrying ext["architect:wallLot"], its maxSize the lot's
// exact box) in a massing-first group: its massing takes its box (the sim's stand-in massing; with Claude the brief says so and the
// massing check refuses another footprint) and its detail pass is capped by the box, not by the massing's size + 2 (`--max` and the
// kit's `--massing-cap`). Steward's K3 RC found every box-filling detail refused (towers 13x28x11 over 11x26x11, the gatehouse
// 17x13x15 over 13x14x12) because the sim's massing was the kit's tower example. Other requests keep massing + 2.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { massingBindingSection, massingBrief, designBrief } from '../src/claude/brief.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { detailMax, isWallLotRequest, wallLotMassingProblem } from '../src/massings.js';
import { DesignRequest, GroupRequest, type Massing } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'lib', 'wallLotDesigns.mjs'));
const BRIEF = 'keep the faces outside the wall closed at ground level (doors face in)';
const REFUSAL = 'lot tower_1 on wall curtain_wall: the design leaves the wall open at 4,65,0 4,66,0 (2 cells)';
// Steward's real boxes (castle_city): towers 13 x 11, the gatehouse 17 x 15 with its passage reserved, both 40 high
const TOWER = { x: 13, y: 40, z: 11 };
const GATE = { x: 17, y: 40, z: 15 };
const PASSAGE = [7, 8, 9];
const passageReserved = (W: number, D: number, cols: number[]) => ({ front: 'south' as const, size: [W, D] as [number, number], cells: cols.flatMap((u) => Array.from({ length: D }, (_, v) => [0, 1, 2].map((y) => [u, y, v] as [number, number, number])).flat()) });
/** a tower's outer faces: its back row (rows 0..2), as onWall.outerFaces.lotCells */
const backRow = (W: number) => Array.from({ length: W }, (_, u) => [u, 0, 0, 2]).flat();
/** a gatehouse's outer faces: its front row but the passage */
const frontRow = (W: number, D: number, skip: number[]) => Array.from({ length: W }, (_, u) => u).filter((u) => !skip.includes(u)).flatMap((u) => [u, D - 1, 0, 2]);

describe('the wall-lot cap rule (unit)', () => {
  it('detailMax: massing + 2 capped by the request; exact (a wall lot): the request\'s box', () => {
    expect(detailMax({ x: 9, y: 24, z: 11 }, TOWER)).toEqual({ x: 11, y: 26, z: 11 });
    expect(detailMax({ x: 9, y: 24, z: 11 }, TOWER, true)).toEqual(TOWER);
    expect(detailMax({ x: 11, y: 12, z: 10 }, { x: 17, y: 13, z: 15 })).toEqual({ x: 13, y: 13, z: 12 });
  });

  it('isWallLotRequest: only ext["architect:wallLot"] (an object) with a maxSize', () => {
    expect(isWallLotRequest({ maxSize: TOWER, ext: { 'architect:wallLot': { outerFaces: [] } } })).toBe(true);
    expect(isWallLotRequest({ maxSize: TOWER, ext: { 'architect:wallLot': {} } })).toBe(true);
    expect(isWallLotRequest({ maxSize: TOWER })).toBe(false);
    expect(isWallLotRequest({ maxSize: TOWER, ext: { 'architect:wallLot': true } })).toBe(false);
    expect(isWallLotRequest({ maxSize: TOWER, ext: { 'architect:wallLot': [1] } })).toBe(false);
    expect(isWallLotRequest({ ext: { 'architect:wallLot': {} } })).toBe(false);
    // the sim's other signs (the brief line, a gatehouse's reserved passage) are not the contract
    expect(isWallLotRequest({ maxSize: GATE, ext: { other: 1 } })).toBe(false);
  });

  it('a wall lot\'s massing must fill the box\'s footprint (x and z; y free up to the box)', () => {
    const ext = { 'architect:wallLot': { outerFaces: [] } };
    expect(wallLotMassingProblem({ maxSize: TOWER, ext }, { x: 13, z: 11 })).toBeUndefined();
    expect(wallLotMassingProblem({ maxSize: TOWER, ext }, { x: 9, z: 11 })).toMatch(/footprint exactly: x 13 by z 11 \(it is 9 by 11\)/);
    expect(wallLotMassingProblem({ maxSize: TOWER, ext }, { x: 13, z: 9 })).toBeDefined();
    expect(wallLotMassingProblem({ maxSize: TOWER }, { x: 9, z: 9 })).toBeUndefined();
  });

  it('the Claude briefs: the massing\'s footprint is the box; the detail\'s binding section and build command take the box', () => {
    const ext = { 'architect:wallLot': { outerFaces: backRow(13) } };
    const wl = DesignRequest.parse(request({ type: 'tower', maxSize: TOWER, ext, massing: true }));
    expect(massingBrief(wl, 'mas_t', { renderer: false, examples: [] })).toMatch(/a wall lot: the massing's footprint must be exactly x 13 by z 11/);
    expect(massingBrief(DesignRequest.parse(request({ type: 'tower', maxSize: TOWER, massing: true })), 'mas_t', { renderer: false, examples: [] })).not.toMatch(/wall lot/);
    const m = { id: 'mas_t', version: 1, size: { x: 13, y: 30, z: 11 }, parts: {} } as unknown as Massing;
    expect(massingBindingSection(m, TOWER, true).join('\n')).toMatch(/fill the lot's box exactly, x 13 by z 11, up to y 40/);
    expect(massingBindingSection(m, { x: 15, y: 32, z: 11 }).join('\n')).toMatch(/within 2 of the massing's, and never more than x 15, y 32, z 11/);
    const detail = DesignRequest.parse(request({ type: 'tower', maxSize: TOWER, ext, fromMassing: 'mas_t' }));
    const b = designBrief(detail, 'gen_t', { renderer: false, examples: [], massing: { record: m, role: 'detail', files: [], maxSize: TOWER } });
    expect(b).toContain('--max 13,40,11 --type tower');
    expect(b).toContain('--massing massing/mas_t.blueprint.json --massing-cap 13,40,11');
    const plain = designBrief(DesignRequest.parse(request({ type: 'tower', maxSize: TOWER, fromMassing: 'mas_t' })), 'gen_t', { renderer: false, examples: [], massing: { record: m, role: 'detail', files: [], maxSize: { x: 13, y: 32, z: 11 } } });
    expect(plain).not.toContain('--massing-cap');
  });
});

interface H {
  sc: Sidecar;
  close(): Promise<void>;
}

async function harness(): Promise<H> {
  const root = tempDir('arch-k3-massing-');
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 5;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { sc, close: async () => { await sc.close(); rmrf(root); } };
}

const FINAL = ['done', 'failed', 'cancelled'];

/** A massing-first group of `items`: every massing approved; resolves when the group is final. */
async function massingFirst(h: H, items: Array<Record<string, unknown>>): Promise<string> {
  const g = h.sc.groups.create(GroupRequest.parse({ name: 'Castle', bible: 'birch', owner: 'steward:s1', massingFirst: true, approvalUi: 'owner', items }));
  await until(() => h.sc.groups.get(g.id)!.status === 'awaiting_approval' || FINAL.includes(h.sc.groups.get(g.id)!.status), 60_000);
  const x = h.sc.groups.get(g.id)!;
  expect(x.status, JSON.stringify(x.items.map((it) => [it.itemKey, it.status, h.sc.designs.get(it.designId!)?.error]))).toBe('awaiting_approval');
  h.sc.groups.approve(g.id, { approve: x.items.map((it) => it.itemKey), redirect: {}, cancel: [], owner: 'steward:s1' });
  await until(() => FINAL.includes(h.sc.groups.get(g.id)!.status), 120_000);
  return g.id;
}

/** The installed head's cells and size. */
async function cellsOf(h: H, e: string): Promise<{ at: (x: number, y: number, z: number) => string; size: { x: number; y: number; z: number } }> {
  const { loadVersion } = (await import(pathToFileURL(path.join(KIT, 'lib', 'diff.mjs')).href)) as { loadVersion: (f: string) => { cells: Array<{ d: number[]; v: string }> } };
  const v = loadVersion(path.join(h.sc.config.libraryDir, e, `${e}.nbt`));
  const m = new Map(v.cells.filter((c) => !/:(cave_|void_)?air$/.test(c.v.replace(/\[.*$/, ''))).map((c) => [c.d.join(','), c.v]));
  const j = JSON.parse(fs.readFileSync(path.join(h.sc.config.libraryDir, e, `${e}.blueprint.json`), 'utf8')) as { size: { x: number; y: number; z: number } };
  return { at: (x, y, z) => m.get(`${x},${y},${z}`) ?? 'minecraft:air', size: j.size };
}

const isDoor = (b: string) => /_door$/.test(b.replace(/\[.*$/, ''));
const open = (b: string) => /(^|:)air$|fence_gate|trapdoor/.test(b.replace(/\[.*$/, '')) || isDoor(b);
function openFaceCells(c: { at: (x: number, y: number, z: number) => string }, W: number, D: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    if (x !== 0 && x !== W - 1 && z !== 0 && z !== D - 1) continue;
    for (let y = 1; y <= 3; y++) if (open(c.at(x, y, z))) out.push([`${x},${y},${z}`, c.at(x, y, z)]);
  }
  return out;
}

describe.skipIf(!hasKit)('wall lots in a massing-first group (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a 13 x 11 tower and a 17 x 15 gatehouse: the massings take the boxes, the details fill them exactly and close the faces', async () => {
    h = await harness();
    const tower = { ...request({ type: 'tower', name: 'Tower 1', notes: BRIEF, maxSize: TOWER, features: [] }), itemKey: 'tower_1', ext: { 'architect:wallLot': { outerFaces: backRow(TOWER.x) } } };
    const gate = { ...request({ type: 'gatehouse', name: 'Gatehouse 1', notes: BRIEF, maxSize: GATE, features: [], reserved: passageReserved(GATE.x, GATE.z, PASSAGE) }), itemKey: 'gatehouse_1', ext: { 'architect:wallLot': { outerFaces: frontRow(GATE.x, GATE.z, PASSAGE) } } };
    const gid = await massingFirst(h, [tower, gate]);
    const g = h.sc.groups.get(gid)!;
    expect(g.status, JSON.stringify(g.items.map((it) => [it.itemKey, it.status, it.error, h!.sc.designs.get(it.designId!)?.error]))).toBe('done');
    for (const [key, box] of [['tower_1', TOWER], ['gatehouse_1', GATE]] as const) {
      const it = g.items.find((x) => x.itemKey === key)!;
      expect(it.entryId, JSON.stringify(it)).toBeDefined();
      // the massing: exactly the box's footprint
      const m = h.sc.massings.get(it.massing!.id)!;
      expect([m.size.x, m.size.z], key).toEqual([box.x, box.z]);
      // the detail: exactly the box's footprint, within its height; checked with the box as its cap, no conformance errors
      const c = await cellsOf(h, it.entryId!);
      expect([c.size.x, c.size.z], key).toEqual([box.x, box.z]);
      expect(c.size.y).toBeLessThanOrEqual(box.y);
      const d = h.sc.designs.get(it.designId!)!;
      expect(d.request.fromMassing, key).toBe(m.id);
      const plan = h.sc.checkPlan(d);
      expect(plan.limits.maxSize, key).toEqual(box);
      expect(plan.extra.join(' ')).toContain(`--massing-cap ${box.x},${box.y},${box.z}`);
      expect(d.conformance?.errors ?? [], key).toEqual([]);
    }
    // the tower: its only openings at rows 1..3 the front door (the front faces in)
    const t = await cellsOf(h, g.items.find((x) => x.itemKey === 'tower_1')!.entryId!);
    const th = openFaceCells(t, TOWER.x, TOWER.z);
    expect(th.length).toBeGreaterThan(0);
    expect(th.every(([k, b]) => isDoor(b) && k.endsWith(`,${TOWER.z - 1}`)), JSON.stringify(th)).toBe(true);
    // the gatehouse: the passage open on a standable floor, its other openings doors on the back face
    const gh = await cellsOf(h, g.items.find((x) => x.itemKey === 'gatehouse_1')!.entryId!);
    for (const u of PASSAGE) for (let v = 0; v < GATE.z; v++) {
      for (let y = 1; y <= 3; y++) expect(gh.at(u, y, v), `passage ${u},${y},${v}`).toBe('minecraft:air');
      expect(gh.at(u, 0, v), `floor ${u},0,${v}`).not.toMatch(/air$|fence|slab|stairs|carpet/);
    }
    const holes = openFaceCells(gh, GATE.x, GATE.z).filter(([k]) => !PASSAGE.includes(Number(k.split(',')[0])));
    expect(holes.every(([k, b]) => isDoor(b) && k.endsWith(',0')), JSON.stringify(holes)).toBe(true);
  }, 240_000);

  it('sim:outerdoor under massing-first: round 1\'s detail carries the outer door; a versionOf fixes it in the same box', async () => {
    h = await harness();
    const ext = { 'architect:wallLot': { outerFaces: backRow(TOWER.x) } };
    const tower = { ...request({ type: 'tower', name: 'Tower 2', notes: `${BRIEF} sim:outerdoor`, maxSize: TOWER, features: [] }), itemKey: 'tower_2', ext };
    const gid = await massingFirst(h, [tower]);
    const it = h.sc.groups.get(gid)!.items[0]!;
    expect(it.status, it.error).toBe('done');
    const e = it.entryId!;
    const c1 = await cellsOf(h, e);
    expect([c1.size.x, c1.size.z]).toEqual([TOWER.x, TOWER.z]);
    const h1 = openFaceCells(c1, TOWER.x, TOWER.z);
    expect(h1.some(([k, b]) => isDoor(b) && k.endsWith(',0')), JSON.stringify(h1)).toBe(true);
    // Steward's repair after the bind refuses it: a versionOf of the entry (its notes may still carry the token)
    const r = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tower', name: 'Tower 2', notes: `${REFUSAL} (${BRIEF} sim:outerdoor)`, maxSize: TOWER, features: [], ext, versionOf: { entryId: e } })));
    await until(() => FINAL.includes(h!.sc.designs.get(r.id)!.status), 60_000);
    expect(h.sc.designs.get(r.id)!.status, h.sc.designs.get(r.id)!.error).toBe('done');
    const c2 = await cellsOf(h, e);
    expect([c2.size.x, c2.size.y, c2.size.z]).toEqual([c1.size.x, c1.size.y, c1.size.z]);
    const h2 = openFaceCells(c2, TOWER.x, TOWER.z);
    expect(h2.length).toBeGreaterThan(0);
    expect(h2.every(([k, b]) => isDoor(b) && k.endsWith(`,${TOWER.z - 1}`)), JSON.stringify(h2)).toBe(true);
  }, 240_000);

  it('a request without ext["architect:wallLot"] keeps the massing + 2 cap (and the kit example massing)', async () => {
    h = await harness();
    const tower = { ...request({ type: 'tower', name: 'Watch', notes: undefined, maxSize: { x: 64, y: 64, z: 64 }, features: [] }), itemKey: 'watch' };
    const gid = await massingFirst(h, [tower]);
    const it = h.sc.groups.get(gid)!.items[0]!;
    expect(it.status, it.error).toBe('done');
    const m = h.sc.massings.get(it.massing!.id)!;
    const d = h.sc.designs.get(it.designId!)!;
    const plan = h.sc.checkPlan(d);
    expect(plan.limits.maxSize).toEqual(detailMax(m.size, { x: 64, y: 64, z: 64 }));
    expect(plan.limits.maxSize).toEqual({ x: m.size.x + 2, y: m.size.y + 2, z: m.size.z + 2 });
    expect(plan.extra).not.toContain('--massing-cap');
  }, 240_000);
});
