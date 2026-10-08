// Phase 5a: the eval harness's sim tier (CI can't call Claude; docs/CONTRACT.md "Phase 5a gate" item 1): `eval.mjs run
// --tier sim`, then `rescore` (byte-identical) and `compare` on two sim runs; the auth guard refuses a real tier when
// an API key is set.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { rmrf, SIDECAR_ROOT, tempDir } from './helpers.js';

const REPO = path.resolve(SIDECAR_ROOT, '..');
const EVAL = path.join(REPO, 'tools', 'eval.mjs');
const MAIN = path.join(SIDECAR_ROOT, 'dist', 'main.mjs');
const hasKit = fs.existsSync(path.join(REPO, 'kit', 'check.mjs'));

/** a copy of the bundle (other test files rebuild dist/ while this one runs) */
let bundle = '';
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const base = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete base[k];
  return spawnSync(process.execPath, [EVAL, ...args], { cwd: REPO, encoding: 'utf8', env: { ...base, ARCHITECT_EVAL_SIDECAR: bundle, ...env }, timeout: 240_000 });
};

describe.skipIf(!hasKit)('tools/eval.mjs (sim tier)', () => {
  beforeAll(() => {
    if (!fs.existsSync(MAIN)) execFileSync(process.execPath, [path.join(SIDECAR_ROOT, 'scripts', 'build.mjs')], { cwd: SIDECAR_ROOT, stdio: 'pipe' });
    // the bundle resolves its version from ../package.json and node_modules from its folder's parents: a sibling copy
    bundle = path.join(SIDECAR_ROOT, 'dist-eval-test', 'main.mjs');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.copyFileSync(MAIN, bundle);
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

  it('(5b) the polish arm on the sim tier: import-round0 (pre-check), polish, judges, G1-G5, rescore byte-identical; a drift refuses', () => {
    const out = tempDir('arch-eval-p-');
    try {
      const a = run(['run', '--tier', 'sim', '--label', 'ci-loop', '--briefs', '2,5,16,17', '--out', out, '--no-results']);
      expect(a.status, a.stdout + a.stderr).toBe(0);
      const ra = fs.readdirSync(out).find((d) => d.startsWith('ci-loop-'))!;
      const p = run(['run', '--tier', 'sim', '--arm', 'polish', '--from', ra, '--label', 'ci-polish', '--out', out, '--no-results', '--smoke-first']);
      expect(p.status, p.stdout + p.stderr).toBe(0);
      expect(p.stdout).toMatch(/port 889[45]/);
      const rp = fs.readdirSync(out).find((d) => d.startsWith('ci-polish-'))!;
      const s = JSON.parse(fs.readFileSync(path.join(out, rp, 'summary.json'), 'utf8')) as { arm: string; precheck: { identical: number; of: number }; briefs: Array<{ id: string; status: string; end: string; accepted: number; installedVersion: number | null; judge: { outcome: string }; g5: { checked: boolean; violations: number }; h2h: { outcome: string }; targeted: { outcome: string } }>; aggregates: { done: number; G5: { pass: boolean }; G1: { withStep: number }; recorded: { steps: number } } };
      expect(s.arm).toBe('polish');
      expect(s.precheck).toEqual({ identical: 4, of: 4 });
      expect(s.aggregates.done).toBe(4);
      expect(s.aggregates.G5.pass).toBe(true);
      expect(s.aggregates.recorded.steps).toBeGreaterThan(0);
      const polished = s.briefs.filter((b) => b.end === 'polished');
      expect(polished.length).toBeGreaterThan(0);
      for (const b of polished) {
        expect(b.installedVersion).toBe(2);
        expect(b.judge.outcome).toMatch(/win|loss|tie/);
        expect(b.g5.checked).toBe(true);
        expect(b.targeted.outcome).toMatch(/fixed|worse|tie/);
      }
      for (const b of s.briefs.filter((x) => x.accepted === 0)) expect(['identical', 'none']).toContain(b.judge.outcome);
      const re = run(['rescore', rp, '--out', out]);
      expect(re.stdout).toMatch(/byte-identical/);
      // a stored round 0 that no longer rebuilds: the polish arm refuses to start (before any spend)
      const loopRun = JSON.parse(fs.readFileSync(path.join(out, ra, 'run.json'), 'utf8')) as { state: Record<string, { designIds: string[] }> };
      const did = loopRun.state.farmhouse_porch!.designIds[0]!;
      const r0 = path.join(out, ra, 'sidecar', 'data', 'designs', did, 'rounds', '0');
      const nbt = fs.readdirSync(r0).find((f) => f.endsWith('.nbt'))!;
      fs.copyFileSync(path.join(REPO, 'kit', 'examples', 'tower', 'tower.nbt'), path.join(r0, nbt));
      const bad = run(['import-round0', ra, '--out', out]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/refused: 1 stored round 0 do not rebuild byte-identically/);
      // the eval sidecar never leaves 8894/8895
      const port = run(['run', '--tier', 'sim', '--arm', 'polish', '--from', ra, '--out', out, '--no-results', '--port', '8890']);
      expect(port.stderr).toMatch(/uses 8894 or 8895 only/);
    } finally {
      rmrf(out);
    }
  }, 240_000);

  it('(5b) the smoke stop rule', async () => {
    const { smokeStop } = (await import(pathToFileURL(EVAL).href)) as { smokeStop: (rows: Array<Record<string, unknown>>) => { stop: boolean; why: string[] } };
    const ok = { accepted: 1, g5: { violations: 0 }, usd: 1, high: 2 };
    expect(smokeStop([ok, ok, ok, ok]).stop).toBe(false);
    expect(smokeStop([ok, { ...ok, accepted: 0 }, { ...ok, accepted: 0 }, { ...ok, accepted: 0 }]).why[0]).toMatch(/3 of 4 smoke briefs accepted no step/);
    expect(smokeStop([ok, ok, ok, { ...ok, g5: { violations: 1 } }]).why[0]).toMatch(/G5 violation/);
    expect(smokeStop([ok, ok, ok, { ...ok, usd: 20 }]).why[0]).toMatch(/over 1.5x the seeded high/);
  });

  it('a real tier refuses to start with an API key in the environment', () => {
    const r = run(['run', '--tier', 'smoke', '--out', tempDir('arch-eval-g-')], { ANTHROPIC_API_KEY: 'sk-test-not-real' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused: ANTHROPIC_API_KEY is set/);
  });
});
