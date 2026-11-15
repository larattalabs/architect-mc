// Slice CF2 (compose follow-ups from PAY P2), the sidecar half: a required zone the check answers adjusted with a LOTS_SHORT reason is a
// repair target (repairable, in the repair prompt and the waits, in player words); an adjusted zone without it is not; the composer's
// rules carry the two general hints (slopes: districts by level band, sized to their lots; forms: enlarge the form before cutting lots)
// and the system stays under JOB_SYSTEM_MAX with the families and 28k caller rules.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_SYSTEM_MAX } from '../src/protocol.js';
import { composeSystem } from '../src/jobs/systemrefs.js';
import {
  CALLER_SYSTEM_MAX, COMPOSE_REFS, composerText, composeSystemText, FAMILIES_MAX, LOTS_SHORT, needsRepair, repairable, repairPrompt, repairStop,
  vocabFamiliesText, waitsSaid, type ComposeRound,
} from '../src/compose.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));

const SHORT = { part: 'town', class: 'adjusted', block: 'zone.standard', required: true, deviations: [{ what: 'count', value: 6, max: 0, exceeds: true }],
  reasons: [{ code: LOTS_SHORT, message: "6 of the zone's 9 lots did not fit (3 placed; at most 3 may be left out): give the zone more room", evidence: { what: 'count', lots: 9, placed: 3, unplaced: 6, allowed: 3 } }] };
const ADJ = { part: 'town', class: 'adjusted', block: 'zone.standard', required: true, deviations: [{ what: 'count', value: 2, max: 0, exceeds: true }] };
const PLAN = { schemaVersion: 'plan/0', zones: [{ id: 'town', label: 'Hill town', required: true, program: { lots: [] } }] };
const round = (parts: unknown[], overall: string, n = 1): ComposeRound => ({ n, jobId: `j${n}`, plan: PLAN, check: { overall, parts } }) as ComposeRound;

describe('CF2 a required zone short of its lots', () => {
  it('is a repair target: repairable, no nothing_to_repair stop; an adjusted zone without LOTS_SHORT is not', () => {
    expect(needsRepair(SHORT)).toBe(true);
    expect(needsRepair(ADJ)).toBe(false);
    expect(repairable(round([SHORT], 'NEEDS_REPAIR'))).toBe(true);
    expect(repairStop([round([SHORT], 'NEEDS_REPAIR')])).toBeUndefined();
    expect(repairable(round([ADJ], 'READY'))).toBe(false);
    expect(repairStop([round([ADJ], 'READY')])).toBe('nothing_to_repair');
    // a reason code on a refused part stays the refused part's (not double-counted as LOTS_SHORT)
    expect(needsRepair({ ...SHORT, class: 'refused' })).toBe(true);
  });

  it('the repair prompt names the zone and how many lots did not fit; the waits say it in player words', () => {
    const p = repairPrompt('FIRST', round([SHORT], 'NEEDS_REPAIR'), '', 'again');
    expect(p).toContain('overall: NEEDS_REPAIR; 1 of 1 part(s) fit or adjusted');
    expect(p).toContain('- town: adjusted (zone.standard), required\n  - LOTS_SHORT: 6 of the zone\'s 9 lots did not fit');
    expect(p).toContain('"lots":9,"placed":3,"unplaced":6');
    expect(repairPrompt('FIRST', round([ADJ], 'READY'), '', 'again')).not.toContain('- town:');
    expect(waitsSaid(PLAN, { overall: 'NEEDS_REPAIR', parts: [SHORT] }, new Map())).toEqual([
      { part: 'town', class: 'adjusted', block: 'zone.standard', required: true, lotsShort: { lots: 9, unplaced: 6 }, say: "6 of the 9 buildings in Hill town didn't fit here" },
    ]);
    expect(waitsSaid(PLAN, { overall: 'READY', parts: [ADJ] }, new Map())).toEqual([]);
  });

  it.skipIf(!HAS_KIT)('the composer\'s rules: slopes by level band sized to their lots; enlarge a form before cutting lots; LOTS_SHORT in repair; the 120k budget holds', async () => {
    const text = composerText(KIT);
    expect(text.system).toContain('On a steep slope or hillside with many lots, prefer districts by level band (`program: {districts: [...]}`, each with its `levelBand` low, mid or high) over one small zone with a single street');
    expect(text.system).toContain('size every zone and district to hold its lots and their street');
    expect(text.system).toContain('is that zone\'s land and must hold all its lots and its street');
    expect(text.system).toContain('first enlarge the form (a bigger `size`; for a hollow mountain more `height` and `halls`), and only then cut lots or change the layout');
    expect(text.repair).toContain('`LOTS_SHORT`');
    // general rules only: no scenario nouns
    for (const w of ['monastery', 'cliff', 'lake', 'chapel']) expect(text.system.toLowerCase()).not.toContain(w);
    const fam = vocabFamiliesText(KIT);
    const big = await composeSystem(KIT, COMPOSE_REFS, composeSystemText(text, 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), fam));
    console.log(`CF2: the composer's system with the families and 28k caller rules is ${big.length} characters`);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });
});
