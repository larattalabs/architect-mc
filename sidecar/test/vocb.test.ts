// (6c VOC-b) The sidecar half of the VOC gate's items 7 and 8 (docs/CONTRACT.md "Phase 6c slice VOC" §4.2, §4.3): BibleRequest.rarity
// checked with the kit's validateRarity (FIELD_LIMIT naming the path, before any job), copied by code into the made bible (the sim's bible
// job: what Steward's $0 gates see; never into a prompt), carried by a revise; a bible's rarity to the plan CLI's bible.json; the kit's
// metrics.rarity and metrics.drift kept out of the agent's files unless the bible opts in; the feature bible.rarity.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { FEATURES, type Outbound } from '../src/protocol.js';
import { bibleOptsIn, checkRarity, promptMetrics } from '../src/rarity.js';
import { RefusedError } from '../src/errors.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'lib', 'vocab', 'rarity.mjs'));

async function harness(over: Partial<Config> = {}, root = tempDir('arch-vocb-')) {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  cfg.simLimitMs = 600;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return { root, sc, events, close: async () => { await sc.close(); rmrf(root); } };
}
const send = async (sc: Sidecar, msg: Record<string, unknown>) => {
  const out: Outbound[] = [];
  await sc.handle({ v: 1, id: 'q1', ...msg } as never, (m) => out.push(m));
  return out.find((m) => m.type === 'ack') as unknown as { ok: boolean; code?: string; detail?: string; error?: string; result?: Record<string, unknown> };
};

const RARITY = { uncommonShareMax: 0.2, rareShareMax: 0.06, preciousMax: 1, families: { concrete: 0.6 }, colours: ['white', 'light_gray', 'black'], allow: ['minecraft:beacon', '#minecraft:wool'] };

describe.skipIf(!hasKit)('(6c VOC-b) rarity budgets in the sidecar', () => {
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('the feature bible.rarity', () => {
    expect(FEATURES).toContain('bible.rarity');
    expect(FEATURES.indexOf('bible.rarity')).toBe(FEATURES.length - 1);
  });

  it('checkRarity: the kit\'s validateRarity; a malformed budget is FIELD_LIMIT naming its path', async () => {
    await expect(checkRarity(KIT, undefined)).resolves.toBeUndefined();
    await expect(checkRarity(KIT, RARITY)).resolves.toBeUndefined();
    for (const [bad, want] of [[{ rareShareMax: 0.9 }, 'rarity.rareShareMax'], [{ colours: ['teal'] }, "rarity.colours: 'teal'"], [{ nope: 1 }, "unknown field 'nope'"], [{ allow: ['minecraft:not_a_block'] }, 'rarity.allow'], [[1], 'rarity must be an object']] as const) {
      const e = await checkRarity(KIT, bad).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RefusedError);
      expect(e).toMatchObject({ code: 'FIELD_LIMIT', detail: 'rarity' });
      expect((e as Error).message).toContain(want);
    }
  });

  it('bible.request with a malformed rarity: refused FIELD_LIMIT before any job; a good one is copied into the made bible byte for byte', async () => {
    h = await harness();
    const n0 = h.sc.bibles.recent().length;
    const bad = await send(h.sc, { type: 'bible.request', request: { prompt: 'a modern town', rarity: { rareShareMax: 2 } } });
    expect(bad).toMatchObject({ ok: false, code: 'FIELD_LIMIT', detail: 'rarity' });
    expect(bad.error).toContain('rarity.rareShareMax');
    expect(h.sc.bibles.recent().length).toBe(n0);
    const est = await send(h.sc, { type: 'bible.estimate', request: { prompt: 'x', rarity: { coloursMax: 0 } } });
    expect(est).toMatchObject({ ok: false, code: 'FIELD_LIMIT', detail: 'rarity' });
    const ok = await send(h.sc, { type: 'bible.request', request: { prompt: 'a modern town', name: 'Modern', rarity: RARITY } });
    expect(ok.ok).toBe(true);
    const jobId = ok.result!.jobId as string;
    await until(() => ['done', 'failed'].includes(h!.sc.bibles.get(jobId)!.status), 30_000);
    expect(h.sc.bibles.get(jobId)!.status, h.sc.bibles.get(jobId)!.error).toBe('done');
    const bible = JSON.parse(fs.readFileSync(path.join(h.sc.config.biblesDir, 'bib_modern', 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(bible.rarity)).toBe(JSON.stringify(RARITY));
    expect(bible.format).toBe(2);
    expect(h.sc.bibleIndex.get('bib_modern')!.rarity).toEqual(RARITY);
    // the prompt never sees it (N-VOC-1): the job's draft prompt in the scratch holds no budget
    // a revise keeps the budget (v2 carries it)
    const r = h.sc.bibles.revise('bib_modern', 'more glass');
    await until(() => h!.sc.bibles.get(r.id)!.status === 'done', 30_000);
    const v2 = JSON.parse(fs.readFileSync(path.join(h.sc.config.biblesDir, 'bib_modern', 'versions', '2', 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(v2.rarity).toEqual(RARITY);
    // a request without one: no member (the 1.10.0 shape)
    const plain = await send(h.sc, { type: 'bible.request', request: { prompt: 'a plain town', name: 'Plain' } });
    await until(() => ['done', 'failed'].includes(h!.sc.bibles.get(plain.result!.jobId as string)!.status), 30_000);
    expect(JSON.parse(fs.readFileSync(path.join(h.sc.config.biblesDir, 'bib_plain', 'bible.json'), 'utf8')).rarity).toBeUndefined();
  }, 90_000);

  it('promptMetrics: rarity and drift only when the scratch bible opts in', () => {
    const root = tempDir('arch-vocb-pm-');
    try {
      const m = { accentShare: 0.1, rarity: { cells: 3 }, drift: { 'minecraft:copper_block': 2 } };
      expect(bibleOptsIn(root)).toBe(false);
      expect(promptMetrics(m, bibleOptsIn(root))).toEqual({ accentShare: 0.1 });
      fs.mkdirSync(path.join(root, 'bible'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bible', 'bible.json'), JSON.stringify({ roles: {} }));
      expect(bibleOptsIn(root)).toBe(false);
      fs.writeFileSync(path.join(root, 'bible', 'bible.json'), JSON.stringify({ roles: {}, rarity: {} }));
      expect(bibleOptsIn(root)).toBe(true);
      expect(promptMetrics(m, true)).toEqual(m);
      expect(promptMetrics(null, false)).toBeNull();
    } finally {
      rmrf(root);
    }
  });
});
