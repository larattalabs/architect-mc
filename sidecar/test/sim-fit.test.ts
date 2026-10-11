// (6c 0a) The sim fits the request's max size (Steward's stub e2e: an S lot, max 11x24x9): the type's example at defaults when it
// fits, else smaller params (the cabin without its porch), and for a massing pass a one-box stand-in the size of the fitted detail.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { GroupRequest } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner, simFit, withDefaults } from '../src/sim.js';
import { Store } from '../src/store.js';
import { request, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'designs', 'cabin.mjs'));
const S = { x: 11, y: 24, z: 9 };

describe.skipIf(!hasKit)('the sim fits the max size (real kit)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('picks params that fit (or the defaults when they do), and rewrites a source to them', async () => {
    const big = await simFit(KIT, 'cabin', { x: 40, y: 40, z: 40 });
    expect(big).toMatchObject({ src: 'cabin', changed: false });
    const s = (await simFit(KIT, 'cabin', S))!;
    expect(s.src).toBe('cabin');
    expect(s.changed).toBe(true);
    expect(s.built.size.x).toBeLessThanOrEqual(11);
    expect(s.built.size.z).toBeLessThanOrEqual(9);
    expect(s.values.porch).toBe(false);
    const src = fs.readFileSync(path.join(KIT, 'designs', 'cabin.mjs'), 'utf8');
    const w = withDefaults(src, s.values);
    expect(w).toMatch(/porch:\s*\{[^}]*default:\s*false/);
    expect(w).toMatch(/porch = false/);
    expect(await simFit(KIT, 'cabin', { x: 7, y: 6, z: 7 })).toBeUndefined();
  });

  it('an S lot (max 11x24x9): a massingFirst item gets a stand-in massing and a fitted detail; a plain item a fitted design', async () => {
    const root = tempDir('arch-0a-fit-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 15;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    close = async () => {
      await sc.close();
      rmrf(root);
    };
    const item = (k: string) => ({ ...request({ type: 'cabin', name: undefined, notes: undefined, maxSize: S }), itemKey: k });
    const g = sc.groups.create(GroupRequest.parse({ name: 'S lot', bible: 'birch', owner: 'steward:s1', massingFirst: true, approvalUi: 'owner', items: [item('s')] }));
    await until(() => sc.groups.get(g.id)!.status === 'awaiting_approval' || ['done', 'failed'].includes(sc.groups.get(g.id)!.status), 30_000);
    expect(sc.groups.get(g.id)!.status, JSON.stringify(sc.designs.get(sc.groups.get(g.id)!.items[0]!.designId)?.error)).toBe("awaiting_approval");
    const m = sc.massings.get(sc.groups.get(g.id)!.items[0]!.massing!.id, 1)!;
    const mj = JSON.parse(fs.readFileSync(path.join(m.dir, `${m.id}.blueprint.json`), 'utf8'));
    expect(mj.size.x).toBeLessThanOrEqual(11);
    expect(mj.size.z).toBeLessThanOrEqual(9);
    sc.groups.approve(g.id, { approve: ['s'], redirect: {}, cancel: [], owner: 'steward:s1' });
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.groups.get(g.id)!.status), 30_000);
    const done = sc.groups.get(g.id)!;
    expect(done.status, JSON.stringify(done.items[0])).toBe('done');
    const e = JSON.parse(fs.readFileSync(path.join(cfg.libraryDir, done.items[0]!.entryId!, `${done.items[0]!.entryId}.blueprint.json`), 'utf8'));
    expect(e.size.x).toBeLessThanOrEqual(11);
    expect(e.size.z).toBeLessThanOrEqual(9);
    const g2 = sc.groups.create(GroupRequest.parse({ name: 'S plain', bible: 'birch', items: [item('p')] }));
    await until(() => ['done', 'failed', 'cancelled'].includes(sc.groups.get(g2.id)!.status), 30_000);
    expect(sc.groups.get(g2.id)!.status).toBe('done');
  }, 60_000);
});
