// Slice 7c CF (composer feedback), the sidecar half: a repair answer carries each reason's evidence, compact and bounded; the composer's
// rules name the sealed wall ring and the spiral layout, and the system stays under JOB_SYSTEM_MAX with the families and 28k caller rules;
// the claim land analysis's limit scales with the claim and a list that was not analysed says the features are missing.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_SYSTEM_MAX } from '../src/protocol.js';
import { composeSystem } from '../src/jobs/systemrefs.js';
import {
  affordanceList, CALLER_SYSTEM_MAX, COMPOSE_REFS, composerText, composeSystemText, EVIDENCE_LINE_MAX, EVIDENCE_PART_MAX, EVIDENCE_TOTAL_MAX,
  evidenceText, FAMILIES_MAX, partAnswerLine, repairPrompt, vocabFamiliesText,
} from '../src/compose.js';
import { LAND_ANALYSIS_MAX_MS, LAND_ANALYSIS_MIN_MS, landAnalysisMs } from '../src/regions.js';
import { SIDECAR_ROOT } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const HAS_KIT = fs.existsSync(path.join(KIT, 'prompts', 'composer.md'));

// the caravan calibration's answer (P1 diagnosis): the message blamed the slope, the evidence held the sealed ring
const SEALED = { part: 'desert_road', class: 'refused', block: 'connector.road', required: true, reasons: [{ code: 'UNREACHABLE', message: 'leg 1: no route within the grade (0.25), the cut and fill limits and the obstacles', evidence: { leg: 1, from: [-1047, 72, -11], to: [-1025, 65, 77], grade: 0.25, walls: [{ wall: 'court_wall', sealed: true, gates: 0, max: 0 }] } }] };

describe('7c CF composer feedback', () => {
  it('a repair answer carries the reason\'s evidence (the sealed wall survives)', () => {
    const line = partAnswerLine(SEALED);
    expect(line).toContain('- desert_road: refused (connector.road), required');
    expect(line).toContain('    evidence: {"leg":1,"from":[-1047,72,-11],"to":[-1025,65,77],"grade":0.25,"walls":[{"wall":"court_wall","sealed":true,"gates":0,"max":0}]}');
    const p = repairPrompt('FIRST', { n: 1, jobId: 'j', plan: {}, check: { overall: 'REQUIRED_BLOCKED', parts: [SEALED] } }, '', 'again');
    expect(p).toContain('"walls":[{"wall":"court_wall","sealed":true');
    // no evidence, no line
    expect(partAnswerLine({ part: 'a', class: 'refused', reasons: [{ code: 'X', message: 'm' }, { code: 'Y', message: 'n', evidence: {} }] })).not.toContain('evidence');
  });

  it('the evidence is bounded: long arrays cut with a count, a line, a part and the whole check capped', () => {
    const t = evidenceText({ cells: Array.from({ length: 500 }, (_, i) => [i, 64, i]), walls: [{ wall: 'w', sealed: true }] });
    expect(t).toContain('"+494 more"');
    expect(t).toContain('"walls":[{"wall":"w","sealed":true}]');
    expect(evidenceText({ s: 'x'.repeat(5000) }).length).toBe(EVIDENCE_LINE_MAX);
    const huge = { code: 'NO_ROOM', message: 'm', evidence: { blob: 'y'.repeat(50_000) } };
    const part = partAnswerLine({ part: 'p', class: 'refused', reasons: Array.from({ length: 8 }, () => huge) });
    const evChars = part.split('\n').filter((l) => l.startsWith('    evidence: ')).reduce((n, l) => n + l.length - '    evidence: '.length, 0);
    expect(evChars).toBeLessThanOrEqual(EVIDENCE_PART_MAX);
    const parts = Array.from({ length: 40 }, (_, i) => ({ part: `p${i}`, class: 'refused', reasons: Array.from({ length: 8 }, () => huge) }));
    const base = repairPrompt('F', { n: 1, jobId: 'j', plan: {}, check: { overall: 'REQUIRED_BLOCKED', parts: parts.map((q) => ({ ...q, reasons: q.reasons.map(({ evidence: _e, ...r }) => r) })) } }, '', 'again');
    const withEv = repairPrompt('F', { n: 1, jobId: 'j', plan: {}, check: { overall: 'REQUIRED_BLOCKED', parts } }, '', 'again');
    expect(withEv).toContain('evidence omitted (the repair prompt\'s evidence budget is spent)');
    // the evidence lines add at most the total plus their fixed prefixes and the omitted notes
    const extraLines = withEv.split('\n').filter((l) => l.startsWith('    evidence')).length;
    expect(withEv.length - base.length).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX + extraLines * 80);
  });

  it.skipIf(!HAS_KIT)('the composer\'s rules: a closed ring needs a gate part for a route to leave; spiral on a hilltop; the 120k system budget holds', async () => {
    const text = composerText(KIT);
    expect(text.system).toContain('a road or path leaving a closed ring needs a gate part (`kind: "gate"`, `wall`, `crossing`: the route\'s id), or leave `closed` unwritten');
    expect(text.system).toContain('A zone on a hilltop or steep high ground can use `layout: "spiral"`');
    expect(text.system).not.toContain('a reserved layout (a spiral');
    const fam = vocabFamiliesText(KIT);
    const big = await composeSystem(KIT, COMPOSE_REFS, composeSystemText(text, 'r'.repeat(CALLER_SYSTEM_MAX - FAMILIES_MAX), fam));
    console.log(`7c CF: the composer's system with the families and 28k caller rules is ${big.length} characters`);
    expect(big.length).toBeLessThan(JOB_SYSTEM_MAX);
  });

  it('the land analysis limit scales with the claim, within its bounds; a list not analysed says the features are missing', () => {
    expect(landAnalysisMs()).toBe(LAND_ANALYSIS_MIN_MS);
    expect(landAnalysisMs(128 * 128)).toBe(180_000 + 4 * 16_384);
    expect(landAnalysisMs(256 * 160)).toBeGreaterThan(landAnalysisMs(128 * 128));
    expect(landAnalysisMs(1024 * 1024)).toBe(LAND_ANALYSIS_MAX_MS);
    expect(landAnalysisMs(-5)).toBe(LAND_ANALYSIS_MIN_MS);
    const t = affordanceList(undefined, 'the land analysis took longer than 245 s twice and was stopped');
    expect(t).toBe('not analysed (the land analysis took longer than 245 s twice and was stopped): the land\'s features (caves, cliffs, overhangs, water) are missing from this list, not absent from the land; read the land from the survey (and the planning images, when there are any) and name no affordance');
    expect(affordanceList([])).toBe('none found');
  });
});
