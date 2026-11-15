// (7c PAY, P5) A settlement Style job's reference images (BibleRequest ext architect_mc:referenceImages): checked at the request (a
// settlement Style only, PNG or JPEG blobs, 1-8, labels), copied into the job's scratch, shown to the draft pass as image blocks before
// its prompt with one line naming them, and recorded in the made format 3 Style's `references`. Without them the draft prompt is byte
// for byte as before (references off). The sim records the draft it would have sent (sim-queries.jsonl), so P0 diffs on vs off at $0.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { draftImages, draftPrompt, referenceImagesLine } from '../src/claude/bible.js';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import { EXT_REFERENCE_IMAGES, type BibleJob } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = path.resolve(SIDECAR_ROOT, '..', 'kit');
const hasKit = fs.existsSync(path.join(KIT, 'build.mjs'));
/** A 1x1 PNG (its magic bytes are what the check reads). */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');

describe('reference images (pure)', () => {
  const job = (extra: Partial<BibleJob['request']> = {}): BibleJob => ({ id: 'b1', kind: 'request', bibleId: 'bib_x', version: 1, request: { prompt: 'a cliff monastery', scope: 'settlement', ...extra }, status: 'queued', step: '', cost: { usd: 0, turns: 0, inputTokens: 0, outputTokens: 0 }, createdAt: 't', updatedAt: 't' }) as unknown as BibleJob;

  it('off: no line, the prompt as before; on: one line naming the images, first', () => {
    expect(referenceImagesLine([])).toBe('');
    const off = draftPrompt(job(), {});
    const on = draftPrompt(job({ referenceImages: [{ blob: 'a', label: 'monastery 1', file: 'ref-1.png', mediaType: 'image/png' }, { blob: 'b', label: 'monastery 2', file: 'ref-2.png', mediaType: 'image/png' }] }), {});
    expect(off).not.toContain('reference image');
    expect(on.startsWith('2 reference images of the place come before this text (monastery 1; monastery 2).')).toBe(true);
    expect(on.endsWith(off)).toBe(true);
    expect(draftImages(job({ referenceImages: [{ blob: 'a', label: 'm', file: 'ref-1.png', mediaType: 'image/png' }] }), '/s')).toEqual([{ file: path.join('/s', 'references', 'ref-1.png'), label: 'm', mediaType: 'image/png' }]);
    expect(draftImages(job(), '/s')).toEqual([]);
  });
});

describe.skipIf(!hasKit)('reference images (sim backend, real kit)', () => {
  let sc: Sidecar | undefined;
  let root = '';
  afterEach(async () => {
    await sc?.close();
    sc = undefined;
    rmrf(root);
  });
  async function start(): Promise<Sidecar> {
    root = tempDir('arch-payrefs-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    cfg.simStepMs = 10;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    await sc.start(new SimDesigner(sc, cfg.simStepMs));
    return sc;
  }
  const finish = async (s: Sidecar, id: string) => {
    await until(() => ['done', 'failed', 'cancelled'].includes(s.bibles.get(id)!.status), 600_000);
    const j = s.bibles.get(id)!;
    expect(j.status, j.error).toBe('done');
    return j;
  };
  const draftQuery = (s: Sidecar, id: string) =>
    fs.readFileSync(path.join(s.bibles.scratchDir(id), 'sim-queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; prompt: string; images: Array<{ label: string; bytes: number }> }).find((q) => q.kind === 'bible-draft')!;

  it('on vs off: the draft sees the images and one more line; the Style records them in references (format 3)', async () => {
    const s = await start();
    const blob = s.blobs.putBytes(PNG, 'image', 'png');
    const off = s.bibles.request({ prompt: 'a monastery on a sea stack', name: 'Refs Off', scope: 'settlement' });
    const on = s.bibles.request({ prompt: 'a monastery on a sea stack', name: 'Refs On', scope: 'settlement', ext: { [EXT_REFERENCE_IMAGES]: [{ blob, label: 'S3 monastery 1' }, { blob }] } });
    expect(on.request.referenceImages?.map((r) => r.label)).toEqual(['S3 monastery 1', 'reference 2']);
    const jOff = await finish(s, off.id);
    const jOn = await finish(s, on.id);
    const qOff = draftQuery(s, off.id);
    const qOn = draftQuery(s, on.id);
    expect(qOff.images).toEqual([]);
    expect(qOn.images.map((i) => [i.label, i.bytes])).toEqual([['S3 monastery 1', PNG.length], ['reference 2', PNG.length]]);
    // the only differences: the name line and the references line
    const a = qOff.prompt.split('\n\n'), b = qOn.prompt.split('\n\n');
    expect(b.filter((l) => !a.includes(l))).toEqual([b[0], 'Its name: "Refs On".']);
    expect(b[0]).toContain('2 reference images of the place come before this text');
    const stored = (id: string) => JSON.parse(fs.readFileSync(path.join(s.config.biblesDir, id, 'bible.json'), 'utf8')) as Record<string, unknown>;
    expect(stored(jOn.bibleId).format).toBe(3);
    expect(stored(jOn.bibleId).references).toEqual([{ blob, label: 'S3 monastery 1' }, { blob, label: 'reference 2' }]);
    expect(stored(jOff.bibleId).references).toBeUndefined();
  });

  it('refuses a building Style, a missing blob, a non-image and more than 8, at once', async () => {
    const s = await start();
    const blob = s.blobs.putBytes(PNG, 'image', 'png');
    const txt = s.blobs.putBytes(Buffer.from('not an image'), 'image', 'bin');
    const req = (refs: unknown, scope?: 'settlement' | 'building') => () => s.bibles.request({ prompt: 'x', ...(scope ? { scope } : {}), ext: { [EXT_REFERENCE_IMAGES]: refs } });
    expect(req([{ blob }])).toThrow(/settlement Style only/);
    expect(req([{ blob }], 'building')).toThrow(/settlement Style only/);
    expect(req([{ blob: 'nope_1' }], 'settlement')).toThrow(/FIELD_LIMIT/);
    expect(req([{ blob: txt }], 'settlement')).toThrow(/not a PNG or JPEG/);
    expect(req(Array.from({ length: 9 }, () => ({ blob })), 'settlement')).toThrow(/1-8/);
    expect(req([{ blob, label: '' }], 'settlement')).toThrow(/1-60/);
    expect(s.bibles.list?.().length ?? 0).toBe(0);
  });
});
