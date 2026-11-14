// (M5 GP, Steward's S-M5-1) Given-program designs and keyed variants on the real kit, $0: design.fromProgram installs a caller's kit
// program as an entry recording its sha (the exact source kept as program/source.mjs); design.variant re-runs it with other params, a
// bible and the lot's reserved cells (the program is given them; one that ignores them is refused `reserved` with the checker's typed
// finding); design.variantByKey finds the variant after a restart; the opKeys replay and conflict; params, a throwing program, the
// sandbox, program_stale, not_given, no_entry; a kill between the install and the record installs nothing twice.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURES, parseClientMessage, type Outbound } from '../src/protocol.js';
import { SimDesigner } from '../src/sim.js';
import { Sidecar } from '../src/sidecar.js';
import { Store } from '../src/store.js';
import { memoryLogger } from '../src/context.js';
import { findingRule, sha256 } from '../src/programs.js';
import { makeSidecar, rmrf, until, type Harness } from './helpers.js';

const KIT = path.resolve(__dirname, '..', '..', 'kit');
const SOURCE = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'gp', 'gp_crop_field.mjs'), 'utf8');
/** the same program, but it ignores the reserved cells it is given */
const IGNORES = SOURCE.replace("if (!keep.has(`${x},${y},${z}`)) bp.set(x, y, z, block, props);", 'bp.set(x, y, z, block, props);');
/** an 11 x 11 lot (side 9 + the fence ring), its front south; the field's middle cell (its farmland and the crop over it) */
const RESERVED = { front: 'south' as const, size: [11, 11] as [number, number], cells: [[5, -1, 5], [5, 0, 5]] as Array<[number, number, number]> };

type Ack = { ok: boolean; error?: string; code?: string; detail?: string; result?: Record<string, unknown> };
async function call(sc: Sidecar, msg: Record<string, unknown>): Promise<Ack> {
  const parsed = parseClientMessage(JSON.stringify({ v: 1, id: 'q', ...msg }));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let ack: Ack | undefined;
  await sc.handle(parsed.msg, (m) => {
    if (m.type === 'ack') ack = { ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.code ? { code: m.code, detail: m.detail } : {}), ...(m.result ? { result: m.result } : {}) };
  });
  return ack!;
}
async function opDone(events: Outbound[], id: string): Promise<Record<string, unknown>> {
  let done: Record<string, unknown> | undefined;
  await until(() => {
    done = (events as Array<Outbound & { follow?: Record<string, unknown> }>).filter((e) => e.type === 'follow.upsert' && e.follow?.id === id && e.follow.status === 'done').pop()?.follow;
    return !!done;
  }, 120_000);
  return done!;
}
async function finished(h: { events: Outbound[] }, a: Ack): Promise<Record<string, unknown>> {
  expect(a.error).toBeUndefined();
  const op = a.result!;
  return op.status === 'done' ? op : opDone(h.events, op.id as string);
}
const entryJson = (h: Harness, id: string) => JSON.parse(fs.readFileSync(path.join(h.cfg.libraryDir, id, `${id}.blueprint.json`), 'utf8')) as Record<string, unknown>;

describe('given-program designs (M5 GP): pure parts', () => {
  it('names the feature and classifies the checker lines by rule', () => {
    expect(FEATURES).toContain('design.program');
    expect(findingRule("reserved: the design writes 2 of the lot's reserved cell(s)")).toBe('reserved');
    expect(findingRule('size 12x3x12 exceeds the limit 9x9x9 (x, z)')).toBe('size');
    expect(findingRule('values: side must be an integer 5..27 (got 99)')).toBe('params');
    expect(findingRule("sidecar: interior is required: the profile of 'farm' has lit")).toBe('sidecar');
    expect(findingRule("missing required anchor 'entrance'")).toBe('anchors');
    expect(findingRule("palette[3]: unknown block 'minecraft:nope' (not a vanilla 26.3 block)")).toBe('blocks');
    expect(findingRule('design gp threw: Error: no')).toBe('program');
    expect(findingRule('something else')).toBe('check');
  });
});

describe('given-program designs and keyed variants (M5 GP) on the real kit', () => {
  let h: Harness;
  let sc: Sidecar;
  let events: Outbound[];
  let entryId = '';
  let variantId = '';
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim', '--kit', KIT]);
    sc = h.sc;
    events = h.events;
    await sc.start(new SimDesigner(sc, 10));
  });
  afterAll(async () => {
    await sc.close();
    rmrf(h.root);
  });

  it('fromProgram installs the program at $0 as an entry recording its sha and keeping its exact source', async () => {
    const a = await call(sc, { type: 'design.fromProgram', source: SOURCE, params: { side: 9, crop: 'carrots' }, opKey: 'steward.t.module.crop_farm', owner: 'steward:test' });
    const done = await finished({ events }, a);
    expect(done.refused).toBeUndefined();
    expect(done.kind).toBe('fromProgram');
    expect(done.programSha).toBe(sha256(SOURCE));
    entryId = done.newEntryId as string;
    expect(entryId).toBe('gp_crop_field');
    const j = entryJson(h, entryId);
    expect(j.givenProgram).toEqual({ sha: sha256(SOURCE), opKey: 'steward.t.module.crop_farm', owner: 'steward:test' });
    expect(fs.readFileSync(path.join(h.cfg.libraryDir, entryId, 'program', 'source.mjs'), 'utf8')).toBe(SOURCE);
    expect(j.values).toEqual({ side: 9, crop: 'carrots' });
    expect(j.type).toBe('crop_field');
    expect(j.size).toEqual({ x: 11, y: 3, z: 11 });
    expect(j.derivation).toBeUndefined();
    // the same key and body: the same operation (nothing built again); another body: op_key_conflict
    const again = await call(sc, { type: 'design.fromProgram', source: SOURCE, params: { side: 9, crop: 'carrots' }, opKey: 'steward.t.module.crop_farm', owner: 'steward:test' });
    expect(again.result).toMatchObject({ status: 'done', newEntryId: entryId });
    const other = await call(sc, { type: 'design.fromProgram', source: SOURCE, params: { side: 7 }, opKey: 'steward.t.module.crop_farm', owner: 'steward:test' });
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/^op_key_conflict/);
    expect(fs.readdirSync(h.cfg.libraryDir).filter((d) => d.startsWith('gp_crop_field'))).toEqual(['gp_crop_field']);
  });

  it('refuses params outside the program\'s own schema with a typed finding (PROGRAM_REFUSED params)', async () => {
    const done = await finished({ events }, await call(sc, { type: 'design.fromProgram', source: SOURCE, params: { side: 99 }, opKey: 'gp-bad-params' }));
    expect(done.newEntryId).toBeUndefined();
    expect(done.refused).toMatchObject({ code: 'PROGRAM_REFUSED', detail: 'params' });
    expect((done.refused as { findings: Array<{ rule: string; message: string }> }).findings[0]).toMatchObject({ rule: 'params', severity: 'error' });
    expect((done.refused as { findings: Array<{ message: string }> }).findings[0]!.message).toMatch(/side must be an integer 5\.\.27/);
  });

  it('runs the program in the sandbox: a program reading outside its scratch, or throwing, is refused `program`', async () => {
    const evil = "import fs from 'node:fs';\nexport const id = 'gp_evil';\nexport default function build() { fs.readFileSync('/etc/hosts'); }\n";
    const done = await finished({ events }, await call(sc, { type: 'design.fromProgram', source: evil, params: {}, opKey: 'gp-evil' }));
    expect(done.refused).toMatchObject({ code: 'PROGRAM_REFUSED', detail: 'program' });
    expect(JSON.stringify(done.refused)).toMatch(/restricted|ERR_ACCESS_DENIED|allow-fs-read/);
    const net = "export const id = 'gp_net';\nexport default async function build() { await fetch('http://127.0.0.1:1/'); }\n";
    const d2 = await finished({ events }, await call(sc, { type: 'design.fromProgram', source: net, params: {}, opKey: 'gp-net' }));
    expect(d2.refused).toMatchObject({ code: 'PROGRAM_REFUSED', detail: 'program' });
    const noDefault = await call(sc, { type: 'design.fromProgram', source: "export const id = 'x';\n", params: {}, opKey: 'gp-nodefault' });
    expect(noDefault).toMatchObject({ ok: false, code: 'PROGRAM_REFUSED', detail: 'program' });
  });

  it('a keyed variant takes other params, a bible and the lot\'s reserved cells (given to the program; the checker passes)', async () => {
    const bible = sc.bibleIndex.list().find((b) => b.id)!;
    const a = await call(sc, { type: 'design.variant', entryId, params: { crop: 'wheat' }, bible: { id: bible.id }, reserved: RESERVED, opKey: 'steward.t.module.lot_3', owner: 'steward:test' });
    const done = await finished({ events }, a);
    expect(done.refused).toBeUndefined();
    expect(done.kind).toBe('keyedVariant');
    variantId = done.newEntryId as string;
    expect(variantId).toBe(`${entryId}_kv`);
    const j = entryJson(h, variantId);
    expect(j.givenProgram).toMatchObject({ sha: sha256(SOURCE), opKey: 'steward.t.module.lot_3' });
    expect(j.reserved).toEqual(RESERVED);
    expect(j.values).toEqual({ side: 9, crop: 'wheat' });
    expect((j.bible as { id: string }).id).toBe(bible.id);
    expect(j.derivation).toMatchObject({ source: entryId, kind: 'variant', recipe: { values: { crop: 'wheat' }, reserved: RESERVED, programSha: sha256(SOURCE) } });
    expect(fs.readFileSync(path.join(h.cfg.libraryDir, variantId, 'program', 'source.mjs'), 'utf8')).toBe(SOURCE);
    // variantByKey: the operation; an unknown key: {}
    expect((await call(sc, { type: 'design.variantByKey', opKey: 'steward.t.module.lot_3', owner: 'steward:test' })).result).toMatchObject({ status: 'done', newEntryId: variantId });
    expect((await call(sc, { type: 'design.variantByKey', opKey: 'steward.t.module.lot_3' })).result).toEqual({});
    expect((await call(sc, { type: 'design.variantByKey', opKey: 'never' })).result).toEqual({});
  });

  it('a program that ignores the reserved cells is refused `reserved` with the checker\'s typed finding', async () => {
    const ign = await finished({ events }, await call(sc, { type: 'design.fromProgram', source: IGNORES.replace("export const id = 'gp_crop_field'", "export const id = 'gp_ignores'"), params: {}, opKey: 'gp-ignores' }));
    const ignId = ign.newEntryId as string;
    expect(ignId).toBe('gp_ignores');
    const done = await finished({ events }, await call(sc, { type: 'design.variant', entryId: ignId, params: {}, reserved: RESERVED, opKey: 'gp-ignores-v' }));
    expect(done.newEntryId).toBeUndefined();
    expect(done.refused).toMatchObject({ code: 'PROGRAM_REFUSED', detail: 'reserved' });
    const f = (done.refused as { findings: Array<{ rule: string; message: string }> }).findings;
    expect(f.map((x) => x.rule)).toEqual(['reserved']);
    expect(f[0]!.message).toMatch(/writes 2 of the lot's reserved cell/);
  });

  it('refuses a variant of an entry that is not a given program, an unknown entry, and a program edited since (program_stale)', async () => {
    expect(await call(sc, { type: 'design.variant', entryId: 'cabin', params: {}, opKey: 'gp-cabin' })).toMatchObject({ ok: false, code: 'PROGRAM_REFUSED', detail: 'not_given' });
    expect(await call(sc, { type: 'design.variant', entryId: 'no_such_entry', params: {}, opKey: 'gp-none' })).toMatchObject({ ok: false, code: 'VERSION_REFUSED', detail: 'no_entry' });
    const ign = 'gp_ignores';
    const file = path.join(h.cfg.libraryDir, ign, 'program', 'source.mjs');
    fs.appendFileSync(file, '\n// edited\n');
    expect(await call(sc, { type: 'design.variant', entryId: ign, params: {}, opKey: 'gp-stale' })).toMatchObject({ ok: false, code: 'PROGRAM_REFUSED', detail: 'program_stale' });
  });

  it('after a restart, variantByKey finds the variant; the key replays; a kill between install and record installs nothing twice', async () => {
    await sc.close();
    const store = new Store(h.cfg.dataDir, { debounceMs: 5 });
    sc = new Sidecar(h.cfg, store, memoryLogger());
    events = [];
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 10));
    expect((await call(sc, { type: 'design.variantByKey', opKey: 'steward.t.module.lot_3', owner: 'steward:test' })).result).toMatchObject({ status: 'done', newEntryId: variantId });
    const replay = await call(sc, { type: 'design.variant', entryId, params: { crop: 'wheat' }, bible: { id: sc.bibleIndex.list().find((b) => b.id)!.id }, reserved: RESERVED, opKey: 'steward.t.module.lot_3', owner: 'steward:test' });
    expect(replay.result).toMatchObject({ status: 'done', newEntryId: variantId });
    // the kill: the entry is installed, the operation file still says running
    const opFile = path.join(h.cfg.dataDir, 'programs', `${sc.programs.keyId('variant', 'steward:test', 'steward.t.module.lot_3')}.json`);
    const op = JSON.parse(fs.readFileSync(opFile, 'utf8')) as Record<string, unknown>;
    delete op.newEntryId;
    op.status = 'running';
    fs.writeFileSync(opFile, JSON.stringify(op));
    await sc.close();
    sc = new Sidecar(h.cfg, new Store(h.cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    events = [];
    sc.subscribe((m) => events.push(m));
    await sc.start(new SimDesigner(sc, 10));
    const resumed = await opDone(events, op.id as string);
    expect(resumed.newEntryId).toBe(variantId);
    expect(fs.readdirSync(h.cfg.libraryDir).filter((d) => d.startsWith(`${entryId}_kv`))).toEqual([variantId]);
  });
});

// (M5 FK, S-M5-3) A given program's fill survives the install: the entry's sidecar keeps `fill` (template coordinates) with
// `givenProgram`, which is what the mod honours; a program whose fill breaks the kit's rule is refused PROGRAM_REFUSED detail `fill`.
describe('given-program fills (M5 FK) on the real kit', () => {
  const FK = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'fk', 'fk_hall.mjs'), 'utf8');
  let h: Harness;
  let sc: Sidecar;
  beforeAll(async () => {
    h = makeSidecar(['--backend', 'sim', '--kit', KIT]);
    sc = h.sc;
    await sc.start(new SimDesigner(sc, 10));
  });
  afterAll(async () => {
    await sc.close();
    rmrf(h.root);
  });

  it('names the feature and the rule', () => {
    expect(FEATURES).toContain('design.fill');
    expect(findingRule('fill: containers[0]: minecraft:stone at 0,0,0 is not a container a fill may declare (minecraft:hopper, ...)')).toBe('fill');
  });

  it('fromProgram keeps the fill in the entry with givenProgram', async () => {
    const a = await call(sc, { type: 'design.fromProgram', source: FK, params: { slots: 2, count: 18 }, opKey: 'steward.t.module.hall', owner: 'steward:test' });
    const done = await finished({ events: h.events }, a);
    expect(done.refused).toBeUndefined();
    const j = entryJson(h, done.newEntryId as string) as { fill?: { containers: Array<{ at: number[]; items: unknown[] }>; locks: unknown[] }; givenProgram?: unknown };
    expect(j.givenProgram).toBeDefined();
    expect(j.fill?.containers.map((c) => c.at)).toEqual([[1, 2, 1], [2, 2, 1]]);
    expect(j.fill?.containers[0]?.items).toEqual([{ slot: 0, id: 'minecraft:flint', count: 18 }, ...[1, 2, 3, 4].map((slot) => ({ slot, id: 'minecraft:paper', count: 1 }))]);
    expect(j.fill?.locks).toEqual([{ at: [0, 3, 1], locked: { powered: 'true' } }]);
  });

  it('a fill that breaks the kit rule is refused PROGRAM_REFUSED fill', async () => {
    const bad = FK.replace("locked: { powered: 'true' }", "locked: { facing: 'north' }");
    expect(bad).not.toBe(FK);
    const a = await call(sc, { type: 'design.fromProgram', source: bad, params: {}, opKey: 'steward.t.module.hall_bad', owner: 'steward:test' });
    const done = await finished({ events: h.events }, a);
    expect(done.refused).toBeDefined();
    expect(JSON.stringify(done.refused)).toContain('fill');
  });
});
