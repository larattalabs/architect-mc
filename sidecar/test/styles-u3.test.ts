// Style unification U3: bible.check, the Style editor's test-house check (the kit's validation as bible.save runs it, nothing saved).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { BibleCheckMsg, FEATURES, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { rmrf, SIDECAR_ROOT, tempDir } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));

/** kit PALETTES.medieval.roles */
const MEDIEVAL = {
  wall: 'minecraft:white_terracotta', wall_alt: 'minecraft:calcite', trim: 'minecraft:smooth_stone', roof: 'minecraft:spruce_planks', floor: 'minecraft:dark_oak_planks',
  frame: 'minecraft:dark_oak_log', accent: 'minecraft:spruce_planks', light: 'minecraft:lantern', glass: 'minecraft:glass_pane', foundation: 'minecraft:stone_bricks', path: 'minecraft:dirt_path',
};

describe('bible.check (wire)', () => {
  it('is a feature and a message: a Style, an optional scope', () => {
    expect(FEATURES).toContain('bible.check');
    expect(FEATURES.indexOf('bible.check')).toBe(FEATURES.indexOf('bible.save') + 1);
    expect(BibleCheckMsg.safeParse({ v: 1, type: 'bible.check', bible: { name: 'X', roles: MEDIEVAL } }).success).toBe(true);
    expect(BibleCheckMsg.safeParse({ v: 1, type: 'bible.check', bible: { name: 'X', roles: MEDIEVAL }, scope: 'settlement' }).success).toBe(true);
    expect(BibleCheckMsg.safeParse({ v: 1, type: 'bible.check', bible: { name: 'X' }, scope: 'town' }).success).toBe(false);
  });
});

describe.skipIf(!hasKit)('bible.check (sim backend, real kit)', () => {
  let sc: Sidecar | undefined;
  let root = '';
  afterEach(async () => {
    await sc?.close();
    sc = undefined;
    rmrf(root);
  });

  it('passes a sound Style, refuses a light that gives no light and a roof without stairs, and saves nothing', async () => {
    root = tempDir('arch-u3-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 10;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    const before = fs.existsSync(cfg.biblesDir) ? fs.readdirSync(cfg.biblesDir) : [];
    const ok = sc.bibleIndex.check({ bible: { name: 'Daub', roles: MEDIEVAL, tags: ['warm'], id: 'ignored', version: 9, origin: 'claude' } });
    expect(ok).toMatchObject({ ok: true, errors: [] });
    const dark = sc.bibleIndex.check({ bible: { name: 'Dark', roles: { ...MEDIEVAL, light: 'minecraft:oak_planks' } } });
    expect(dark.ok).toBe(false);
    expect(dark.errors.join(' ')).toMatch(/test house|light/);
    const flat = sc.bibleIndex.check({ bible: { name: 'Glass roof', roles: { ...MEDIEVAL, roof: 'minecraft:glass' } } });
    expect(flat.ok).toBe(false);
    expect(flat.errors.join(' ')).toMatch(/roof/);
    // nothing is installed and no stage is left behind
    expect(fs.existsSync(cfg.biblesDir) ? fs.readdirSync(cfg.biblesDir) : []).toEqual(before);
    expect(fs.readdirSync(cfg.dataDir).filter((f) => f.startsWith('bible-check-'))).toEqual([]);
    // the wire acks the verdict
    const acks: Outbound[] = [];
    await sc.handle(BibleCheckMsg.parse({ v: 1, type: 'bible.check', id: 'k1', bible: { name: 'Dark', roles: { ...MEDIEVAL, light: 'minecraft:oak_planks' } } }) as never, (m) => acks.push(m));
    expect(acks[0]).toMatchObject({ type: 'ack', ok: true, result: { ok: false } });
  });
});
