// Phase 5a: the eval harness's sim tier (CI can't call Claude; docs/CONTRACT.md "Phase 5a gate" item 1): `eval.mjs run
// --tier sim`, then `rescore` (byte-identical) and `compare` on two sim runs; the auth guard refuses a real tier when
// an API key is set.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { rmrf, SIDECAR_ROOT, tempDir } from './helpers.js';

const REPO = path.resolve(SIDECAR_ROOT, '..');
const EVAL = path.join(REPO, 'tools', 'eval.mjs');
const MAIN = path.join(SIDECAR_ROOT, 'dist', 'main.mjs');
const hasKit = fs.existsSync(path.join(REPO, 'kit', 'check.mjs'));

const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const base = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete base[k];
  return spawnSync(process.execPath, [EVAL, ...args], { cwd: REPO, encoding: 'utf8', env: { ...base, ...env }, timeout: 240_000 });
};

describe.skipIf(!hasKit)('tools/eval.mjs (sim tier)', () => {
  beforeAll(() => {
    if (!fs.existsSync(MAIN)) execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
  });

  it('runs the sim tier, rescore is byte-identical, compare of two runs says no regression', () => {
    const out = tempDir('arch-eval-');
    try {
      const a = run(['run', '--tier', 'sim', '--label', 'ci-a', '--briefs', '2,5,16,17', '--out', out, '--no-results']);
      expect(a.status, a.stdout + a.stderr).toBe(0);
      const b = run(['run', '--tier', 'sim', '--label', 'ci-b', '--briefs', '2,5,16,17', '--out', out, '--no-results']);
      expect(b.status, b.stdout + b.stderr).toBe(0);
      const [ra, rb] = ['ci-a', 'ci-b'].map((l) => fs.readdirSync(out).find((d) => d.startsWith(`${l}-`))!) as [string, string];
      const s = JSON.parse(fs.readFileSync(path.join(out, ra, 'summary.json'), 'utf8')) as { briefs: Array<{ id: string; status: string; judge: { outcome: string } | null; final: { errors: number } | null }>; aggregates: { done: number; G1: { withRevision: number } }; authVars: Record<string, boolean>; provenance: { hashes: Record<string, string> } };
      expect(s.aggregates.done).toBe(4);
      expect(s.briefs.find((x) => x.id === 'farmhouse_porch')!.judge!.outcome).toBe('win');
      expect(s.briefs.find((x) => x.id === 'coaching_inn')!.judge!.outcome).toBe('identical');
      expect(s.briefs.every((x) => x.final?.errors === 0)).toBe(true);
      expect(s.authVars.ANTHROPIC_API_KEY).toBe(false);
      expect(Object.keys(s.provenance.hashes).sort()).toEqual(['briefs', 'critic', 'designPrompts', 'judge', 'kit']);
      const re = run(['rescore', ra, '--out', out]);
      expect(re.stdout).toMatch(/byte-identical/);
      const cmp = run(['compare', ra, rb, '--out', out]);
      expect(cmp.stdout).toMatch(/no regression/);
    } finally {
      rmrf(out);
    }
  }, 240_000);

  it('a real tier refuses to start with an API key in the environment', () => {
    const r = run(['run', '--tier', 'smoke', '--out', tempDir('arch-eval-g-')], { ANTHROPIC_API_KEY: 'sk-test-not-real' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused: ANTHROPIC_API_KEY is set/);
  });
});
