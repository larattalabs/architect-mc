// Slice TS: inside a vitest worker, TMPDIR is the RAM disk's tmp/ when usable (vitest.config.ts and test/helpers.ts set it), so
// every temp dir and every child process lands there; ARCH_NO_RAMDISK=1 keeps the normal TMPDIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ramTmpChoice } from '../../tools/lib/ram-tmp.mjs';
import { tempDir } from './helpers.js';

describe('TS: the RAM-disk TMPDIR in a vitest worker', () => {
  it('os.tmpdir(), tempDir() and a child process all use the chosen temp root', () => {
    const c = ramTmpChoice();
    const child = execFileSync(process.execPath, ['-p', 'require("os").tmpdir()'], { encoding: 'utf8' }).trim();
    console.log(`TS worker pid ${process.pid}: os.tmpdir() ${os.tmpdir()}, child ${child}, RAM disk ${c.dir ?? `not used (${c.why})`}`);
    const d = tempDir();
    if (c.dir) {
      expect(os.tmpdir()).toBe(c.dir);
      expect(child).toBe(c.dir);
      expect(path.dirname(d)).toBe(fs.realpathSync(c.dir));
    } else {
      expect(child).toBe(os.tmpdir());
    }
    expect(path.basename(d)).toMatch(/^arch-test-/);
    expect(fs.existsSync(path.join(d, '.arch-owner'))).toBe(true);
  });
});
