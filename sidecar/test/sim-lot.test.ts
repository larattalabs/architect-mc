// (CW2) The sim's lot stand-in: when no kit example fits a request's max size (a real S plan's 9x9 lot, which Steward briefs as
// 9 x 24 x 7 after its approach margin; the smallest cabin is 11 wide), the massing and the detail are one shed sized from that box.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { GroupRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { simFit, simLotDesign, simLotSpec, SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'designs', 'cabin.mjs'));
const LOT = { x: 9, y: 24, z: 7 };

describe('the lot stand-in spec (pure)', () => {
  it('sizes the shed from the box: the full width, the depth less the path row, gable when it fits, else lean-to, else none', () => {
    expect(simLotSpec(LOT)).toEqual({ box: [0, 0, 0, 8, 6, 5], roof: 'gable' });
    expect(simLotSpec({ x: 9, y: 24, z: 9 })).toEqual({ box: [0, 0, 0, 8, 7, 7], roof: 'gable' });
    expect(simLotSpec({ x: 7, y: 6, z: 7 })).toEqual({ box: [0, 0, 0, 6, 5, 5], roof: 'lean_to' });
    expect(simLotSpec({ x: 3, y: 24, z: 9 })).toBeUndefined();
    expect(simLotSpec({ x: 9, y: 5, z: 9 })).toBeUndefined();
    expect(simLotSpec(undefined)).toBeUndefined();
    // deterministic: the same box, the same source
    const a = simLotDesign('gen_x', 'house', undefined, simLotSpec(LOT)!);
    expect(simLotDesign('gen_x', 'house', undefined, simLotSpec(LOT)!)).toBe(a);
    expect(a).toContain('export const lotStandIn = {"box":[0,0,0,8,6,5],"roof":"gable"}');
  });
});

describe.skipIf(!hasKit)('the lot stand-in (real kit)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('no kit example fits the lot (the case the stand-in covers)', async () => {
    expect(await simFit(KIT, 'cabin', LOT)).toBeUndefined();
  });

  it('a 9x24x7 lot: a massingFirst item gets a lot stand-in massing and a conforming detail; a plain and a SMALL item a fitting design', async () => {
    const root = tempDir('arch-cw2-lot-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 15;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    close = async () => {
      await sc.close();
      rmrf(root);
    };
    const within = (dir: string, id: string) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, `${id}.blueprint.json`), 'utf8'));
      expect(j.size.x).toBeLessThanOrEqual(LOT.x);
      expect(j.size.y).toBeLessThanOrEqual(LOT.y);
      expect(j.size.z).toBeLessThanOrEqual(LOT.z);
      return j.size;
    };
    const item = (k: string, type: string, extra: Record<string, unknown> = {}) => ({ ...request({ type, name: undefined, notes: undefined, maxSize: LOT }), itemKey: k, ...extra });
    const g = sc.groups.create(GroupRequest.parse({ name: 'S lot', bible: 'birch', owner: 'steward:s1', massingFirst: true, approvalUi: 'owner', items: [item('s', 'house')] }));
    await until(() => sc.groups.get(g.id)!.status === 'awaiting_approval' || ['done', 'failed'].includes(sc.groups.get(g.id)!.status), 600_000);
    expect(sc.groups.get(g.id)!.status, JSON.stringify(sc.designs.get(sc.groups.get(g.id)!.items[0]!.designId)?.error)).toBe('awaiting_approval');
    const m = sc.massings.get(sc.groups.get(g.id)!.items[0]!.massing!.id, 1)!;
    const ms = within(m.dir, m.id);
    sc.groups.approve(g.id, { approve: ['s'], redirect: {}, cancel: [], owner: 'steward:s1' });
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.groups.get(g.id)!.status), 600_000);
    const done = sc.groups.get(g.id)!;
    expect(done.status, JSON.stringify(sc.designs.get(done.items[0]!.designId)?.error)).toBe('done');
    expect(within(path.join(cfg.libraryDir, done.items[0]!.entryId!), done.items[0]!.entryId!)).toEqual(ms);
    const g2 = sc.groups.create(GroupRequest.parse({ name: 'S plain', bible: 'birch', items: [item('p', 'cottage'), item('q', 'workshop', { effort: 'small' })] }));
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.groups.get(g2.id)!.status), 600_000);
    const d2 = sc.groups.get(g2.id)!;
    expect(d2.status, JSON.stringify(d2.items.map((i) => sc.designs.get(i.designId)?.error))).toBe('done');
    for (const it of d2.items) {
      const e = it.entryId ?? sc.designs.get(it.designId)?.blueprintId;
      expect(e, JSON.stringify(it)).toBeTruthy();
      within(path.join(cfg.libraryDir, e!), e!);
    }
  }, 1_800_000);
});
