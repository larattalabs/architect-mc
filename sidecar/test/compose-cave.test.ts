// Slice CAVE, the sidecar half: the composer's rules carry the general caves line (a lots zone with layout elevated located by a cave
// feature, its lots carved into the walls, before a new hollow mountain), no scenario nouns, and the system stays under JOB_SYSTEM_MAX
// with the families and 28k caller rules (the plan/0 schema now holds feature.cave).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_SYSTEM_MAX } from '../src/protocol.js';
import { CALLER_SYSTEM_MAX, composerSystem, composerText, composeSystemText, FAMILIES_MAX, vocabFamiliesText } from '../src/compose.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
/** (CB) the worst case: every on-demand kind def requested */
const WORST = { brief: '', all: true };
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));

describe('CAVE the composer\'s caves line', () => {
  it.skipIf(!HAS_KIT)('names the cave locator on an elevated lots zone; no scenario nouns; the 120k budget holds', async () => {
    const text = composerText(KIT);
    expect(text.system).toContain('In a cave the land has: a lots zone, `layout: "elevated"`, `where: {near: {feature: {cave: {}}}}`; its lots are carved into the cave\'s walls');
    for (const w of ['city', 'dwarf', 'mountain city', 'cavern hall']) expect(text.system.toLowerCase()).not.toContain(w);
    const fam = vocabFamiliesText(KIT);
    const big = await composerSystem(KIT, text, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), families: fam, needs: WORST }).then((x) => x.system);
    console.log(`CAVE: the composer's system with the families and 28k caller rules is ${big.length} characters`);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
    expect(big).toContain('feature.cave supported');
    const plain = await composerSystem(KIT, text, { callerSystem: 'r'.repeat(CALLER_SYSTEM_MAX), needs: WORST }).then((x) => x.system);
    console.log(`CAVE: with the full ${CALLER_SYSTEM_MAX} caller rules (no families) it is ${plain.length} characters`);
    expect(plain.length).toBeLessThan(JOB_SYSTEM_MAX);
  });
});
