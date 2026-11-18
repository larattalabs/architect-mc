// (8c, the v0.81.0 review's P1) The composer offers 8c's flowing water only while the mod advertises flowingWater: with the flag off (the
// default), plan/0's connector.channel flow enum lacks "current", form.waterfall's lip lacks "form" (and `on` is gone), and the
// catalogue's channel.course flows and form.waterfall's form limits leave them out; with it on, they are there. The kit's check answers
// them unsupported for a mod without the feature (kit/test/flowing-8cf.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerPlanParts, composerSystem, composerText } from '../src/compose.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));

describe.skipIf(!HAS_KIT)('8c: the composer gates flow "current" and lip "form" on the flowingWater feature', () => {
  it('off by default: the prompt, the defs and the catalogue omit them; on: they are offered', async () => {
    const off = await composerPlanParts(KIT);
    const on = await composerPlanParts(KIT, { flowingWater: true });
    const ch = (p: typeof off) => JSON.parse(p.defs['connector.channel']!) as { properties: { flow: { enum: string[] } } };
    const wf = (p: typeof off) => JSON.parse(p.defs['form.waterfall']!) as { properties: { lip: { enum: string[] }; on?: unknown } };
    expect(ch(off).properties.flow.enum).not.toContain('current');
    expect(ch(on).properties.flow.enum).toContain('current');
    expect(wf(off).properties.lip.enum).not.toContain('form');
    expect(wf(off).properties.on).toBeUndefined();
    expect(wf(on).properties.lip.enum).toContain('form');
    expect(off.fields['connector.channel']).not.toMatch(/current/);
    const text = await composerText(KIT);
    const all = { brief: 'a river town with a waterfall', all: true } as const;
    const sOff = (await composerSystem(KIT, text, { needs: all })).system;
    const sOn = (await composerSystem(KIT, text, { needs: all, flowingWater: true })).system;
    expect(sOff).not.toMatch(/"current"/);
    expect(sOff).not.toMatch(/"lip":\{"enum":\[[^\]]*"form"/);
    expect(sOn).toMatch(/"current"/);
  });
});

describe.skipIf(!HAS_KIT)('8c (the review\'s P2-8): every plan/0 system-ref render is gated the same way', () => {
  it('expandSystemRefs and planCompactParts omit flow "current" and lip "form" unless flowingWater', async () => {
    const { expandSystemRefs, planCompactBlock, planCompactParts } = await import('../src/jobs/systemrefs.js');
    for (const ref of ['plan/0#compact', 'plan/0']) {
      const off = await expandSystemRefs(KIT, [ref]);
      const on = await expandSystemRefs(KIT, [ref], { flowingWater: true });
      expect(off, ref).not.toMatch(/"current"/);
      expect(off, ref).not.toMatch(/"lip":\{"enum":\[[^\]]*"form"/);
      expect(on, ref).toMatch(/"current"/);
    }
    expect(planCompactBlock(await planCompactParts(KIT))).toBe(await expandSystemRefs(KIT, ['plan/0#compact']));
    expect(planCompactBlock(await planCompactParts(KIT, { flowingWater: true }))).toBe(await expandSystemRefs(KIT, ['plan/0#compact'], { flowingWater: true }));
  });
});

describe.skipIf(!HAS_KIT)('8c (the review\'s round-2 P2-6): a repair prompt\'s kind entries are gated too', () => {
  it('gateKindEntries strips flow "current" and lip "form" off, keeps them on', async () => {
    const { gateKindEntries } = await import('../src/compose.js');
    const { pathToFileURL } = await import('node:url');
    const cat = await import(pathToFileURL(path.join(KIT, 'lib', 'plan', 'catalogue.mjs')).href);
    const entries = cat.planCatalogueKinds(['connector.channel', 'channel.course', 'form.waterfall']).entries as Array<Record<string, unknown>>;
    const raw = JSON.stringify(entries);
    expect(raw).toMatch(/"current"/);
    const off = JSON.stringify(gateKindEntries(entries, false));
    expect(off).not.toMatch(/"current"/);
    expect(off).not.toMatch(/"lip":\{[^}]*"form"/);
    expect(JSON.stringify(gateKindEntries(entries, true))).toBe(raw);
  });
});
