// Slice CB (the composer's system out of room): plan/0#compact's kind defs on demand. The core block (everything but the on-demand
// connector, form, channel and reserved-rule defs) is plan/0#compact's rendering minus those defs and resolves every $ref it names; a
// round shows in full the defs its brief, hints and rules name or its land's affordances select (at most KIND_DEFS_MAX), the rest as
// fields-only lines; the floor plus the largest caller's rules plus KIND_DEFS_MAX stays under JOB_SYSTEM_MAX (the binding budget);
// the composer's text (every pinned rule) is in every system; a kind the plan used without its full def gets it in the repair prompt.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_SYSTEM_MAX } from '../src/protocol.js';
import { expandSystemRefs, planCompactBlock, planCompactParts } from '../src/jobs/systemrefs.js';
import {
  AFFORDANCE_KINDS, CALLER_SYSTEM_MAX, composerPlanParts, composerSystem, composerSystemFloor, composerText, FAMILIES_MAX, KIND_DEFS_MAX,
  kindFieldsLine, repairKinds, selectKindDefs, vocabFamiliesText,
} from '../src/compose.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));

const refsOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => refsOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === '$ref' && typeof x === 'string') out.add(x);
    else refsOf(x, out);
  }
  return out;
};

describe.skipIf(!HAS_KIT)('CB the composer\'s kind schemas on demand', () => {
  it('the core is plan/0#compact minus the on-demand defs, and every $ref it names resolves', async () => {
    const parts = await planCompactParts(KIT);
    expect(planCompactBlock(parts)).toBe(await expandSystemRefs(KIT, ['plan/0#compact']));
    const p = await composerPlanParts(KIT);
    const schema = JSON.parse(p.core.split('\n\n')[1]!) as { $defs: Record<string, unknown> };
    for (const d of p.onDemand) expect(schema.$defs[d]).toBeUndefined();
    for (const r of refsOf(schema)) expect(schema.$defs[r.slice('#/$defs/'.length)], r).toBeDefined();
    // the zones, programs and streets stay full; every connector and form def other than those is on demand
    for (const d of ['zone.standard', 'zone.outpost', 'program.lots', 'program.districts', 'program.template', 'connector.routed', 'connector.auto', 'rule.palette', 'lot', 'district', 'terraces', 'where', 'feature', 'endpoint']) expect(schema.$defs[d], d).toBeDefined();
    for (const d of Object.keys(parts.schema.$defs as object)) if (/^(connector|form)\./.test(d) && !['connector.routed', 'connector.auto'].includes(d)) expect(p.onDemand, d).toContain(d);
    // every on-demand def's refs resolve in the core or among the on-demand defs; the affordance map names only real defs
    for (const d of p.onDemand) for (const r of refsOf(JSON.parse(p.defs[d]!))) expect(schema.$defs[r.slice(8)] !== undefined || p.onDemand.includes(r.slice(8)), `${d} ${r}`).toBe(true);
    for (const ds of Object.values(AFFORDANCE_KINDS)) for (const d of ds) expect(p.onDemand).toContain(d);
    expect(p.fields['connector.ladder']).toBe(kindFieldsLine('connector.ladder', JSON.parse(p.defs['connector.ladder']!)));
    expect(p.fields['connector.wall']).toMatch(/^connector\.wall \{kind: "wall", where: wallWhere, .*height: int 3\.\.16/);
  });

  it('the budget binds: the floor, the largest caller\'s rules and KIND_DEFS_MAX stay under 120,000; a typical request keeps 10k+ headroom', async () => {
    const text = composerText(KIT);
    const floor = await composerSystemFloor(KIT, text);
    const sep = '\n\n## Kind schemas for this request (plan/0 $defs, compact)\n\n{}\n\n## The caller\'s rules (they add to the rules above)\n\n'.length;
    const bound = floor + sep + CALLER_SYSTEM_MAX + KIND_DEFS_MAX;
    console.log(`CB: floor ${floor}; floor + 30k rules + ${KIND_DEFS_MAX} kind defs = ${bound} (room ${JOB_SYSTEM_MAX - bound})`);
    expect(bound).toBeLessThan(JOB_SYSTEM_MAX);
    // the worst case: every kind requested, the families and the largest rules with them; the full defs fit their cap
    const fam = vocabFamiliesText(KIT);
    const worst = await composerSystem(KIT, text, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), families: fam, needs: { brief: '', all: true } });
    const p = await composerPlanParts(KIT);
    expect(worst.kinds.full.reduce((s, d) => s + p.defs[d]!.length + d.length + 6, 0)).toBeLessThanOrEqual(KIND_DEFS_MAX);
    expect(worst.kinds.demoted.length).toBeGreaterThan(0);
    console.log(`CB: worst case ${worst.system.length} characters; ${worst.kinds.full.length} full, demoted to fields only: ${worst.kinds.demoted.join(', ')}`);
    expect(worst.system.length).toBeLessThan(JOB_SYSTEM_MAX);
    const plain = await composerSystem(KIT, text, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX), needs: { brief: 'a few homes beside a lane' } });
    console.log(`CB: a request naming no kind with 30k caller rules: ${plain.system.length}; with none: ${(await composerSystem(KIT, text, { needs: { brief: 'a few homes beside a lane' } })).system.length}`);
    expect(plain.system.length).toBeLessThanOrEqual(JOB_SYSTEM_MAX - 10_000);
  });

  it('selects by the kinds\' own words, the hints, the rules and the land, in catalogue order, deterministically', async () => {
    const p = await composerPlanParts(KIT);
    const a = selectKindDefs(p, { brief: 'Bridges over the moat into a walled town', hints: { connectors: [{ kind: 'lift' }] }, callerSystem: 'Add a waterfall.', affordances: [{ kind: 'gap' }, { kind: 'pad' }] });
    for (const d of ['connector.bridge', 'connector.channel', 'connector.wall', 'connector.lift', 'form.waterfall']) expect(a.named, d).toContain(d);
    expect(a.named).toContain('connector.rope_bridge'); // "bridge" is its word too
    expect(a.land).toEqual(['form.arch_span']);
    expect(a.full).toEqual(p.onDemand.filter((d) => a.full.includes(d)));
    // named kinds first, then the land's; what passes KIND_DEFS_MAX is demoted to fields only (here the land's arch)
    for (const d of a.named) expect(a.full).toContain(d);
    expect(a.demoted).toEqual(['form.arch_span']);
    expect(a.fieldsOnly).toContain('form.arch_span');
    expect(a.fieldsOnly).toContain('connector.ladder');
    expect(selectKindDefs(p, { brief: 'a few homes beside a lane' }).full).toEqual([]);
    const text = composerText(KIT);
    const needs = { brief: 'Bridges over the moat', affordances: [{ kind: 'cliff_face' }] };
    const s1 = await composerSystem(KIT, text, { needs });
    expect((await composerSystem(KIT, text, { needs })).system).toBe(s1.system);
    // the core and the composer's text lead every system (the same prefix for the prompt cache); the full defs, then the fields lines
    expect(s1.system.startsWith(`${p.core}\n\n${text.system}\n\n## Kind schemas for this request`)).toBe(true);
    expect(s1.system).toContain('"connector.bridge":' + p.defs['connector.bridge']);
    expect(s1.system).toContain(`\n${p.fields['form.pond']}`);
    expect(s1.system).not.toContain('"form.pond":');
  });

  it('every pinned rule reaches the composer whatever is selected; R2\'s form-part hint and CF3\'s terraces line are in the rules', async () => {
    const text = composerText(KIT);
    expect(text.system).toContain('To put lots on a form part, give an elevated zone `where: {inside: {part: <form id>}}`.');
    expect(text.system).toContain('`terraces: {}` (`rise`, `retain`, `stairs` when asked): on the zone, so every district is terraced, or on each district');
    for (const w of ['monastery', 'cliff', 'lake', 'chapel', 'cloister', 'refectory']) expect(text.system.toLowerCase()).not.toContain(w);
    for (const needs of [{ brief: '' }, { brief: 'walls and gates', affordances: [{ kind: 'water' }] }, { brief: '', all: true }]) {
      expect((await composerSystem(KIT, text, { needs })).system).toContain(`\n\n${text.system}\n\n`);
    }
  });

  it('a kind the plan uses without its full def gets it in the repair round (planCatalogueKinds\' def)', async () => {
    const p = await composerPlanParts(KIT);
    expect(selectKindDefs(p, { brief: 'a few homes' }).fieldsOnly).toContain('connector.ladder');
    const plan = { schemaVersion: 'plan/0', zones: [{ id: 'town' }], connectors: [{ id: 'up', kind: 'ladder' }] };
    const kinds = repairKinds(plan, { parts: [{ part: 'up', class: 'refused', block: 'connector.ladder' }] });
    expect(kinds).toContain('connector.ladder');
    const mod = await import(pathToFileURL(path.join(KIT, 'lib', 'plan', 'catalogue.mjs')).href) as { planCatalogueKinds: (k: string[]) => { entries: Array<{ id: string; def?: unknown }> } };
    const e = mod.planCatalogueKinds(kinds).entries.find((x) => x.id === 'connector.ladder')!;
    expect(e.def).toBeDefined();
  });
});

