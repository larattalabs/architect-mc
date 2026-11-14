// (7c AU) Two of CO's gaps for Steward's adoption, in the composer's rounds (compose.ts; docs/CONTRACT.md "Slice AU as built"): a repair round
// only while a part is refused or malformed (what only waits is never repaired), and the oscillation stop (the typed answers repeat).
import { describe, expect, it } from 'vitest';
import { answersKey, repairable, repairStop, type ComposeRound } from '../src/compose.js';

const round = (n: number, overall: string, parts: Array<[string, string, string?]>, extra: Record<string, unknown> = {}): ComposeRound =>
  ({ n, jobId: `j${n}`, check: { overall, parts: parts.map(([part, cls, code]) => ({ part, class: cls, ...(code ? { reasons: [{ code }] } : {}) })), ...extra } }) as ComposeRound;

describe('the composer\'s repair stops (7c AU, CO\'s gaps)', () => {
  it('repairs only a refused or malformed part, a malformed plan or a check that did not run', () => {
    expect(repairable(round(1, 'NEEDS_REPAIR', [['town', 'refused', 'NO_ROOM']]))).toBe(true);
    expect(repairable(round(1, 'NEEDS_REPAIR', [['lane', 'malformed', 'UNKNOWN_REF']]))).toBe(true);
    expect(repairable(round(1, 'MALFORMED', []))).toBe(true);
    expect(repairable({ n: 1, jobId: 'j', refused: 'SIDECAR_UNAVAILABLE' } as ComposeRound)).toBe(true);
    expect(repairable(round(1, 'REQUIRED_BLOCKED', [['town', 'fits'], ['isle', 'unsupported'], ['bridge', 'blocked', 'DEPENDENCY']]))).toBe(false);
    expect(repairStop([round(1, 'REQUIRED_BLOCKED', [['town', 'fits'], ['isle', 'unsupported']])])).toBe('nothing_to_repair');
  });
  it('stops when the last round\'s typed answers repeat an earlier round\'s (class and codes, not the messages)', () => {
    const a = round(1, 'NEEDS_REPAIR', [['town', 'refused', 'NO_ROOM']]);
    const b = round(2, 'NEEDS_REPAIR', [['town', 'refused', 'OVERLAP']]);
    const c = round(3, 'NEEDS_REPAIR', [['town', 'refused', 'NO_ROOM']]);
    expect(answersKey(a)).toBe(answersKey(c));
    expect(repairStop([a])).toBeUndefined();
    expect(repairStop([a, b])).toBeUndefined();
    expect(repairStop([a, b, c])).toBe('oscillation');
  });
});
