// (7b AF) site.analyse: the kit's site analysis over a frozen volume blob (api.Survey.site's helper half), the feature advertised,
// bad messages refused, the sha checked, and the answer equal to the kit's own over the same file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURES, parseClientMessage } from '../src/protocol.js';
import { SimDesigner } from '../src/sim.js';
import { arsv, makeSidecar, until, type Harness } from './helpers.js';

type Ack = { ok: boolean; error?: string; result?: Record<string, unknown> };
async function call(h: Harness, msg: Record<string, unknown>): Promise<Ack> {
  const parsed = parseClientMessage(JSON.stringify({ v: 1, id: 'q', ...msg }));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let ack: Ack | undefined;
  await h.sc.handle(parsed.msg, (m) => {
    if (m.type === 'ack') ack = { ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.result ? { result: m.result } : {}) };
  });
  return ack!;
}
const KIT = path.resolve(__dirname, '..', '..', 'kit');
const FIX = path.join(KIT, 'test', 'fixtures', 'site', 'cliff_face');

describe('site.analyse (7b AF)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim', '--kit', KIT]); // the real kit (the fixture kit has no site analysis)
    await h.sc.start(new SimDesigner(h.sc, 20));
  });
  afterAll(async () => {
    await h.close();
  });

  it('is a feature and a valid message; a bad fit or box is refused', () => {
    expect(FEATURES).toContain('site.analyse');
    const lot = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'site.analyse', volumeBlobId: 'b1', lot, fit: 'span' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'site.analyse', volumeBlobId: 'b1', lot, fit: 'hover' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'site.analyse', volumeBlobId: 'b1', lot: { ...lot, minX: 5 }, fit: 'span' })).ok).toBe(false);
  });

  it("answers the kit's analysis of the cliff fixture and its frame; a wrong sha or a missing blob is refused", async () => {
    const site = JSON.parse(fs.readFileSync(path.join(FIX, 'site.json'), 'utf8')) as { lot: Record<string, number>; fit: string; spec: { volumeSha: string; frame: unknown } };
    const bytes = fs.readFileSync(path.join(FIX, 'volume.bin'));
    const blobId = h.sc.blobs.put({ kind: 'region.volume', chunks: [bytes.toString('base64')] }).blobId;
    const a = await call(h, { type: 'site.analyse', volumeBlobId: blobId, sha: site.spec.volumeSha, lot: site.lot, fit: site.fit });
    expect(a.error).toBeUndefined();
    expect(a.result!.sha).toBe(site.spec.volumeSha);
    expect(a.result!.proposed).toMatchObject({ frame: site.spec.frame });
    const l = site.lot;
    const kit = spawnSync(process.execPath, [path.join(KIT, 'tools', 'affordances.mjs'), path.join(FIX, 'volume.bin'), '--lot', [l.minX, l.minY, l.minZ, l.maxX, l.maxY, l.maxZ].join(','), '--fit', site.fit], { encoding: 'utf8' });
    const k = JSON.parse(kit.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(a.result!.affordances).toEqual(k.affordances);
    expect((a.result!.affordances as Array<{ kind: string }>).some((x) => x.kind === 'cliff_face')).toBe(true);
    const bad = await call(h, { type: 'site.analyse', volumeBlobId: blobId, sha: '0'.repeat(64), lot: site.lot, fit: site.fit });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/hash to/);
    const gone = await call(h, { type: 'site.analyse', volumeBlobId: 'bnothere', lot: site.lot, fit: site.fit });
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/no blob/);
    const outside = await call(h, { type: 'site.analyse', volumeBlobId: blobId, lot: { ...site.lot, maxY: 400 }, fit: site.fit });
    expect(outside.ok).toBe(false);
    expect(outside.error).toMatch(/not inside the volume/);
  });

  it('(7b ST) standalone: the whole site spec beside the analysis when asked; a flat plot answers a reason; without it no member', async () => {
    expect(FEATURES).toContain('site.standalone');
    const site = JSON.parse(fs.readFileSync(path.join(FIX, 'site.json'), 'utf8')) as { lot: Record<string, number>; fit: string; spec: Record<string, unknown> };
    const blobId = h.sc.blobs.put({ kind: 'region.volume', chunks: [fs.readFileSync(path.join(FIX, 'volume.bin')).toString('base64')] }).blobId;
    const a = await call(h, { type: 'site.analyse', volumeBlobId: blobId, lot: site.lot, fit: site.fit, standalone: true });
    expect(a.error).toBeUndefined();
    const { lotId: _lot, ...want } = site.spec;
    expect(a.result!.standalone).toEqual({ ok: true, affordance: (a.result!.proposed as { affordance: string }).affordance, spec: want });
    const plain = await call(h, { type: 'site.analyse', volumeBlobId: blobId, lot: site.lot, fit: site.fit });
    expect(plain.result!.standalone).toBeUndefined();
    const grove = path.join(KIT, 'test', 'fixtures', 'site', 'grove');
    const g = JSON.parse(fs.readFileSync(path.join(grove, 'site.json'), 'utf8')) as { lot: Record<string, number> };
    const gb = h.sc.blobs.put({ kind: 'region.volume', chunks: [fs.readFileSync(path.join(grove, 'volume.bin')).toString('base64')] }).blobId;
    const flat = await call(h, { type: 'site.analyse', volumeBlobId: gb, lot: g.lot, fit: 'attach_to_cliff', standalone: true });
    expect(flat.ok).toBe(true);
    expect(flat.result!.standalone).toMatchObject({ ok: false });
    expect((flat.result!.standalone as { reason: string }).reason).toMatch(/no cliff face at the plot/);
  });

  it("a plan's affordances (plan.json's affordances[]) ride on region.planned; a plan without any has no member", async () => {
    const f = makeSidecar(['--backend', 'sim']); // the fixture kit's fake planner
    await f.sc.start(new SimDesigner(f.sc, 20));
    try {
      const survey = arsv(0, 0, 64, 64, () => 64);
      const blobId = f.sc.blobs.put({ kind: 'survey', chunks: [survey.toString('base64')] }).blobId;
      const claim = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };
      const aff = [{ id: 'pad_0123456789abcdef', kind: 'pad', box: { minX: 0, minY: 64, minZ: 0, maxX: 7, maxY: 64, maxZ: 7 }, anchors: [[4, 64, 4]], normal: null, metrics: { size: 8 }, score: 0.5 }];
      const planned = async (params: Record<string, unknown>) => {
        const ack = await call(f, { type: 'region.plan', program: 'fake_basic', params, claim, surveyBlobId: blobId });
        const planId = ack.result!.planId as string;
        await until(() => f.events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 120_000);
        return f.events.find((e) => e.type === 'region.planned' && e.planId === planId) as Record<string, unknown>;
      };
      expect((await planned({ affordances: aff })).affordances).toEqual(aff);
      expect('affordances' in (await planned({}))).toBe(false);
      await f.sc.regions.idle();
    } finally {
      await f.close();
    }
  });
});
