// (6c close-out A, §3) region.plan.discard: the plan's dir removed (idempotent), the feature advertised, bad ids refused.
import fs from 'node:fs';
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
const CLAIM = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };

describe('region.plan.discard (6c close-out A)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
  });
  afterAll(async () => {
    await h.sc.regions.idle();
    await h.close();
  });

  it('is a feature and a valid message; a bad plan id is refused', () => {
    expect(FEATURES).toContain('region.planDiscard');
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'region.plan.discard', planId: 'p1' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'region.plan.discard', planId: '../x' })).ok).toBe(false);
  });

  it('removes a finished plan dir, then answers existed false', async () => {
    const survey = arsv(0, 0, 128, 128, (i, j) => 60 + ((i + j) % 7));
    const blobId = h.sc.blobs.put({ kind: 'survey', chunks: [survey.toString('base64')] }).blobId;
    const ack = await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: blobId });
    expect(ack.ok).toBe(true);
    const planId = ack.result!.planId as string;
    await until(() => h.events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 60_000);
    await h.sc.regions.idle();
    const dir = h.sc.regions.planDir(planId);
    expect(fs.existsSync(dir)).toBe(true);
    const d1 = await call(h, { type: 'region.plan.discard', planId });
    expect(d1).toMatchObject({ ok: true, result: { planId, existed: true } });
    expect(fs.existsSync(dir)).toBe(false);
    const d2 = await call(h, { type: 'region.plan.discard', planId });
    expect(d2).toMatchObject({ ok: true, result: { planId, existed: false } });
  });
});
