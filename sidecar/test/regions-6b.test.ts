// (6b) The sidecar half of phase 6b against the FAKE kit (test/fixtures/kit: tools/region.mjs plan/check/preview/catalogue,
// lib/realise.mjs with format-2 side blobs, lib/region/{plan,check,preview,survey}.mjs), on the sim backend (no Claude):
// the hello versions, plans with a report and previews (progress, limits, failures), region.check / region.preview, side
// blobs (registration, blob_unknown and the re-send, the cache), volumes, ghost tiles, and region.design (the template
// pick: pick, invalid then retry, NO_TEMPLATE with the closest program, requireFit, the budget stop, the plan it starts).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanParams, parseCatalogue, pickPrompt, surveySummary, validatePick, type CatalogueProgram } from '../src/regiondesign.js';
import { FEATURES, parseClientMessage, ServerMessage, toProtocol1, type Design, type Outbound, type Protocol } from '../src/protocol.js';
import { sha256, sideBlobs } from '../src/regions.js';
import type { ClientHandle } from '../src/server.js';
import { SimDesigner } from '../src/sim.js';
import { arsv, makeSidecar, tileHeights, until, type Harness } from './helpers.js';

// ---- helpers ----------------------------------------------------------------------------------------

interface FakeClient extends ClientHandle {
  sent: Outbound[];
  open: boolean;
}
let nextClient = 5000;
function fakeClient(protocol: Protocol = 2): FakeClient {
  const c: FakeClient = {
    id: nextClient++,
    name: 'mod',
    protocol,
    paused: false,
    open: true,
    sent: [],
    send(m) {
      if (c.open) c.sent.push(m);
    },
  };
  return c;
}

type Ack = { ok: boolean; error?: string; result?: Record<string, unknown> };
async function call(h: Harness, msg: Record<string, unknown>, client?: ClientHandle): Promise<Ack> {
  const parsed = parseClientMessage(JSON.stringify({ v: 1, id: 'q', ...msg }));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let ack: Ack | undefined;
  await h.sc.handle(parsed.msg, (m) => {
    if (m.type === 'ack') ack = { ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.result ? { result: m.result } : {}) };
  }, client);
  return ack!;
}

const CLAIM = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
const putSurvey = (h: Harness, b: Buffer = arsv(0, 0, 128, 128, (i, j) => 60 + ((i + j) % 7))) => h.sc.blobs.put({ kind: 'survey', chunks: [b.toString('base64')] }).blobId;

type Planned = Extract<Outbound, { type: 'region.planned' }>;
type Failed = Extract<Outbound, { type: 'region.failed' }>;
type TileMsg = Extract<Outbound, { type: 'region.tile' }>;
type TileErr = Extract<Outbound, { type: 'region.tile.error' }>;
type Progress = Extract<Outbound, { type: 'region.progress' }>;

async function plan(h: Harness, over: Record<string, unknown> = {}): Promise<{ ack: Ack; planned?: Planned; failed?: Failed; ms: number }> {
  const t0 = Date.now();
  const ack = await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: putSurvey(h), ...over });
  if (!ack.ok) return { ack, ms: Date.now() - t0 };
  const planId = ack.result!.planId as string;
  await until(() => h.events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && e.planId === planId), 60_000);
  const planned = h.events.find((e): e is Planned => e.type === 'region.planned' && e.planId === planId);
  const failed = h.events.find((e): e is Failed => e.type === 'region.failed' && e.planId === planId);
  return { ack, ...(planned ? { planned } : {}), ...(failed ? { failed } : {}), ms: Date.now() - t0 };
}

function tileDone(c: FakeClient, planId: string, n: number): Promise<void> {
  return until(() => c.sent.filter((m) => (m.type === 'region.tile' && !m.more && m.planId === planId) || (m.type === 'region.tile.error' && m.planId === planId)).length >= n, 20_000);
}
const frames = (c: FakeClient, planId: string) => c.sent.filter((m): m is TileMsg => m.type === 'region.tile' && m.planId === planId);
const tileErrors = (c: FakeClient, planId: string) => c.sent.filter((m): m is TileErr => m.type === 'region.tile.error' && m.planId === planId);
const tilesReq = (planId: string, irSha: string, keys: string[], extra: Record<string, unknown> = {}) => ({ type: 'region.tiles.request', planId, irSha, tiles: keys.map((key) => ({ key, stage: 'ground', set: 'terrain', heights: tileHeights(key) })), ...extra });

/** A gzip ARVX volume (kit/REGIONS.md "ARVX"): every column one run of ROCK. Its sha is of the UNCOMPRESSED bytes. */
function arvx(box = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 7, maxZ: 3 }): { raw: Buffer; gz: Buffer; sha: string; box: typeof box } {
  const parts: number[] = [...Buffer.from('ARVX', 'latin1'), 1, 0, 0, 0];
  const head = Buffer.alloc(24);
  [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ].forEach((v, i) => head.writeInt32LE(v, i * 4));
  parts.push(...head);
  const h = box.maxY - box.minY + 1;
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) parts.push(1, h);
  parts.push(0, 0);
  const raw = Buffer.from(parts);
  return { raw, gz: zlib.gzipSync(raw), sha: sha256(raw), box };
}

const SIDE = { hf: { kind: 'heightfield', text: 'ARBL a heightfield stand-in' }, mask: { kind: 'mask', text: 'ARBL a mask stand-in' } };

// ---- schemas ----------------------------------------------------------------------------------------

describe('6b region schemas', () => {
  const ok = (m: Record<string, unknown>, p: Protocol = 2) => parseClientMessage(JSON.stringify({ v: 1, ...m }), p).ok;
  const sha = 'a'.repeat(64);

  it('accepts the 6b client messages and refuses bad fields; protocol 1 has none of them', () => {
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 3, maxY: 3, maxZ: 3 };
    expect(ok({ type: 'region.plan', program: 'p', params: {}, claim: CLAIM, surveyBlobId: 'b1', check: false, volumes: [{ name: 'v', sha, blobId: 'b2', box }] })).toBe(true);
    expect(ok({ type: 'region.plan', program: 'p', params: {}, claim: CLAIM, surveyBlobId: 'b1', volumes: [{ sha: 'x', blobId: 'b2', box }] })).toBe(false);
    expect(ok({ type: 'region.plan', program: 'p', params: {}, claim: CLAIM, surveyBlobId: 'b1', volumes: [{ sha, blobId: 'b2', box: { ...box, maxX: -1 } }] })).toBe(false);
    expect(ok({ type: 'region.check', planId: 'p1' })).toBe(true);
    expect(ok({ type: 'region.check', planId: '../x' })).toBe(false);
    expect(ok({ type: 'region.preview', planId: 'p1' })).toBe(true);
    expect(ok({ type: 'region.preview', planId: 'p1', views: ['top', 'section'], axes: [[[0, 64, 0], [9, 64, 9]]] })).toBe(true);
    expect(ok({ type: 'region.preview', planId: 'p1', views: ['roof'] })).toBe(false);
    expect(ok({ type: 'region.preview', planId: 'p1', axes: [[[0, 64, 0]]] })).toBe(false);
    expect(ok({ type: 'region.preview', planId: 'p1', axes: Array.from({ length: 5 }, () => [[0, 0, 0], [1, 1, 1]]) })).toBe(false);
    // tiles: blobs and ghost tiles (no heights only with preview)
    const t = { type: 'region.tiles.request', planId: 'p1', irSha: sha, tiles: [{ key: '0,0', stage: 'ground', set: 'terrain', heights: 'QVJTVg==' }] };
    expect(ok({ ...t, blobs: { [sha]: 'b9' } })).toBe(true);
    expect(ok({ ...t, blobs: { nosha: 'b9' } })).toBe(false);
    expect(ok({ ...t, tiles: [{ key: '0,0' }] })).toBe(false);
    expect(ok({ ...t, preview: true, tiles: [{ key: '0,0' }] })).toBe(true);
    expect(ok({ ...t, preview: true, tiles: [{ key: '0,0', stage: 'ground' }] })).toBe(true);
    // the template pick
    const d = { type: 'region.design', brief: 'a repurposed meteor crater mining facility', card: { site: 'giant meteor crater', purpose: 'mining facility', style: 'hellish evil lair' }, claim: CLAIM, surveyBlobId: 'b1' };
    expect(ok(d)).toBe(true);
    expect(ok({ ...d, mustPass: ['M1', 'M2'], model: 'claude-sonnet-5-5', budgetUsd: 0.5, requireFit: true, plan: false, bible: 'medieval' })).toBe(true);
    expect(ok({ ...d, brief: '' })).toBe(false);
    expect(ok({ ...d, card: { site: 'x'.repeat(201) } })).toBe(false);
    expect(ok({ ...d, budgetUsd: -1 })).toBe(false);
    for (const m of [d, { type: 'region.check', planId: 'p1' }, { type: 'region.preview', planId: 'p1' }]) expect(ok(m, 1)).toBe(false);
  });

  it('validates the 6b outbound messages; protocol 1 never sees them', () => {
    const planned = { v: 1, type: 'region.planned', planId: 'p1', irSha: sha, ir: '{}', lots: [], stages: ['a'], anchors: {}, budget: {}, tiles: {}, notes: [], irFormat: 2, requires: ['blobs:side'], kitVersion: '0.12.0', blobs: [{ name: 'hf', sha, bytes: 3, kind: 'heightfield', blobId: 'b1' }], needVolumes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], report: { ok: true }, previews: { top: ['/x/top.png'] }, sitePlan: { format: 1 }, checkMs: 3, renderMs: 4 };
    expect(ServerMessage.safeParse(planned).success).toBe(true);
    expect(ServerMessage.safeParse({ v: 1, type: 'region.progress', planId: 'p1', phase: 'checking' }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: 1, type: 'region.progress', planId: 'p1', phase: 'done' }).success).toBe(false);
    const ghost = { v: 1, type: 'region.tile', planId: 'p1', key: '0,0', stage: '*', set: '*', preview: true, seq: 0, more: false, data: '', count: 0, sha };
    expect(ServerMessage.safeParse(ghost).success).toBe(true);
    for (const m of [planned, ghost, { v: 1, type: 'region.progress', planId: 'p1', phase: 'checking' }]) expect(toProtocol1(m)).toBeUndefined();
    expect(FEATURES).toEqual(expect.arrayContaining(['region.check', 'region.preview', 'region.design', 'region.blobs', 'ir.format2']));
  });
});

// ---- hello versions -----------------------------------------------------------------------------------

describe('the hello snapshot versions', () => {
  it("reports the kit's KIT_VERSION, IR_FORMATS and KINDS_FORMAT2 to protocol 2; protocol 1 sees none of it", async () => {
    const h = makeSidecar(['--backend', 'sim']);
    try {
      const s2 = h.sc.snapshot(2) as Record<string, unknown>;
      expect(s2).toMatchObject({ kitVersion: '0.12.0', irFormats: [1, 2], irKinds: expect.arrayContaining(['blobs:side', 'material:rule']) });
      expect(s2.features).toEqual(expect.arrayContaining(['region.check', 'region.preview', 'region.design', 'region.blobs', 'ir.format2']));
      expect(ServerMessage.safeParse({ v: 1, ...s2 }).success).toBe(true);
      const s1 = toProtocol1({ v: 1, ...(h.sc.snapshot(1) as Record<string, unknown>) })!;
      expect(s1).toBeDefined();
      for (const k of ['kitVersion', 'irFormats', 'irKinds', 'features']) expect(s1).not.toHaveProperty(k);
      // through the dispatcher, as a client sees it
      const replies: Outbound[] = [];
      const parsed = parseClientMessage(JSON.stringify({ v: 1, type: 'hello', protocols: [1, 2] }));
      if (!parsed.ok) throw new Error(parsed.error);
      await h.sc.handle(parsed.msg, (m) => replies.push(m), fakeClient());
      expect(replies.find((m) => m.type === 'snapshot')).toMatchObject({ kitVersion: '0.12.0', irFormats: [1, 2] });
    } finally {
      await h.close();
    }
  });

  it("an older kit (no KIT_VERSION, no IR_FORMATS): kitVersion 'unknown', irFormats [1], and a format-2 IR is refused", async () => {
    const h = makeSidecar(['--backend', 'sim']);
    try {
      fs.rmSync(path.join(h.cfg.kitDir, 'lib', 'region', 'plan.mjs'));
      const realise = path.join(h.cfg.kitDir, 'lib', 'realise.mjs');
      fs.writeFileSync(realise, fs.readFileSync(realise, 'utf8').replace(/export const IR_FORMATS[^\n]*\n/, '').replace(/export const KINDS_FORMAT2[^\n]*\n/, ''));
      expect(h.sc.snapshot(2)).toMatchObject({ kitVersion: 'unknown', irFormats: [1], irKinds: [] });
      await h.sc.start(new SimDesigner(h.sc, 20));
      const f2 = JSON.stringify({ format: 2, seed: '1' });
      const r = await call(h, { type: 'region.tiles.request', planId: 'pold', irSha: sha256(f2), ir: f2, tiles: [{ key: '0,0', stage: 'ground', set: 'terrain', heights: tileHeights('0,0') }] }, fakeClient());
      expect(r).toMatchObject({ ok: false, error: 'ir is not a Region IR (format 1)' });
    } finally {
      await h.close();
    }
  });
});

// ---- plans with a report and previews -------------------------------------------------------------------

describe('region.plan with the check and previews (fake kit)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
  });
  afterAll(async () => {
    await h.sc.regions.idle();
    await h.close();
  });

  it('runs check and then every preview after the plan: progress, report, previews, site plan, times, within the limits', async () => {
    const r = await plan(h, { seed: '5' });
    const p = r.planned!;
    expect(r.failed).toBeUndefined();
    const prog = h.events.filter((e): e is Progress => e.type === 'region.progress' && e.planId === p.planId).map((e) => e.phase);
    expect(prog).toEqual(['planning', 'checking', 'rendering']);
    // progress comes before planned
    expect(h.events.findIndex((e) => e.type === 'region.progress' && e.planId === p.planId && e.phase === 'rendering')).toBeLessThan(h.events.indexOf(p));
    expect(p).toMatchObject({ irFormat: 1, requires: [], kitVersion: 'fake', blobs: [], needVolumes: [] });
    expect(p.report).toMatchObject({ format: 1, mode: 'virtual', ok: true, errors: 0, warnings: 1, findings: [{ rule: 'M8' }] });
    expect(p.checkError).toBeUndefined();
    const dir = h.sc.regions.planDir(p.planId);
    expect(Object.keys(p.previews!).sort()).toEqual(['iso', 'section', 'siteplan', 'top']);
    for (const list of Object.values(p.previews!)) for (const f of list) {
      expect(path.isAbsolute(f)).toBe(true);
      expect(f.startsWith(fs.realpathSync(dir))).toBe(true);
      expect(fs.existsSync(f)).toBe(true);
    }
    expect(p.previews!.siteplan).toHaveLength(2);
    expect(p.sitePlan).toMatchObject({ format: 1, irSha: p.irSha, graph: { derived: true } });
    expect(p.checkMs).toBeGreaterThan(0);
    expect(p.renderMs).toBeGreaterThan(0);
    expect(p.checkMs! + p.renderMs!).toBeLessThan(h.cfg.regions.checkMs);
    expect(ServerMessage.safeParse({ v: 1, ...p }).success).toBe(true);
    for (const f of ['report.json', 'summary.txt', 'siteplan.json']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))).toMatchObject({ ok: true, irFormat: 1, checkMs: p.checkMs, renderMs: p.renderMs });
    console.log(`[numbers] fake plan + check + previews: ${r.ms} ms round trip (plan ${p.ms} ms, check ${p.checkMs} ms, render ${p.renderMs} ms)`);
  });

  it('check: false skips both (no report, no previews, no checking/rendering progress)', async () => {
    const r = await plan(h, { check: false });
    const p = r.planned!;
    expect(p.report).toBeUndefined();
    expect(p.previews).toBeUndefined();
    expect(p.checkMs).toBeUndefined();
    expect(h.events.filter((e): e is Progress => e.type === 'region.progress' && e.planId === p.planId).map((e) => e.phase)).toEqual(['planning']);
    expect(fs.existsSync(path.join(h.sc.regions.planDir(p.planId), 'report.json'))).toBe(false);
  });

  it('a failed or slow check is a checkError, not a failed plan; the previews still come when there is time', async () => {
    const bad = (await plan(h, { params: { fakeCheck: { fail: 'the checker broke' } } })).planned!;
    expect(bad.report).toBeUndefined();
    expect(bad.checkError).toMatch(/check: the checker broke/);
    expect(bad.previews?.top).toHaveLength(1);
    const saved = h.cfg.regions.checkMs;
    h.cfg.regions.checkMs = 800;
    try {
      const t0 = Date.now();
      const slow = (await plan(h, { params: { fakeCheck: { slowMs: 5000 } } })).planned!;
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(slow.report).toBeUndefined();
      expect(slow.checkError).toMatch(/check took longer than 0\.8 s/);
      // the check used the whole budget: no time left for the previews
      expect(slow.checkError).toMatch(/previews: no time was left/);
    } finally {
      h.cfg.regions.checkMs = saved;
    }
  });

  it('a check that runs out of memory is stopped by its heap cap', async () => {
    const saved = h.cfg.regions.checkHeapMb;
    h.cfg.regions.checkHeapMb = 64;
    try {
      const p = (await plan(h, { params: { fakeCheck: { hog: true } } })).planned!;
      expect(p.checkError).toMatch(/check ran out of memory \(64 MB heap\)/);
    } finally {
      h.cfg.regions.checkHeapMb = saved;
    }
  });

  it('a format-2 plan: side blobs checked, registered as region.blob blobs, passed to check and previews', async () => {
    const p = (await plan(h, { params: { sideBlobs: SIDE } })).planned!;
    expect(p).toMatchObject({ irFormat: 2, requires: ['blobs:side'] });
    expect(p.blobs!.map((b) => b.name).sort()).toEqual(['hf', 'mask']);
    for (const b of p.blobs!) {
      const want = Buffer.from(SIDE[b.name as keyof typeof SIDE].text);
      expect(b.sha).toBe(sha256(want));
      expect(b.bytes).toBe(want.length);
      expect(h.sc.blobs.get(b.blobId)).toMatchObject({ kind: 'region.blob', size: want.length });
      expect(h.sc.blobs.read(b.blobId).equals(want)).toBe(true);
      expect(fs.existsSync(path.join(h.sc.regions.planDir(p.planId), 'blobs', `${b.sha}.bin`))).toBe(true);
    }
    expect(p.report).toMatchObject({ metrics: { blobs: 2 } });
    expect(sideBlobs(JSON.parse(p.ir!) as Record<string, unknown>).map((b) => b.name).sort()).toEqual(['hf', 'mask']);
  });

  it('a side blob that does not hash to its name fails the plan', async () => {
    const r = await plan(h, { params: { sideBlobs: { hf: { kind: 'heightfield', text: 'abc', corrupt: true } } } });
    expect(r.planned).toBeUndefined();
    expect(r.failed!.message).toMatch(/side blob hf: blobs\/[0-9a-f]{12}\.bin hashes to/);
  });

  it('volumes: checked by the ARVX sha, copied into volumes/<sha>.bin, passed to the plan and the check; needVolumes passed on', async () => {
    const v = arvx();
    const blobId = h.sc.blobs.put({ kind: 'volume', chunks: [v.gz.toString('base64')] }).blobId;
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 15, maxY: 15, maxZ: 15 };
    const p = (await plan(h, { params: { showVolumes: true, needVolumes: [box] }, volumes: [{ name: 'cliff', sha: v.sha, blobId, box: v.box }] })).planned!;
    const dir = h.sc.regions.planDir(p.planId);
    expect(fs.readFileSync(path.join(dir, 'volumes', `${v.sha}.bin`)).equals(v.gz)).toBe(true);
    expect(p.notes).toContain(`volumes: ${v.sha}.bin`);
    expect(p.needVolumes).toEqual([box]);
    expect(p.report).toMatchObject({ metrics: { volumes: 1 } });
    // the sha is of the uncompressed ARVX: the gzip's sha is refused, so is a blob that is not ARVX
    expect((await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: putSurvey(h), volumes: [{ sha: sha256(v.gz), blobId, box: v.box }] })).error).toMatch(/ARVX hashes to [0-9a-f]{64}, not/);
    const notArvx = h.sc.blobs.put({ kind: 'volume', chunks: [zlib.gzipSync(Buffer.from('hello')).toString('base64')] }).blobId;
    expect((await call(h, { type: 'region.plan', program: 'fake_basic', params: {}, claim: CLAIM, surveyBlobId: putSurvey(h), volumes: [{ sha: v.sha, blobId: notArvx, box: v.box }] })).error).toMatch(/is not an ARVX file/);
  });

  it('an older kit without check/preview: the plan is planned with a checkError and no report', async () => {
    const o = makeSidecar(['--backend', 'sim']);
    try {
      fs.rmSync(path.join(o.cfg.kitDir, 'lib', 'region', 'check.mjs'));
      fs.rmSync(path.join(o.cfg.kitDir, 'lib', 'region', 'preview.mjs'));
      await o.sc.start(new SimDesigner(o.sc, 20));
      const p = (await plan(o)).planned!;
      expect(p.report).toBeUndefined();
      expect(p.checkError).toMatch(/no checker or previews/);
      expect(o.events.filter((e): e is Progress => e.type === 'region.progress' && e.planId === p.planId).map((e) => e.phase)).toEqual(['planning']);
      expect((await call(o, { type: 'region.check', planId: p.planId })).error).toMatch(/has no checker/);
    } finally {
      await o.sc.regions.idle();
      await o.close();
    }
  });
});

// ---- region.check, region.preview ---------------------------------------------------------------------

describe('region.check and region.preview (fake kit)', () => {
  let h: Harness;
  let p: Planned;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
    p = (await plan(h, { check: false, params: { sideBlobs: SIDE } })).planned!;
  });
  afterAll(async () => {
    await h.sc.regions.idle();
    await h.close();
  });

  it('region.check -> ack {report} from the plan dir (the IR, survey and side blobs there)', async () => {
    const a = await call(h, { type: 'region.check', planId: p.planId });
    expect(a.ok).toBe(true);
    expect(a.result!.report).toMatchObject({ format: 1, irSha: p.irSha, ok: true, warnings: 1, metrics: { blobs: 2 } });
    expect(JSON.parse(fs.readFileSync(path.join(h.sc.regions.planDir(p.planId), 'report.json'), 'utf8'))).toEqual(a.result!.report);
  });

  it('region.preview -> ack {paths, sitePlan}: all views by default; chosen views and section axes re-render on demand', async () => {
    const all = await call(h, { type: 'region.preview', planId: p.planId });
    expect(all.ok).toBe(true);
    expect(Object.keys(all.result!.paths as object).sort()).toEqual(['iso', 'section', 'siteplan', 'top']);
    expect(all.result!.sitePlan).toMatchObject({ format: 1, graph: { derived: true } });
    const some = await call(h, { type: 'region.preview', planId: p.planId, views: ['section', 'top'], axes: [[[0, 64, 0], [50, 64, 50]], [[0, 64, 60], [100, 64, 60]]] });
    expect(some.ok).toBe(true);
    const paths = some.result!.paths as Record<string, string[]>;
    expect(Object.keys(paths).sort()).toEqual(['section', 'top']);
    expect(paths.section).toHaveLength(2);
    expect(some.result!.sitePlan).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(h.sc.regions.planDir(p.planId), 'axes.json'), 'utf8'))).toHaveLength(2);
  });

  it('only paths inside the plan dir are handed on', async () => {
    const leak = (await plan(h, { check: false, params: { fakeCheck: { leakPath: '/etc/passwd' } } })).planned!;
    const a = await call(h, { type: 'region.preview', planId: leak.planId, views: ['top'] });
    expect((a.result!.paths as Record<string, string[]>).top).toEqual([path.join(fs.realpathSync(h.sc.regions.planDir(leak.planId)), 'previews', 'top.png')]);
  });

  it('refuses an unknown plan, a failed plan and a plan still running; a failing check is an error ack', async () => {
    expect((await call(h, { type: 'region.check', planId: 'pnosuch' })).error).toBe('no plan "pnosuch"');
    expect((await call(h, { type: 'region.preview', planId: 'pnosuch' })).error).toBe('no plan "pnosuch"');
    const f = await plan(h, { params: { throw: 'nope' } });
    expect((await call(h, { type: 'region.check', planId: f.failed!.planId })).error).toMatch(/has no IR \(it failed\)/);
    const ack = await call(h, { type: 'region.plan', program: 'fake_basic', params: { fakeCheck: { slowMs: 600 } }, claim: CLAIM, surveyBlobId: putSurvey(h) });
    const running = ack.result!.planId as string;
    expect((await call(h, { type: 'region.check', planId: running })).error).toMatch(/is still being planned/);
    await until(() => h.events.some((e) => e.type === 'region.planned' && e.planId === running), 20_000);
    const failing = (await plan(h, { check: false, params: { fakeCheck: { fail: 'checker exploded' } } })).planned!;
    expect((await call(h, { type: 'region.check', planId: failing.planId })).error).toBe('check: checker exploded');
  });

  it('concurrent check and preview of one plan run one after the other', async () => {
    const [a, b, c] = await Promise.all([call(h, { type: 'region.check', planId: p.planId }), call(h, { type: 'region.preview', planId: p.planId, views: ['top'] }), call(h, { type: 'region.check', planId: p.planId })]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
  });
});

// ---- side blobs on the tile path -------------------------------------------------------------------------

describe('side blobs on the tile path: blob_unknown and the re-send (fake kit)', () => {
  let h: Harness;
  let p: Planned;
  let fresh: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
    p = (await plan(h, { check: false, params: { sideBlobs: SIDE } })).planned!;
    fresh = makeSidecar(['--backend', 'sim']);
    await fresh.sc.start(new SimDesigner(fresh.sc, 20));
  });
  afterAll(async () => {
    await h.close();
    await fresh.close();
  });

  it('evaluates a format-2 IR with the plan dir blobs; the bytes reach the evaluator', async () => {
    const c = fakeClient();
    expect(await call(h, tilesReq(p.planId, p.irSha, ['0,0', '1,0']), c)).toMatchObject({ ok: true, result: { accepted: 2 } });
    await tileDone(c, p.planId, 2);
    expect(tileErrors(c, p.planId)).toEqual([]);
    expect(frames(c, p.planId).every((f) => f.preview === undefined && f.stage === 'ground' && f.set === 'terrain')).toBe(true);
  });

  it('a sidecar without the plan: ir_unknown, then blob_unknown <shas>, then the re-send with blobs works (same bytes); the cache keeps them', async () => {
    const c = fakeClient();
    const shas = p.blobs!.map((b) => b.sha).sort();
    // reference: the tile from the plan's own sidecar
    const ref = fakeClient();
    await call(h, tilesReq(p.planId, p.irSha, ['2,1']), ref);
    await tileDone(ref, p.planId, 1);
    const refSha = frames(ref, p.planId)[0]!.sha;

    expect(await call(fresh, tilesReq(p.planId, p.irSha, ['2,1']), c)).toMatchObject({ ok: false, error: 'ir_unknown' });
    const withIr = await call(fresh, tilesReq(p.planId, p.irSha, ['2,1'], { ir: p.ir }), c);
    expect(withIr.ok).toBe(false);
    expect(withIr.error!.startsWith('blob_unknown ')).toBe(true);
    expect(withIr.error!.slice('blob_unknown '.length).split(',').sort()).toEqual(shas);
    // the IR is known now: the next request needs only the blobs
    expect((await call(fresh, tilesReq(p.planId, p.irSha, ['2,1']), c)).error).toMatch(/^blob_unknown /);
    // a wrong upload is refused by its sha
    const wrong = fresh.sc.blobs.put({ kind: 'region.blob', chunks: [Buffer.from('not it').toString('base64')] }).blobId;
    expect((await call(fresh, tilesReq(p.planId, p.irSha, ['2,1'], { blobs: { [shas[0]!]: wrong } }), c)).error).toMatch(/hashes to [0-9a-f]{64}, not/);
    // only one of two: still blob_unknown, naming the other
    const ids = Object.fromEntries(p.blobs!.map((b) => [b.sha, fresh.sc.blobs.put({ kind: 'region.blob', chunks: [h.sc.blobs.read(b.blobId).toString('base64')] }).blobId]));
    const one = await call(fresh, tilesReq(p.planId, p.irSha, ['2,1'], { blobs: { [shas[0]!]: ids[shas[0]!] } }), c);
    expect(one.error).toBe(`blob_unknown ${shas[1]}`);
    // the re-send
    expect(await call(fresh, tilesReq(p.planId, p.irSha, ['2,1'], { blobs: ids }), c)).toMatchObject({ ok: true, result: { accepted: 1 } });
    await tileDone(c, p.planId, 1);
    expect(tileErrors(c, p.planId)).toEqual([]);
    expect(frames(c, p.planId)[0]!.sha).toBe(refSha);
    for (const s of shas) expect(fs.existsSync(path.join(fresh.sc.regions.blobCacheDir(), `${s}.bin`))).toBe(true);
    // released and asked again (a new plan id, the IR with it): the blob cache answers, no blobs needed
    fresh.sc.regions.release(p.planId, undefined);
    const again = fakeClient();
    expect(await call(fresh, tilesReq('pother', p.irSha, ['2,1'], { ir: p.ir }), again)).toMatchObject({ ok: true });
    await tileDone(again, 'pother', 1);
    expect(frames(again, 'pother')[0]!.sha).toBe(refSha);
  });

  it('region.release with evict forgets an IR another plan shares (dev.region.drop: the next request meets ir_unknown)', async () => {
    const q = (await plan(h, { check: false })).planned!;
    const c = fakeClient();
    // a second plan id holding the same IR (an earlier run's plan of the same program and survey)
    expect((await call(h, tilesReq('pshared', q.irSha, ['0,0'], { ir: q.ir }), c)).ok).toBe(true);
    await tileDone(c, 'pshared', 1);
    fs.rmSync(h.sc.regions.planDir(q.planId), { recursive: true, force: true });
    h.sc.regions.release(q.planId, undefined); // without evict the shared IR stays cached
    expect((await call(h, tilesReq(q.planId, q.irSha, ['1,1']), c)).ok).toBe(true);
    await tileDone(c, q.planId, 1);
    h.sc.regions.release(q.planId, undefined, true);
    expect(await call(h, tilesReq(q.planId, q.irSha, ['1,0']), c)).toMatchObject({ ok: false, error: 'ir_unknown' });
  });

  it('a blob file deleted from the plan dir is found missing on the next request', async () => {
    const q = (await plan(h, { check: false, params: { sideBlobs: { only: { kind: 'mask', text: 'a lone mask' } } } })).planned!;
    const c = fakeClient();
    expect((await call(h, tilesReq(q.planId, q.irSha, ['0,0']), c)).ok).toBe(true);
    await tileDone(c, q.planId, 1);
    const sha = q.blobs![0]!.sha;
    fs.rmSync(path.join(h.sc.regions.planDir(q.planId), 'blobs', `${sha}.bin`));
    expect((await call(h, tilesReq(q.planId, q.irSha, ['1,1']), c)).error).toBe(`blob_unknown ${sha}`);
  });
});

// ---- ghost tiles ---------------------------------------------------------------------------------------

describe('ghost tiles (region.tiles.request preview: true)', () => {
  let h: Harness;
  let p: Planned;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    await h.sc.start(new SimDesigner(h.sc, 20));
    p = (await plan(h, { check: false, params: { stages: ['ground', 'ways', 'lots-1'], parts: [{ id: 'pit', stage: 'ground' }, { id: 'steps', stage: 'ways', set: 'path' }, { id: 'pads', stage: 'lots-1' }], sideBlobs: { hf: SIDE.hf } } })).planned!;
  });
  afterAll(async () => {
    await h.close();
  });

  const ghost = (keys: Array<Record<string, unknown>>) => ({ type: 'region.tiles.request', planId: p.planId, irSha: p.irSha, preview: true, tiles: keys });

  it('evaluates over the plan survey with no heights; frames carry preview: true, "*" for every stage / both sets', async () => {
    const c = fakeClient();
    expect(await call(h, ghost([{ key: '0,0' }, { key: '1,0', stage: 'ways' }, { key: '1,1', stage: 'ground', set: 'terrain' }]), c)).toMatchObject({ ok: true, result: { accepted: 3 } });
    await tileDone(c, p.planId, 3);
    expect(tileErrors(c, p.planId)).toEqual([]);
    const f = frames(c, p.planId);
    expect(f.every((x) => x.preview === true)).toBe(true);
    expect(f.map((x) => `${x.key}|${x.stage}|${x.set}`).sort()).toEqual(['0,0|*|*', '1,0|ways|*', '1,1|ground|terrain']);
    for (const x of f) expect(ServerMessage.safeParse({ v: 1, ...x }).success).toBe(true);
  });

  it('every stage up to the requested one: deterministic, and different stages give different cells', async () => {
    const c = fakeClient();
    await call(h, ghost([{ key: '0,0', stage: 'ground' }, { key: '0,0', stage: 'ways' }, { key: '0,0', stage: 'lots-1' }, { key: '0,0' }]), c);
    await tileDone(c, p.planId, 4);
    const by = (stage: string) => frames(c, p.planId).find((x) => x.stage === stage)!.sha;
    expect(new Set([by('ground'), by('ways'), by('lots-1')]).size).toBe(3);
    // all stages = up to the last one
    expect(by('*')).toBe(by('lots-1'));
    const d = fakeClient();
    await call(h, ghost([{ key: '0,0', stage: 'ways' }]), d);
    await tileDone(d, p.planId, 1);
    expect(frames(d, p.planId)[0]!.sha).toBe(by('ways'));
  });

  it('an unknown stage fails the tile; a plan dir without its survey refuses the request', async () => {
    const c = fakeClient();
    await call(h, ghost([{ key: '0,0', stage: 'nope' }]), c);
    await tileDone(c, p.planId, 1);
    expect(tileErrors(c, p.planId)[0]).toMatchObject({ preview: true, stage: 'nope', message: "the IR has no stage 'nope'" });
    const q = (await plan(h, { check: false })).planned!;
    fs.rmSync(path.join(h.sc.regions.planDir(q.planId), 'survey.bin'));
    expect((await call(h, { ...ghost([{ key: '0,0' }]), planId: q.planId, irSha: q.irSha }, fakeClient())).error).toMatch(/has no survey/);
  });
});

// ---- region.design: units --------------------------------------------------------------------------------

const PROGRAMS: CatalogueProgram[] = parseCatalogue({
  programs: [
    { id: 'crater_works', description: 'crater', params: { radius: { type: 'int', min: 40, max: 160, default: 80 }, lit: { type: 'bool', default: true }, lining: { type: 'enum', options: ['rock', 'brick'], default: 'rock' } }, needs: { minFlat: 0.5 }, claim: { min: [96, 96], max: [400, 400] } },
    { id: 'rift_city', description: 'rift', params: {} },
    { bad: true },
  ],
});

describe('region.design units: catalogue, validation, survey summary, prompt', () => {
  it('parses the catalogue and validates picks (unknown program or param, type, range, claim range)', () => {
    expect(PROGRAMS.map((p) => p.id)).toEqual(['crater_works', 'rift_city']);
    const v = (a: Record<string, unknown>, size: [number, number] = [128, 128]) => validatePick({ fits: true, reason: 'ok', params: {}, ...a }, PROGRAMS, size);
    expect(v({ program: 'crater_works', params: { radius: 100, lit: false, lining: 'brick' } })).toEqual([]);
    expect(v({ program: 'cottage' })[0]).toMatch(/not in the catalogue \(crater_works, rift_city\)/);
    expect(v({ program: 'crater_works', params: { radius: 300 } })).toEqual(['radius must be 40..160 (got 300)']);
    expect(v({ program: 'crater_works', params: { radius: 50.5 } })).toEqual(['radius must be an integer (got 50.5)']);
    expect(v({ program: 'crater_works', params: { lit: 'yes' } })).toEqual(['lit must be true or false (got "yes")']);
    expect(v({ program: 'crater_works', params: { lining: 'gold' } })).toEqual(['lining must be one of rock, brick (got "gold")']);
    expect(v({ program: 'crater_works', params: { size: 3 } })[0]).toMatch(/has no param "size"/);
    expect(v({ program: 'crater_works' }, [64, 64])[0]).toMatch(/takes a claim of 96x96 to 400x400 columns; this claim is 64x64/);
    // either way round
    const long = parseCatalogue({ programs: [{ id: 'rift', description: 'r', params: {}, claim: { min: [64, 96], max: [128, 400] } }] });
    expect(validatePick({ fits: true, program: 'rift', params: {}, reason: 'x' }, long, [64, 300])).toEqual([]);
    expect(validatePick({ fits: true, program: 'rift', params: {}, reason: 'x' }, long, [300, 64])).toEqual([]);
    expect(validatePick({ fits: true, program: 'rift', params: {}, reason: 'x' }, long, [300, 300])[0]).toMatch(/this claim is 300x300/);
    expect(validatePick({ fits: false, program: 'crater_works', params: {}, reason: 'no' }, PROGRAMS, [64, 64])).toEqual([]);
    expect(validatePick('nope', PROGRAMS, [1, 1])).toEqual(['the answer is not an object']);
    expect(cleanParams({ radius: 300, lit: false, size: 1 }, PROGRAMS[0])).toEqual({ lit: false });
  });

  it("summarises an ARSV survey as 4a's Sample.summary() does: stats and an ASCII grid of at most 64x64", () => {
    const b = arsv(100, 200, 256, 128, (i, j) => (i < 32 ? 70 : 60 + (j % 10)), 1);
    const n = 256 * 128;
    // water in one corner, trees in another, one missing column
    for (let k = 0; k < 8; k++) b[28 + n * 6 + k] = 1;
    b[28 + n * 6 + n - 1] = 4;
    b[28 + n * 6 + 300] = 2;
    const s = surveySummary(b);
    const lines = s.trimEnd().split('\n');
    expect(lines[0]).toBe('survey x 100..355, z 200..327, resolution 1: 256x128 columns, 1 missing');
    expect(lines[1]).toMatch(/^height 60\.\.70, mean \d+\.\d; water 0%, trees 0%, lava 0%$/);
    expect(lines[2]).toMatch(/^slope \(largest ground step to a neighbouring sample, 1 block apart\): median \d+, 90th percentile \d+, max \d+; flat \(step <= 1\) \d+%$/);
    expect(lines[3]).toBe('height grid (1 char = 4 sample columns; 0 = y 60, 9 = y 70; ~ water, T trees, L lava, ? missing):');
    const grid = lines.slice(4);
    expect(grid).toHaveLength(32);
    expect(grid.every((r) => r.length === 64 && /^[0-9~TL?]+$/.test(r))).toBe(true);
    expect(grid[0]![0]).toBe('~');
    expect(grid[0]![10]).toMatch(/[0-9]/);
    expect(() => surveySummary(Buffer.from('nope'))).toThrow(/not an ARSV/);
    const coarse = surveySummary(arsv(0, 0, 50, 40, () => 64, 4));
    expect(coarse.split('\n')[0]).toBe('survey x 0..196, z 0..156, resolution 4: 50x40 columns, 0 missing');
    expect(coarse).toContain('height grid (1 char = 1 sample column; 0 = y 64, 9 = y 64');
  });

  it('the prompt carries the brief, the card fields as written, the claim, the roles, the rules, the survey and the catalogue', () => {
    const pr = pickPrompt({ brief: 'repurposed giant meteor crater mining facility, hellish evil lair', card: { site: 'giant meteor crater', purpose: 'mining facility', style: 'hellish evil lair' }, claim: CLAIM, summary: 'survey x 0..127\nheight grid:\n000\n', roles: ['rock', 'scorched'], bible: 'lair v2', mustPass: ['M1', 'M2'], programs: PROGRAMS });
    for (const s of ['brief: repurposed giant meteor crater', '  site: giant meteor crater', '  purpose: mining facility', '  style: hellish evil lair', 'x 0..127, z 0..127 (128x128 columns), y -64..319', 'lair v2; roles: rock, scorched', 'must pass checker rules: M1, M2', 'height grid:', '- crater_works: crater', 'radius: integer 40..160, default 80', 'lining: one of rock, brick', 'claim: 96x96 to 400x400 columns', '- rift_city: rift'])
      expect(pr).toContain(s);
  });
});

// ---- region.design on the sim backend --------------------------------------------------------------------

describe('region.design on the sim backend (the template pick)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim']);
    h.cfg.simStepMs = 10;
    await h.sc.start(new SimDesigner(h.sc, 10));
  });
  afterAll(async () => {
    await h.sc.regions.idle();
    await h.close();
  });

  const design = (over: Record<string, unknown> = {}) => call(h, { type: 'region.design', brief: 'a repurposed meteor crater mining facility', card: { site: 'giant meteor crater', purpose: 'mining facility', style: 'hellish evil lair' }, claim: CLAIM, surveyBlobId: putSurvey(h), ...over });
  const final = async (id: string): Promise<Design> => {
    await until(() => ['done', 'failed', 'cancelled'].includes(h.sc.designs.get(id)?.status ?? ''), 20_000);
    return h.sc.designs.get(id)!;
  };
  const sim = (...answers: unknown[]) => ({ ext: { 'architect:simAnswers': answers } });
  const jobsOf = (d: Design) => ((d.region as { tries: Array<{ jobId: string }> }).tries ?? []).map((t) => h.sc.jobs.book.get(t.jobId)!);

  it('PICKED: one structured job with the schema; the result, cost and design kind region; no plan with plan: false', async () => {
    const a = await design({ plan: false, ...sim({ fits: true, program: 'crater_works', params: { radius: 60, depth: 20 }, reason: 'a crater facility is what crater_works builds' }) });
    expect(a.ok).toBe(true);
    const d = await final(a.result!.designId as string);
    expect(d).toMatchObject({ kind: 'region', status: 'done' });
    expect(d.result).toEqual({ outcome: 'PICKED', fits: true, program: 'crater_works', params: { radius: 60, depth: 20 }, reason: 'a crater facility is what crater_works builds', cost: 0.01, tries: 1 });
    expect(d.cost?.usd).toBe(0.01);
    const [j] = jobsOf(d);
    expect(j).toMatchObject({ status: 'done', spec: { kind: 'structured', owner: 'architect:region.design' } });
    const spec = j!.spec as { schema: { required: string[]; properties: { program: { enum: string[] } } }; prompt: string; model: string };
    expect(spec.schema.required).toEqual(['fits', 'program', 'params', 'reason']);
    expect(spec.schema.properties.program.enum).toEqual(['crater_works', 'rift_city', 'fake_basic']);
    expect(spec.model).toBe(h.cfg.jobs.model);
    // the upserts a protocol-2 client gets validate; protocol 1 never sees a region design
    const ups = h.events.filter((e) => e.type === 'design.upsert' && e.design.id === d.id);
    expect(ups.length).toBeGreaterThan(1);
    for (const u of ups) {
      expect(ServerMessage.safeParse({ v: 1, ...u }).success).toBe(true);
      expect(toProtocol1({ v: 1, ...(u as Record<string, unknown>) })).toBeUndefined();
    }
  });

  it('the job prompt carries the card fields and the survey summary; the model override applies', async () => {
    const a = await design({ plan: false, model: 'claude-haiku-5', ...sim({ fits: false, program: 'rift_city', params: {}, reason: 'no' }) });
    const d = await final(a.result!.designId as string);
    const spec = jobsOf(d)[0]!.spec as { prompt: string; model: string };
    expect(spec.model).toBe('claude-haiku-5');
    // (the job record keeps the prompt cut at 2000 chars)
    expect(spec.prompt).toContain('site: giant meteor crater');
    expect(spec.prompt).toContain('style: hellish evil lair');
    expect(spec.prompt).toContain('## Claim');
  });

  it('PICKED and planned: the sidecar starts region.plan with the program and params over the same survey and claim', async () => {
    const a = await design(sim({ fits: true, program: 'fake_basic', params: {}, reason: 'test' }));
    const d = await final(a.result!.designId as string);
    expect(d.status).toBe('done');
    const planId = d.result!.planId as string;
    expect(planId).toMatch(/^p/);
    await until(() => h.events.some((e) => e.type === 'region.planned' && e.planId === planId), 20_000);
    const req = JSON.parse(fs.readFileSync(path.join(h.sc.regions.planDir(planId), 'request.json'), 'utf8')) as Record<string, unknown>;
    expect(req).toMatchObject({ program: 'fake_basic', claim: CLAIM, surveyBlobId: (d.region as { surveyBlobId: string }).surveyBlobId, check: true });
  });

  it('an invalid pick gets one retry with the validation errors, then PICKED (2 tries, both costs)', async () => {
    const a = await design({ plan: false, ...sim({ fits: true, program: 'crater_works', params: { radius: 999 }, reason: 'big' }, { fits: true, program: 'crater_works', params: { radius: 150 }, reason: 'big but valid' }) });
    const d = await final(a.result!.designId as string);
    expect(d.result).toMatchObject({ outcome: 'PICKED', program: 'crater_works', params: { radius: 150 }, tries: 2, cost: 0.02 });
    const [, retry] = jobsOf(d);
    expect((retry!.spec as { prompt: string }).prompt.length).toBeGreaterThan(0);
    const tries = (d.region as { tries: Array<{ errors: string[] }> }).tries;
    expect(tries[0]!.errors).toEqual(['radius must be 40..160 (got 999)']);
    expect(tries[1]!.errors).toEqual([]);
  });

  it('two invalid picks: NO_TEMPLATE, still offering the closest program with its valid params', async () => {
    const bad = { fits: true, program: 'crater_works', params: { radius: 999, depth: 20 }, reason: 'too big' };
    const d = await final((await design({ plan: false, ...sim(bad, bad) })).result!.designId as string);
    expect(d.status).toBe('done');
    expect(d.result).toMatchObject({ outcome: 'NO_TEMPLATE', fits: false, program: 'crater_works', params: { depth: 20 }, tries: 2, cost: 0.02 });
    expect(d.result!.reason).toMatch(/no valid pick after 2 tries \(radius must be 40\.\.160 \(got 999\)\); the model said: too big/);
  });

  it('NO_TEMPLATE with the closest program and the reason (S-6b-3); requireFit makes it a failed design', async () => {
    const no = { fits: false, program: 'rift_city', params: { width: 20 }, reason: 'a cozy cottage is one building, not a site' };
    const d = await final((await design({ brief: 'a cozy two-room cottage', ...sim(no) })).result!.designId as string);
    expect(d.status).toBe('done');
    expect(d.result).toEqual({ outcome: 'NO_TEMPLATE', fits: false, program: 'rift_city', params: { width: 20 }, reason: no.reason, cost: 0.01, tries: 1 });
    expect(d.result!.planId).toBeUndefined();
    const r = await final((await design({ brief: 'a cozy two-room cottage', requireFit: true, ...sim(no) })).result!.designId as string);
    expect(r).toMatchObject({ status: 'failed', error: `NO_TEMPLATE: ${no.reason}`, result: { outcome: 'NO_TEMPLATE', program: 'rift_city' } });
  });

  it('a fit outside the program claim range is invalid (and retried)', async () => {
    const small = { ...CLAIM, maxX: 63, maxZ: 63 };
    const d = await final((await design({ claim: small, plan: false, ...sim({ fits: true, program: 'crater_works', params: {}, reason: 'x' }, { fits: false, program: 'crater_works', params: {}, reason: 'the claim is too small' }) })).result!.designId as string);
    expect(d.result).toMatchObject({ outcome: 'NO_TEMPLATE', program: 'crater_works', tries: 2, reason: 'the claim is too small' });
  });

  it('the budget stop: the retry gets what is left; nothing left fails "budget" with the cost recorded', async () => {
    const bad = { fits: true, program: 'crater_works', params: { radius: 1 }, reason: 'x' };
    // $0.01 spent by try 1, nothing left for try 2
    const a = await final((await design({ budgetUsd: 0.01, plan: false, ...sim(bad, bad) })).result!.designId as string);
    expect(a).toMatchObject({ status: 'failed', error: 'budget' });
    expect(a.cost?.usd).toBe(0.01);
    expect(jobsOf(a)).toHaveLength(1);
    // $0.005 left: try 2 starts with budgetUsd 0.005 and the sim stops it
    const b = await final((await design({ budgetUsd: 0.015, plan: false, ...sim(bad, bad) })).result!.designId as string);
    expect(b).toMatchObject({ status: 'failed', error: 'budget' });
    const js = jobsOf(b);
    expect(js).toHaveLength(2);
    expect((js[1]!.spec as { budgetUsd: number }).budgetUsd).toBe(0.005);
    expect(js[1]).toMatchObject({ status: 'failed', error: 'budget' });
    expect(b.cost?.usd).toBe(0.02);
  });

  it('a pick job that fails fails the design; refusals: a bad survey blob, an unknown bible', async () => {
    const d = await final((await design({ plan: false, ...sim({ simFail: 'the model fell over' }) })).result!.designId as string);
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/the pick failed: .*the model fell over/);
    const notArsv = h.sc.blobs.put({ kind: 'survey', data: { not: 'arsv' } }).blobId;
    expect((await design({ surveyBlobId: notArsv })).error).toMatch(/not an ARSV buffer/);
    expect((await design({ bible: 'no_such_bible' })).error).toMatch(/no bible "no_such_bible"/);
  });

  it('a picked program the kit cannot plan fails the design with the result kept', async () => {
    const d = await final((await design(sim({ fits: true, program: 'crater_works', params: {}, reason: 'x' }))).result!.designId as string);
    expect(d).toMatchObject({ status: 'failed', result: { outcome: 'PICKED', program: 'crater_works' } });
    expect(d.error).toMatch(/picked crater_works, but the plan did not start: no bundled region program "crater_works"/);
  });

  it('design.cancel stops the pick and its job', async () => {
    const slow = makeSidecar(['--backend', 'sim']);
    slow.cfg.simStepMs = 5000;
    await slow.sc.start(new SimDesigner(slow.sc, 10));
    try {
      const a = await call(slow, { type: 'region.design', brief: 'a rift settlement', claim: CLAIM, surveyBlobId: putSurvey(slow), plan: false });
      const id = a.result!.designId as string;
      await until(() => ((slow.sc.designs.get(id)!.region as { tries: unknown[] }).tries ?? []).length === 1);
      expect(await call(slow, { type: 'design.cancel', designId: id })).toMatchObject({ ok: true });
      expect(slow.sc.designs.get(id)!.status).toBe('cancelled');
      const jobId = (slow.sc.designs.get(id)!.region as { tries: Array<{ jobId: string }> }).tries[0]!.jobId;
      await until(() => slow.sc.jobs.book.get(jobId)!.status === 'cancelled');
    } finally {
      await slow.close();
    }
  });
});

describe('region.design after a restart', () => {
  it('an unfinished pick carries on from its record (the running try is waited for)', async () => {
    const h = makeSidecar(['--backend', 'sim']);
    h.cfg.simStepMs = 300;
    await h.sc.start(new SimDesigner(h.sc, 10));
    const a = await call(h, { type: 'region.design', brief: 'a rift settlement', card: { site: 'rift', purpose: 'settlement' }, claim: CLAIM, surveyBlobId: putSurvey(h), plan: false, ext: { 'architect:simAnswers': [{ fits: false, program: 'rift_city', params: {}, reason: 'r' }] } });
    const id = a.result!.designId as string;
    await until(() => ((h.sc.designs.get(id)!.region as { tries: unknown[] }).tries ?? []).length === 1);
    // a restart: the same data dir, a new sidecar
    const { Sidecar } = await import('../src/sidecar.js');
    const { Store } = await import('../src/store.js');
    const { memoryLogger } = await import('../src/context.js');
    await h.sc.close();
    const store = new Store(h.cfg.dataDir, { debounceMs: 5 });
    const sc2 = new Sidecar(h.cfg, store, memoryLogger());
    h.cfg.simStepMs = 10;
    await sc2.start(new SimDesigner(sc2, 10));
    try {
      await until(() => ['done', 'failed'].includes(sc2.designs.get(id)?.status ?? ''), 20_000);
      const d = sc2.designs.get(id)!;
      expect(d).toMatchObject({ status: 'done', result: { outcome: 'NO_TEMPLATE', program: 'rift_city' } });
      expect((d.region as { tries: unknown[] }).tries).toHaveLength(1);
    } finally {
      await sc2.close();
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });
});
