// (C33) systemRefs: the expansion of "plan/0" and its compact form from the kit's own copy, the order and determinism the prompt
// cache relies on, unknown refs refused (FIELD_LIMIT naming the ref), the system cap boundaries (structured 120,000, agent 50,000).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefusedError } from '../src/errors.js';
import { composeSystem, expandSystemRefs, inlineTrivialRefs, knownSystemRefs, parseSystemRefs, SYSTEM_REF_DOCS } from '../src/jobs/systemrefs.js';
import * as P from '../src/protocol.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = path.join(SIDECAR_ROOT, '..', 'kit');
const spec = (o: Record<string, unknown>) => P.JobSpec.safeParse({ kind: 'structured', prompt: 'x', schema: { type: 'object' }, ...o });

describe('systemRefs: expansion from the kit', () => {
  it('plan/0 holds the schema (minus its embedded catalogue) and the kit\'s own live catalogue', async () => {
    const t = await expandSystemRefs(KIT, ['plan/0']);
    expect(t.startsWith("## Architect's plan schema (plan/0)\n\n{")).toBe(true);
    expect(t).toContain('"$id":"architect:plan-0"');
    expect(t).toContain('"zone.standard"');
    const [schemaPart, catPart] = t.split('\n\n## Capability catalogue of plan/0\n\n');
    expect(schemaPart).not.toContain('x-catalogue'); // rendered once, below
    const cat = JSON.parse(catPart!) as { catalogueVersion: number; api: string; kitVersion: string; schemaVersion: string; entries: Array<Record<string, unknown>> };
    const live = (await import(path.join(KIT, 'lib', 'plan', 'catalogue.mjs'))).planCatalogue() as typeof cat;
    expect(cat).toEqual(live); // the kit's own answer, not a copy
    expect(cat.entries.length).toBeGreaterThan(20);
    expect(cat.entries.every((e) => 'sinceApi' in e && 'schemaVersion' in e)).toBe(true);
  });

  it('plan/0#compact drops exactly the bookkeeping COMPACT says, and keeps the rest', async () => {
    const full = await expandSystemRefs(KIT, ['plan/0']);
    const compact = await expandSystemRefs(KIT, ['plan/0#compact']);
    expect(compact.length).toBeLessThan(full.length);
    const fc = JSON.parse(full.split('## Capability catalogue of plan/0\n\n')[1]!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cc = JSON.parse(compact.split('## Capability catalogue of plan/0, compact\n\n')[1]!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(cc).sort()).toEqual(['catalogueVersion', 'entries']);
    expect(cc.entries.length).toBe(fc.entries.length);
    cc.entries.forEach((e: Record<string, unknown>, i: number) => {
      expect(e).not.toHaveProperty('sinceApi');
      expect(e).not.toHaveProperty('schemaVersion');
      const { sinceApi: _a, schemaVersion: _b, ...rest } = fc.entries[i];
      expect(e).toEqual(rest); // ids, state, until, note ... stay
    });
    // the schema's own members are never dropped by name
    const fs = JSON.parse(full.split('\n\n')[1]!) as { $defs: Record<string, unknown>; properties: Record<string, unknown> };
    const cs = JSON.parse(compact.split('\n\n')[1]!) as typeof fs;
    expect(cs.properties).toEqual(fs.properties);
    expect(JSON.stringify(fs.properties)).toContain('schemaVersion');
    // no trivial `$ref` def exists in plan/0 today, so none is inlined
    expect(Object.keys(cs.$defs)).toEqual(Object.keys(fs.$defs));
  });

  it('is deterministic and independent of the order and repetition the caller listed the refs in', async () => {
    const a = await expandSystemRefs(KIT, ['pattern/1', 'plan/0', 'mask/1']);
    const b = await expandSystemRefs(KIT, ['mask/1', 'plan/0', 'pattern/1']);
    expect(a).toBe(b);
    expect(a.indexOf('(plan/0)')).toBeLessThan(a.indexOf('(mask/1)'));
    expect(a.indexOf('(mask/1)')).toBeLessThan(a.indexOf('(pattern/1)')); // the registry's order: append-only
    expect(SYSTEM_REF_DOCS.map((d) => d.id)).toEqual(['plan/0', 'siteplan/1', 'mask/1', 'pattern/1', 'vocab/1']);
    expect(await expandSystemRefs(KIT, ['plan/0'])).toBe(await expandSystemRefs(KIT, ['plan/0']));
    expect(a).not.toContain(KIT); // no path of this machine
    expect(a).not.toMatch(/\d{4}-\d\d-\d\dT\d/); // no timestamp
  });

  it('the refs lead and the caller\'s system follows, so the prefix is shared across calls', async () => {
    const x = await composeSystem(KIT, ['plan/0#compact'], 'You write plans.');
    const y = await composeSystem(KIT, ['plan/0#compact'], 'You judge plans, differently.');
    const head = await expandSystemRefs(KIT, ['plan/0#compact']);
    expect(x).toBe(`${head}\n\nYou write plans.`);
    expect(y.startsWith(`${head}\n\n`)).toBe(true);
    expect(await composeSystem(KIT, undefined, 'only')).toBe('only');
    expect(await composeSystem(KIT, [], 'only')).toBe('only');
  });

  it('an unknown ref is refused with FIELD_LIMIT, naming the ref and what is known', async () => {
    for (const bad of ['plan/9', 'plan/0#tiny', 'nope/1']) {
      const e = await expandSystemRefs(KIT, ['plan/0', bad]).catch((x) => x);
      expect(e).toBeInstanceOf(RefusedError);
      expect(e).toMatchObject({ code: 'FIELD_LIMIT', detail: 'system_ref' });
      expect(e.message).toContain(`"${bad}"`);
      expect(e.message).toContain('plan/0#compact');
    }
    expect(knownSystemRefs()).toContain('plan/0');
  });

  it('two forms of one document are refused; the same ref twice is one block', () => {
    expect(() => parseSystemRefs(['plan/0', 'plan/0#compact'])).toThrow(/two forms of one document/);
    expect(parseSystemRefs(['plan/0', 'plan/0']).length).toBe(1);
  });

  it('a kit without the document is refused with a typed reason, not a crash', async () => {
    const e = await expandSystemRefs(path.join(SIDECAR_ROOT, 'test', 'fixtures', 'kit'), ['plan/0']).catch((x) => x);
    expect(e).toBeInstanceOf(RefusedError);
    expect(e).toMatchObject({ code: 'FIELD_LIMIT', detail: 'system_ref_unavailable' });
    expect(e.message).toContain('"plan/0"');
  });

  it('the compact plan/0 is much shorter than the full one a caller sent (about 45 KB)', async () => {
    // ((6c FL) COMPACT_KIT: another kit's compact form measured (the FL gate's merge-base figure); unset, this kit's)
    const compact = await expandSystemRefs(process.env.COMPACT_KIT ?? KIT, ['plan/0#compact']);
    // (6c T3) the bound grew from 60,000 with catalogue 6 (the bridge and tunnel defs, R18-R20, six ids): the structured jobs' system
    // cap (120,000) is the real limit; this keeps the compact form well under it. (6c H) 66,000 -> 76,000 with catalogue 7 (the pond,
    // fountain, waterfall, quay and channel defs, waterDepth, farmPond, R21-R23, four ids). (The CU/IRR/VOC-c batch) 76,000 -> 80,000
    // with catalogue 9: IRR's irrigate member and VOC-c's strict rule.palette def together reach 76,652 (each alone stayed under).
    // (6c FL/F3, Steward's S-FL-8) 80,000 -> 84,000: FL's descriptions and F3's five lean form defs together may pass 80,000
    console.log(`# compact plan/0: ${compact.length} characters`);
    expect(compact.length).toBeLessThan(84_000);
  });
});

describe('(6c VOC) vocab/1: the block vocabulary', () => {
  it('the full form holds every block (family, colour, tier, survival class, fitting) and nothing of the compact form', async () => {
    const t = await expandSystemRefs(KIT, ['vocab/1']);
    expect(t.startsWith("## Architect's block vocabulary (vocab/1)\n\n{")).toBe(true);
    const d = JSON.parse(t.split('\n\n')[1]!) as { vocab: number; blocks: Record<string, { fam: string; sv: string; t?: string; col?: string }>; compact?: unknown };
    expect(d.vocab).toBe(1);
    expect(d.compact).toBeUndefined();
    const B = (await import(path.join(KIT, 'lib', 'blocks.mjs'))).BLOCKS as Record<string, { fam: string; sv: string; t?: string; col?: string }>;
    expect(Object.keys(d.blocks).length).toBe(Object.keys(B).length);
    expect(d.blocks.copper_block).toMatchObject({ fam: 'copper', t: 'uncommon', sv: 'craft' });
    expect(d.blocks.beacon).toMatchObject({ t: 'precious' });
    expect(d.blocks.red_concrete).toMatchObject({ fam: 'concrete', col: 'red', t: 'uncommon' });
    expect(d.blocks.bedrock).toMatchObject({ sv: 'none' });
    for (const [b, v] of Object.entries(d.blocks)) expect(v.fam).toBe(B[`minecraft:${b}`]!.fam); // the running kit's own table
  });

  it('#compact groups the same facts and is much shorter', async () => {
    const full = await expandSystemRefs(KIT, ['vocab/1']);
    const compact = await expandSystemRefs(KIT, ['vocab/1#compact']);
    expect(compact.startsWith("## Architect's block vocabulary (vocab/1), compact\n\n{")).toBe(true);
    const c = JSON.parse(compact.split('\n\n')[1]!) as { blocks?: unknown; compact: { families: Record<string, string[]>; tiers: Record<string, { families: string[]; blocks: string[] }>; dyed: string[]; survival: Record<string, string[]> } };
    expect(c.blocks).toBeUndefined();
    expect(c.compact.families.copper).toContain('cut_copper_stairs');
    expect(c.compact.tiers.precious!.blocks).toContain('beacon');
    expect(c.compact.dyed).toEqual(expect.arrayContaining(['concrete', 'wool', 'terracotta', 'stained_glass']));
    expect(c.compact.survival.none).toContain('bedrock');
    expect(compact.length).toBeLessThan(full.length / 2);
    expect(compact.length).toBeLessThan(40_000);
    expect(await expandSystemRefs(KIT, ['vocab/1#compact', 'plan/0#compact'])).toBe(await expandSystemRefs(KIT, ['plan/0#compact', 'vocab/1#compact']));
  });
});

describe('compact: trivial $ref defs', () => {
  it('a def that is only a $ref is inlined at its uses (also through a chain) and removed; others stay', () => {
    const out = inlineTrivialRefs({ properties: { a: { $ref: '#/$defs/x' }, b: { $ref: '#/$defs/real' } }, $defs: { x: { $ref: '#/$defs/y', description: 'alias' }, y: { $ref: '#/$defs/real' }, real: { type: 'string' } } });
    expect(out).toEqual({ properties: { a: { $ref: '#/$defs/real' }, b: { $ref: '#/$defs/real' } }, $defs: { real: { type: 'string' } } });
  });
});

describe('JobSpec: system caps and the ref list (zod)', () => {
  it('a structured job takes 120,000 characters of system, not 120,001', () => {
    expect(spec({ system: 'a'.repeat(120_000) }).success).toBe(true);
    expect(spec({ system: 'a'.repeat(120_001) }).success).toBe(false);
  });

  it('an agent job keeps 50,000', () => {
    expect(spec({ kind: 'agent', schema: undefined, system: 'a'.repeat(50_000) }).success).toBe(true);
    const r = spec({ kind: 'agent', schema: undefined, system: 'a'.repeat(50_001) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('at most 50000');
  });

  it('systemRefs: at most 8, each <family>/<id>[#form] of at most 64 characters, no duplicates', () => {
    expect(spec({ systemRefs: ['plan/0', 'plan/0#compact'.replace('plan', 'mask')] }).success).toBe(true);
    expect(spec({ systemRefs: Array.from({ length: 8 }, (_, i) => `a/${i}`) }).success).toBe(true);
    expect(spec({ systemRefs: Array.from({ length: 9 }, (_, i) => `a/${i}`) }).success).toBe(false);
    expect(spec({ systemRefs: ['Plan 0'] }).success).toBe(false);
    expect(spec({ systemRefs: ['plan'] }).success).toBe(false);
    expect(spec({ systemRefs: ['plan/0', 'plan/0'] }).success).toBe(false);
    expect(spec({ systemRefs: [`a/${'b'.repeat(62)}`] }).success).toBe(true);
    expect(spec({ systemRefs: [`a/${'b'.repeat(63)}`] }).success).toBe(false);
  });

  it('the feature is announced', () => {
    expect(P.FEATURES).toContain('job.systemRefs');
  });
});
