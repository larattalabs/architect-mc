// Slice CF3 (compose follow-up from PAY P2), the sidecar half: the kit's LOTS_SHORT terrace suggestion (a short district on steep ground
// without terraces) reaches the repair prompt with its evidence; the composer's rules carry the general terraces line (on the zone, so
// every district is terraced, or on each district); and the system stays under JOB_SYSTEM_MAX with the families and 28k caller rules.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_SYSTEM_MAX } from '../src/protocol.js';
import { CALLER_SYSTEM_MAX, composerSystem, composerText, composeSystemText, FAMILIES_MAX, LOTS_SHORT, repairPrompt, vocabFamiliesText, type ComposeRound } from '../src/compose.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
/** (CB) the worst case: every on-demand kind def requested */
const WORST = { brief: '', all: true };
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));
const TIP = 'upper, gate stand on ground rising 30 blocks, too steep for a street, without terraces: add `terraces` to the zone (so every district is terraced) or to each district';
const SHORT = { part: 'town', class: 'adjusted', block: 'zone.standard', required: true, deviations: [{ what: 'count', value: 4, max: 0, exceeds: true }],
  reasons: [{ code: LOTS_SHORT, message: `4 of the zone's 5 lots did not fit (1 placed; at most 1 may be left out): give the zone more room (a larger size, districts, a terrace, a bigger form) or fewer lots; ${TIP}`,
    evidence: { what: 'count', lots: 5, placed: 1, unplaced: 4, allowed: 1, terraces: { ids: ['upper', 'gate'], rise: 30 } } }] };
const PLAN = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, program: { districts: [] } }] };
const round = (parts: unknown[], overall: string): ComposeRound => ({ n: 1, jobId: 'j1', plan: PLAN, check: { overall, parts } }) as ComposeRound;

describe('CF3 the terraces nudge', () => {
  it('a LOTS_SHORT reason\'s terrace suggestion and its evidence reach the repair prompt', () => {
    const p = repairPrompt('FIRST', round([SHORT], 'NEEDS_REPAIR'), '', 'again');
    expect(p).toContain(TIP);
    expect(p).toContain('"terraces":{"ids":["upper","gate"],"rise":30}');
  });

  it.skipIf(!HAS_KIT)('the composer\'s rules: terraces on the zone or on each district on a slope; no scenario nouns; the 120k budget holds', async () => {
    const text = composerText(KIT);
    expect(text.system).toContain('`terraces: {}` (`rise`, `retain`, `stairs` when asked): on the zone, so every district is terraced, or on each district; a district without terraces on a steep slope loses most of its lots');
    for (const w of ['monastery', 'cliff', 'lake', 'chapel', 'cloister', 'refectory']) expect(text.system.toLowerCase()).not.toContain(w);
    const fam = vocabFamiliesText(KIT);
    const big = await composerSystem(KIT, text, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), families: fam, needs: WORST }).then((x) => x.system);
    console.log(`CF3: the composer's system with the families and 28k caller rules is ${big.length} characters`);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });
});
