// Slice SR (7c, Steward's S-7c-4 at the v0.64.0 RC): the region ghost never shows a hidden room. Ghost tiles are evaluated by the
// tile worker (region-worker.mjs) over windows of the plan survey; the sidecar hands it the plan meta's secret parts (`hide`) and the
// worker evaluates them with no ops, as the kit's previews draw them (as if unwritten). Here the real kit plans HR's x01 (a 5x5 room in
// a hollow mountain behind a wall entrance) and every ghost tile from the pool equals the kit's own evalTile of the IR with the room's
// parts emptied: the host as before the room. At least one tile differs from the un-hidden evaluation (the room was there).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretPartsOf } from '../src/regions.js';
import { TilePool } from '../src/regionpool.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const FX = path.join(KIT, 'test', 'fixtures', 'plan', 'hr', 'x01_mountain_room.json');
const hasHr = fs.existsSync(FX) && fs.existsSync(path.join(KIT, 'lib', 'forms', 'hiddenRoom.mjs'));
const imp = (p: string) => import(pathToFileURL(path.join(KIT, p)).href);

type Ir = { claim: { minX: number; maxX: number; minZ: number; maxZ: number }; stages: string[]; parts: Array<{ id: string; stage: string; ops: unknown[] }> } & Record<string, unknown>;

describe.skipIf(!hasHr)('(7c SR) ghost tiles of a hidden room: the host without the room (real kit, x01)', () => {
  let pool: TilePool;
  let ir: Ir;
  let irJson: string;
  let meta: unknown;
  let survey: Uint8Array;
  let realise: { evalTile: (ir: unknown, key: string, h: unknown, o?: Record<string, unknown>) => { sha: string; count: number } };
  let surveyLib: { windowFromSurvey: (s: Uint8Array, key: string) => unknown };
  let keys: string[];

  beforeAll(async () => {
    const H = (await imp('test/plan-helpers.mjs')) as { flatSurvey: (t: unknown) => { bytes: Uint8Array; claim: unknown }; stewardAnchors: (c: unknown) => unknown; checkPlanVolumes: (p: unknown, o: unknown) => Promise<{ res: { ir: Ir; irJson: string; meta: unknown } }> };
    const fx = JSON.parse(fs.readFileSync(FX, 'utf8')) as { plan: unknown; terrain?: unknown; volume?: unknown };
    const s = H.flatSurvey(fx.terrain ?? {});
    const r = await H.checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: fx.volume ?? {} });
    ir = r.res.ir;
    irJson = r.res.irJson ?? JSON.stringify(ir);
    meta = r.res.meta;
    survey = new Uint8Array(new SharedArrayBuffer(s.bytes.length));
    survey.set(s.bytes);
    realise = (await imp('lib/realise.mjs')) as typeof realise;
    surveyLib = (await imp('lib/region/survey.mjs')) as typeof surveyLib;
    const c = ir.claim;
    keys = [];
    for (let tx = Math.floor(c.minX / 64); tx <= Math.floor(c.maxX / 64); tx++) for (let tz = Math.floor(c.minZ / 64); tz <= Math.floor(c.maxZ / 64); tz++) keys.push(`${tx},${tz}`);
    pool = new TilePool({ kitDir: KIT, size: 2, tileMs: 60_000, heapMb: 2048 });
  }, 600_000);
  afterAll(async () => {
    await pool?.close();
  });

  it("the plan meta marks the room's hollow and its entrance secret, by their IR part ids", () => {
    const hide = secretPartsOf(meta);
    expect(hide).toEqual(['f_vault', 'f_vault_door']);
    for (const id of hide) expect(ir.parts.some((p) => p.id === id && p.ops.length > 0)).toBe(true);
  });

  it('every ghost tile (every stage, and up to forms) equals evalTile of the IR with the room unwritten; the room was in the ghost before', async () => {
    const hide = secretPartsOf(meta);
    const hidden = { ...ir, parts: ir.parts.map((p) => (hide.includes(p.id) ? { ...p, ops: [] } : p)) };
    const upToForms = (x: Ir) => ({ ...x, parts: x.parts.filter((p) => x.stages.indexOf(p.stage) <= x.stages.indexOf('forms')) });
    const id = { id: 'sr-x01', bytes: () => survey };
    let differ = 0;
    for (const key of keys) {
      const w = surveyLib.windowFromSurvey(survey, key);
      for (const stage of [undefined, 'forms'] as const) {
        const [got, plain] = await Promise.all([
          pool.evaluate({ irSha: 'sr-x01', irJson: () => irJson, key, stage, set: undefined, survey: id, hide }),
          pool.evaluate({ irSha: 'sr-x01', irJson: () => irJson, key, stage, set: undefined, survey: id }),
        ]);
        expect(got.ok, JSON.stringify(got)).toBe(true);
        expect(plain.ok, JSON.stringify(plain)).toBe(true);
        if (!got.ok || !plain.ok) continue;
        const base = stage ? upToForms(hidden) : hidden;
        expect(got.sha).toBe(realise.evalTile(base, key, w).sha);
        expect(plain.sha).toBe(realise.evalTile(stage ? upToForms(ir) : ir, key, w).sha);
        if (got.sha !== plain.sha) differ++;
      }
    }
    expect(differ).toBeGreaterThan(0);
  }, 600_000);
});
