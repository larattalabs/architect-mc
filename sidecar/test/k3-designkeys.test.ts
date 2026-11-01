// Phase 7a slice K3, the API asks Steward's RC depends on (docs/CONTRACT.md "Phase 7a slice K3 as built", the design.opKeys row):
// design.request's opKey (adopt, conflict, owner scope, on disk at the ack, versionOf adopted and never busy, found by design.byKey
// once final, after a restart and past the 100-design trim, kept 30 days), and design.cancelConfirm's three outcomes (a running
// design: cancelled only once its turn has stopped, with the final cost; a retry answers cancelled again).
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDesigner } from '../src/claude/designer.js';
import { loadConfig, type Config } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { DesignBook } from '../src/designs.js';
import { bodyHash, designKeyBody, OP_KEY_KEEP_MS } from '../src/opkeys.js';
import { DesignRequest, type Design, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { makeSidecar, request, rmrf, SIDECAR_ROOT, tempDir, until, type Harness } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'tools', 'diff.mjs'));

interface H {
  root: string;
  sc: Sidecar;
  events: Outbound[];
  close(keep?: boolean): Promise<void>;
}

async function harness(over: Partial<Config> = {}, root = tempDir('arch-k3-keys-')): Promise<H> {
  const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
  cfg.simStepMs = 15;
  Object.assign(cfg, over);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
  const events: Outbound[] = [];
  sc.subscribe((m) => events.push(m));
  await sc.start(new SimDesigner(sc, cfg.simStepMs));
  return {
    root,
    sc,
    events,
    close: async (keep = false) => {
      await sc.close();
      if (!keep) rmrf(root);
    },
  };
}

type Ack = { ok: boolean; error?: string; result?: Record<string, unknown> };
let n = 0;
function send(sc: Sidecar, msg: Record<string, unknown>): Promise<Ack> {
  const id = `k${++n}`;
  return new Promise((res) => {
    void sc.handle({ v: 1, id, ...msg } as never, (m) => {
      if (m.type === 'ack' && m.re === id) res(m as never);
    });
  });
}

const final = (sc: Sidecar, id: string) => until(() => ['done', 'failed', 'cancelled'].includes(sc.designs.get(id)!.status), 60_000);
const designs = (sc: Sidecar) => sc.designs.list().length;
const keyed = (over: Record<string, unknown> = {}) => request({ owner: 'steward:s1', opKey: 'st:design:1', ...over });

describe('design opKeys: the body', () => {
  it('ignores the versionOf site blobs and baseVersion (a mod retry uploads them again under new ids), nothing else', () => {
    const a = { ...request(), opKey: 'k', versionOf: { entryId: 'gen_inn', siteId: 's1', siteNow: 'b1', siteEdits: 'b2' } };
    const b = { ...request(), opKey: 'k', versionOf: { entryId: 'gen_inn', siteId: 's1', siteNow: 'b9', siteEdits: 'b8', baseVersion: 3 } };
    expect(bodyHash(designKeyBody(a))).toBe(bodyHash(designKeyBody(b)));
    expect(bodyHash(designKeyBody({ ...a, versionOf: { ...a.versionOf, siteId: 's2' } }))).not.toBe(bodyHash(designKeyBody(a)));
    expect(bodyHash(designKeyBody({ ...a, notes: 'other' }))).not.toBe(bodyHash(designKeyBody(a)));
    expect(designKeyBody(request())).toEqual(request());
  });
});

describe.skipIf(!hasKit)('design opKeys and the confirmed cancel (sim backend, real kit)', () => {
  let h: H | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('adopts the same key and body in any state, refuses another body, is owner-scoped, is on disk at the ack, and design.byKey finds it final and after a restart', async () => {
    h = await harness();
    const before = designs(h.sc);
    const a1 = await send(h.sc, { type: 'design.request', request: keyed() });
    expect(a1.ok, a1.error).toBe(true);
    const id = a1.result!.designId as string;
    expect(a1.result!.adopted).toBe(false);
    // the key is in state.json at the ack, with the design it made
    const disk = JSON.parse(fs.readFileSync(path.join(h.sc.config.dataDir, 'state.json'), 'utf8')) as { opKeys: Record<string, { id: string }>; designs: Design[] };
    expect(disk.opKeys['design|steward:s1|st:design:1']!.id).toBe(id);
    expect(disk.designs.some((d) => d.id === id && d.request.opKey === 'st:design:1')).toBe(true);
    // the same key and body while it runs: the same design, no second job
    const a2 = await send(h.sc, { type: 'design.request', request: keyed() });
    expect(a2.result).toMatchObject({ designId: id, adopted: true });
    expect(designs(h.sc)).toBe(before + 1);
    // another body: op_key_conflict, nothing made
    const c = await send(h.sc, { type: 'design.request', request: keyed({ notes: 'a different brief' }) });
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/^op_key_conflict: opKey "st:design:1" \(design, steward:s1\) was used for another design request \(d\d+\)/);
    expect(designs(h.sc)).toBe(before + 1);
    // owner scope: the same key for another owner is another operation
    const o = await send(h.sc, { type: 'design.request', request: keyed({ owner: 'steward:s2' }) });
    expect(o.result!.designId).not.toBe(id);
    await final(h.sc, id);
    await final(h.sc, o.result!.designId as string);
    expect(h.sc.designs.get(id)!.status).toBe('done');
    // final: still adopted (never a second job), and found by key
    expect((await send(h.sc, { type: 'design.request', request: keyed() })).result).toMatchObject({ designId: id, adopted: true });
    expect((await send(h.sc, { type: 'design.byKey', owner: 'steward:s1', opKey: 'st:design:1' })).result).toMatchObject({ design: { id, status: 'done', request: { opKey: 'st:design:1' } } });
    expect((await send(h.sc, { type: 'design.byKey', opKey: 'st:design:1' })).result).toEqual({});
    expect((await send(h.sc, { type: 'design.byKey', owner: 'steward:s1', opKey: 'never-sent' })).result).toEqual({});
    // a restart (state reload): the key and its design are still there
    const root = h.root;
    await h.close(true);
    h = await harness({}, root);
    const after = await send(h.sc, { type: 'design.byKey', owner: 'steward:s1', opKey: 'st:design:1' });
    expect(after.result).toMatchObject({ design: { id, status: 'done' } });
    expect((await send(h.sc, { type: 'design.request', request: keyed() })).result).toMatchObject({ designId: id, adopted: true });
  });

  it('a keyed versionOf is adopted while it runs (never VERSION_REFUSED busy), even with new site blob ids', async () => {
    h = await harness({ simStepMs: 80 });
    const e0 = h.sc.requestDesign(DesignRequest.parse(request({ type: 'tavern', name: 'Inn', maxSize: { x: 64, y: 64, z: 64 } })));
    await final(h.sc, e0.id);
    const entry = h.sc.designs.get(e0.id)!.blueprintId!;
    const blob = (s: string) => h!.sc.blobs.put({ kind: 'site', ext: 'nbt', chunks: [Buffer.from(s).toString('base64')] }).blobId;
    const vreq = (now: string) => keyed({ type: 'tavern', notes: 'weathered', maxSize: { x: 64, y: 64, z: 64 }, opKey: 'st:vo:1', versionOf: { entryId: entry, siteId: 's1', siteNow: now } });
    const v1 = await send(h.sc, { type: 'design.request', request: vreq(blob('first')) });
    expect(v1.ok, v1.error).toBe(true);
    const id = v1.result!.designId as string;
    expect(h.sc.designs.get(id)!.status).not.toMatch(/done|failed|cancelled/);
    // the mod's retry: the site uploaded again (another blob id), same key: adopted, not busy
    const v2 = await send(h.sc, { type: 'design.request', request: vreq(blob('again')) });
    expect(v2.ok, v2.error).toBe(true);
    expect(v2.result).toMatchObject({ designId: id, adopted: true });
    // the control: without the key the same request is busy
    const { opKey: _k, ...unkeyed } = vreq(blob('third')) as Record<string, unknown>;
    const busy = await send(h.sc, { type: 'design.request', request: unkeyed });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/busy|unfinished versionOf/);
    await final(h.sc, id);
  });

  it('design.cancelConfirm: unknown, already_final with the final design, cancelled once stopped (the final cost), and a retry answers cancelled again', async () => {
    h = await harness({ simStepMs: 60 });
    expect((await send(h.sc, { type: 'design.cancelConfirm', designId: 'd999' })).result).toEqual({ designId: 'd999', outcome: 'unknown' });
    const done = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Finished' })));
    await final(h.sc, done.id);
    const f = await send(h.sc, { type: 'design.cancelConfirm', designId: done.id });
    expect(f.result).toMatchObject({ designId: done.id, outcome: 'already_final', design: { id: done.id, status: 'done', cost: h.sc.designs.get(done.id)!.cost } });
    const run = h.sc.requestDesign(DesignRequest.parse(request({ name: 'Stopped' })));
    await until(() => h!.sc.designs.get(run.id)!.status === 'designing');
    const c = await send(h.sc, { type: 'design.cancelConfirm', designId: run.id });
    expect(c.ok, c.error).toBe(true);
    expect(c.result).toMatchObject({ designId: run.id, outcome: 'cancelled', design: { id: run.id, status: 'cancelled' } });
    // the run had ended by the answer: nothing changes after it
    const cost = (c.result!.design as Design).cost;
    expect(h.sc.designs.get(run.id)!.cost).toEqual(cost);
    expect(h.events.some((m) => m.type === 'design.upsert' && m.design.id === run.id && m.design.status === 'cancelled')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.sc.designs.get(run.id)!.cost).toEqual(cost);
    expect(h.sc.designs.get(run.id)!.status).toBe('cancelled');
    const again = await send(h.sc, { type: 'design.cancelConfirm', designId: run.id });
    expect(again.result).toMatchObject({ designId: run.id, outcome: 'cancelled', design: { status: 'cancelled', cost } });
    // the old design.cancel is unchanged: a final design is refused
    expect((await send(h.sc, { type: 'design.cancel', designId: run.id })).ok).toBe(false);
  });
});

describe('design opKeys: keyed designs outlive the 100-design trim for 30 days', () => {
  it('keeps a final keyed design past the trim until 30 days after it ended', () => {
    const dir = tempDir('arch-k3-trim-');
    try {
      let now = 1_000_000;
      const store = new Store(dir, { debounceMs: 5 });
      const book = new DesignBook({ store, emit: () => undefined, now: () => now });
      const k = book.create(DesignRequest.parse(request({ owner: 'steward:s1', opKey: 'st:keep' })));
      book.update(k.id, { status: 'done', step: 'done' });
      const finish = () => {
        const d = book.create(DesignRequest.parse(request()));
        book.update(d.id, { status: 'done', step: 'done' });
      };
      for (let i = 0; i < 120; i++) finish();
      expect(book.get(k.id)?.status).toBe('done');
      now += OP_KEY_KEEP_MS + 1;
      finish();
      expect(book.get(k.id)).toBeUndefined();
      store.close();
    } finally {
      rmrf(dir);
    }
  });
});

// ---- the Claude designer: a running turn's cancel waits for the turn to stop -----------------------------------------------------

let u = 0;
const sid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(), ...o }) as unknown as SDKMessage;
const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake', cwd: '', tools: [] });
const result = (s: string, usd: number) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'x', num_turns: 2, total_cost_usd: usd, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

describe('design.cancelConfirm with the Claude designer (fake SDK)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('answers cancelled only after the running turn has stopped; a cost the turn reports after the cancel is never recorded', async () => {
    const hh = makeSidecar(['--backend', 'claude']);
    h = hh;
    h.sc.config.claude.designModel = 'fake-designer';
    h.sc.endpoint = { port: 7890, tokenFile: path.join(h.cfg.dataDir, 'client.token') };
    let streamEnded = 0;
    let started = false;
    const script = async function* (opts: Options): AsyncGenerator<SDKMessage> {
      const s = sid();
      try {
        yield init(s);
        // a round's result: its cost is recorded
        yield result(s, 0.02);
        started = true;
        await new Promise<void>((resolve) => opts.abortController!.signal.addEventListener('abort', () => resolve(), { once: true }));
        // the CLI takes a while to stop, and reports more spend on the way out
        await new Promise((r) => setTimeout(r, 400));
        yield result(s, 0.5);
      } finally {
        streamEnded = Date.now();
      }
    };
    const queryFn = ({ options }: { prompt: string; options: Options }) => Object.assign(script(options), { close() {}, accountInfo: async () => ({ email: 'x' }) });
    const designer = new ClaudeDesigner(hh.sc, { queryFn: queryFn as never, skipAuthCheck: true });
    hh.sc.setAuthSettings('sk-ant-stored-key', undefined);
    await hh.sc.start(designer);
    const d = hh.sc.requestDesign(DesignRequest.parse(request({ name: 'Slow Stop' })));
    await until(() => started && (hh.sc.designs.get(d.id)!.cost?.usd ?? 0) > 0);
    const c = await send(hh.sc, { type: "design.cancelConfirm", designId: d.id });
    const answered = Date.now();
    expect(c.ok, c.error).toBe(true);
    expect(streamEnded).toBeGreaterThan(0);
    expect(answered).toBeGreaterThanOrEqual(streamEnded);
    expect(c.result).toMatchObject({ outcome: 'cancelled', design: { id: d.id, status: 'cancelled', cost: { usd: 0.02 } } });
    expect(hh.sc.designs.get(d.id)!.cost?.usd).toBe(0.02);
    expect(h.sc.designs.get(d.id)!.status).toBe('cancelled');
  });
});
