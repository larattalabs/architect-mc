// (6c IRR, S-IRR-2) DesignRequest.reserved: the schema takes it (bounded), the brief names it in one line (not tuned against the eval
// briefs) and the build command carries --reserved, and the kit's checker refuses a design writing a reserved cell (the real kit).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as P from '../src/protocol.js';
import { reservedLines } from '../src/claude/brief.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit');
const base = { type: 'barn', style: 'rustic', features: [], maxSize: { x: 13, y: 12, z: 13 } };

describe('DesignRequest.reserved (6c IRR)', () => {
  it('is optional and bounded in the schema', () => {
    expect(P.DesignRequest.safeParse(base).success).toBe(true);
    const r = { front: 'east', size: [13, 11], cells: [[3, 0, 4], [3, -1, 4]] };
    expect(P.DesignRequest.parse({ ...base, reserved: r }).reserved).toEqual(r);
    expect(P.DesignRequest.safeParse({ ...base, reserved: { ...r, front: 'up' } }).success).toBe(false);
    expect(P.DesignRequest.safeParse({ ...base, reserved: { ...r, cells: [[1, 2]] } }).success).toBe(false);
    expect(P.FEATURES).toContain('reserved');
  });

  it('the brief names it in one line, the cells listed when few', () => {
    expect(reservedLines(undefined)).toEqual([]);
    const l = reservedLines({ front: 'south', size: [13, 11], cells: [[3, 0, 4]] });
    expect(l).toHaveLength(1);
    expect(l[0]).toMatch(/water and its edge: keep them/);
    expect(l[0]).toMatch(/\[3,0,4\]/);
  });

  it("the kit's checker refuses a design writing a reserved cell, and --leave-reserved (the sim's stand-in) keeps it", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'irr-reserved-'));
    const r = JSON.stringify({ front: 'south', size: [13, 13], cells: [[6, 0, 6]] });
    const run = (extra: string[]) => {
      try {
        return JSON.parse(execFileSync(process.execPath, [path.join(KIT, 'build.mjs'), 'cabin', '--out', path.join(out, extra.length ? 'b' : 'a'), '--max', '13,16,13', '--reserved', r, ...extra, '--json'], { encoding: 'utf8' }));
      } catch (e) {
        return JSON.parse(String((e as { stdout?: string }).stdout));
      }
    };
    const a = run([]);
    expect(a.ok).toBe(false);
    expect(a.errors.join(' ')).toMatch(/reserved: the design writes 1/);
    expect(run(['--leave-reserved']).ok).toBe(true);
    fs.rmSync(out, { recursive: true, force: true });
  });
});
