// Flush before emit (as "the design book" in designs.test.ts): a durable change is in state.json before any client hears
// of it. An emit writes to the sockets at once, so a SIGKILL right after a client saw it must not roll it back: a done
// job, bible job or variant would be re-queued after the restart (a paid query or components round run again, a second
// library entry installed), an acked request forgotten. Non-final changes stay debounced.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bibles } from '../src/bibles.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { JobBook } from '../src/jobs/book.js';
import { parseClientMessage, type JobSpec, type Outbound } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store, type StateData } from '../src/store.js';
import { VariantBook } from '../src/variants.js';
import { copyKit, request, rmrf, tempDir } from './helpers.js';

const disk = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as StateData;

describe('flush before emit', () => {
  it('the job book flushes a final job to state.json before emitting it; non-final changes stay debounced', () => {
    const dir = tempDir();
    try {
      const store = new Store(dir, { debounceMs: 60_000 });
      const onDisk: Array<[string, string | undefined]> = [];
      const book = new JobBook({
        store,
        now: () => Date.now(),
        dir: path.join(dir, 'jobs'),
        emit: (m: Outbound) => {
          if (m.type !== 'job.upsert') return;
          onDisk.push([m.job.status, disk(dir).jobs.find((x) => x.id === m.job.id)?.status]);
        },
      });
      const j = book.create({ kind: 'structured', prompt: 'a card', schema: { type: 'object' } } as JobSpec, 'mod');
      book.update(j.id, { status: 'running', step: 'starting' });
      book.update(j.id, { status: 'done', step: 'done', result: { name: 'x' } });
      expect(onDisk).toEqual([['queued', undefined], ['running', undefined], ['done', 'done']]);
      store.close();
    } finally {
      rmrf(dir);
    }
  });

  it('the bible jobs flush a final bible job to state.json before emitting it; non-final changes stay debounced', () => {
    const dir = tempDir();
    try {
      const store = new Store(dir, { debounceMs: 60_000 });
      const onDisk: Array<[string, string | undefined]> = [];
      const sc = {
        store,
        now: () => Date.now(),
        log: memoryLogger(),
        scheduler: { enqueueBible: () => {} },
        emit: (m: Outbound) => {
          if (m.type !== 'bible.upsert') return;
          onDisk.push([m.bible.status, disk(dir).bibleJobs?.find((x) => x.id === m.bible.id)?.status]);
        },
      };
      const bibles = new Bibles(sc as unknown as Sidecar);
      const j = (bibles as unknown as { create(kind: string, bibleId: string, version: number, req: { prompt: string }): { id: string } }).create('request', 'bib_x', 1, { prompt: 'a fishing village' });
      bibles.update(j.id, { status: 'components', step: 'writing the components' });
      bibles.update(j.id, { status: 'done', step: 'done: bib_x v1' });
      expect(onDisk).toEqual([['queued', undefined], ['components', undefined], ['done', 'done']]);
      store.close();
    } finally {
      rmrf(dir);
    }
  });

  it('the variant book flushes a final variant to state.json before emitting it; non-final changes stay debounced', () => {
    const dir = tempDir();
    try {
      const store = new Store(dir, { debounceMs: 60_000 });
      const onDisk: Array<[string, string | undefined]> = [];
      const book = new VariantBook({
        store,
        now: () => Date.now(),
        emit: (m: Outbound) => {
          if (m.type !== 'variant.upsert') return;
          onDisk.push([m.variant.status, disk(dir).variants.find((x) => x.id === m.variant.id)?.status]);
        },
      });
      const v = book.create({ kind: 'variant', from: 'gen_cabin' });
      book.update(v.id, { status: 'building', step: 'building' });
      book.update(v.id, { status: 'done', step: 'done', blueprintId: 'gen_cabin_oak' });
      expect(onDisk).toEqual([['queued', undefined], ['building', undefined], ['done', 'done']]);
      store.close();
    } finally {
      rmrf(dir);
    }
  });

  it('an accepted durable command is in state.json before its ack; a blob chunk ack stays debounced', async () => {
    const root = tempDir();
    const kit = copyKit(root);
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', kit, '--port', '0', '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const store = new Store(cfg.dataDir, { debounceMs: 60_000 });
    const sc = new Sidecar(cfg, store, memoryLogger());
    try {
      await sc.start(new SimDesigner(sc, 60_000));
      store.flush();
      const send = async (raw: Record<string, unknown>) => {
        const p = parseClientMessage({ v: 1, ...raw });
        expect(p.ok).toBe(true);
        let atAck: StateData | undefined;
        let ack: Outbound | undefined;
        await sc.handle((p as unknown as { msg: never }).msg, (m) => {
          if (m.type !== 'ack') return;
          ack = m;
          atAck = disk(cfg.dataDir);
        });
        return { ack: ack as Extract<Outbound, { type: 'ack' }>, atAck: atAck! };
      };
      // design.request: the design and the counter that named it are on disk when the client hears its id
      const r = await send({ id: 'r1', type: 'design.request', request: request() });
      expect(r.ack).toMatchObject({ ok: true, result: { designId: 'd1' } });
      expect(r.atAck.designs.map((d) => d.id)).toEqual(['d1']);
      expect(r.atAck.counters.d).toBe(1);
      // design.cancel: the cancel is on disk when acked (the design does not run again after a restart)
      const c = await send({ id: 'c1', type: 'design.cancel', designId: 'd1' });
      expect(c.ack).toMatchObject({ ok: true });
      expect(c.atAck.designs.find((d) => d.id === 'd1')?.status).toBe('cancelled');
      // a blob chunk with more to come: acked, still only marked dirty
      const b = await send({ id: 'b1', type: 'blob.put', kind: 'survey', more: true, chunks: [Buffer.from('abc').toString('base64')] });
      expect(b.ack).toMatchObject({ ok: true, result: { complete: false } });
      expect(Object.keys(b.atAck.blobs)).toEqual([]);
      expect(store.isDirty).toBe(true);
    } finally {
      await sc.close();
      rmrf(root);
    }
  });
});
