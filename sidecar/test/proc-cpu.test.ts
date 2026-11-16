// Slice WR2 (PT): a plan run is limited by its child's CPU time, not the wall clock, with a wall-clock backstop so a hung run still
// stops. The limit logic (limitHit), the ps time parser, the message text, the backstop, and real children: a busy loop stopped by
// CPU, a sleeping child stopped only by the backstop, a child whose CPU time can't be read stopped at the limit by wall clock.
import { describe, expect, it } from 'vitest';
import { childCpuMs, limitHit, parseCpuTime, run } from '../src/util/proc.js';
import { kitTimeoutMessage, planWallBackstopMs } from '../src/regions.js';

describe('WR2: the CPU-time limit', () => {
  it('limitHit: CPU over its limit stops; a slow wall clock alone does not, until the backstop; no reading falls back to wall', () => {
    // the paid run's numbers: 24 s of CPU in 105 s of wall time, limit 120 s of CPU, backstop 600 s
    expect(limitHit({ wallMs: 105_000, cpuMs: 24_000, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBeNull();
    expect(limitHit({ wallMs: 300_000, cpuMs: 119_000, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBeNull();
    expect(limitHit({ wallMs: 130_000, cpuMs: 120_001, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBe('cpu');
    expect(limitHit({ wallMs: 600_001, cpuMs: 30_000, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBe('wall');
    expect(limitHit({ wallMs: 120_001, cpuMs: undefined, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBe('wall');
    expect(limitHit({ wallMs: 119_000, cpuMs: undefined, cpuLimitMs: 120_000, wallLimitMs: 600_000 })).toBeNull();
    expect(limitHit({ wallMs: 10_000, cpuMs: undefined })).toBeNull();
  });

  it('parseCpuTime reads ps -o time= (macOS, Linux, with days)', () => {
    expect(parseCpuTime('   0:24.31\n')).toBe(24_310);
    expect(parseCpuTime('01:02:03')).toBe(3_723_000);
    expect(parseCpuTime('2-01:00:00')).toBe(176_400_000);
    expect(parseCpuTime('')).toBeUndefined();
    expect(parseCpuTime('abc')).toBeUndefined();
  });

  it('the backstop is 5x the limit, 600 s to 1800 s; the message names the clock and keeps 6a\'s prefix', () => {
    expect(planWallBackstopMs(30_000)).toBe(600_000);
    expect(planWallBackstopMs(120_000)).toBe(600_000);
    expect(planWallBackstopMs(200_000)).toBe(1_000_000);
    expect(planWallBackstopMs(600_000)).toBe(1_800_000);
    const base = { limitMs: 120_000, wallMs: 600_000, elapsedMs: 130_000 };
    expect(kitTimeoutMessage('plan', { ...base, cpu: false, hit: 'wall' })).toBe('the plan took longer than 120 s and was stopped');
    expect(kitTimeoutMessage('plan', { ...base, cpu: true, hit: 'cpu', cpuMs: 120_500 })).toBe('the plan took longer than 120 s of CPU time and was stopped');
    expect(kitTimeoutMessage('plan', { ...base, cpu: true, hit: 'wall', cpuMs: 31_000, elapsedMs: 600_000 })).toBe('the plan took longer than 600 s of wall-clock time (the backstop; 31 s of CPU time used, its limit 120 s of CPU time) and was stopped');
    expect(kitTimeoutMessage('plan', { ...base, cpu: true, hit: 'wall', elapsedMs: 120_200 })).toBe('the plan took longer than 120 s and was stopped (its CPU time could not be read: wall clock)');
    for (const m of [kitTimeoutMessage('plan', { ...base, cpu: true, hit: 'cpu' }), kitTimeoutMessage('plan', { ...base, cpu: true, hit: 'wall', elapsedMs: 600_000 })]) expect(m).toMatch(/^the plan took longer than \d+ s/);
  });

  it.skipIf(process.platform === 'win32')('reads a real child\'s CPU time', async () => {
    const r = await run(process.execPath, ['-e', 'const t = Date.now(); while (Date.now() - t < 600) {}; setTimeout(() => {}, 400)'], { cpuLimitMs: 60_000, cpuPollMs: 100, timeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.limit).toBeUndefined();
    expect(r.cpuMs).toBeGreaterThan(300);
    expect(await childCpuMs(process.pid)).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('a busy child is stopped by CPU time; a sleeping one only by the wall-clock backstop', async () => {
    const busy = await run(process.execPath, ['-e', 'for (;;) {}'], { cpuLimitMs: 500, cpuPollMs: 100, timeoutMs: 20_000 });
    expect(busy.timedOut).toBe(true);
    expect(busy.limit).toBe('cpu');
    expect(busy.cpuMs).toBeGreaterThan(400);
    const t0 = Date.now();
    const idle = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cpuLimitMs: 500, cpuPollMs: 100, timeoutMs: 2_000 });
    expect(idle.timedOut).toBe(true);
    expect(idle.limit).toBe('wall');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);
  }, 30_000);

  it('a child whose CPU time can\'t be read is stopped at the limit by wall clock (the old behaviour, never unlimited)', async () => {
    const t0 = Date.now();
    const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cpuLimitMs: 500, cpuPollMs: 100, timeoutMs: 20_000, cpuOf: async () => undefined });
    expect(r.timedOut).toBe(true);
    expect(r.limit).toBe('wall');
    expect(r.cpuMs).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});
