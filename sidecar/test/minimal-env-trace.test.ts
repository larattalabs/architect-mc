// minimalEnv passes the gate runner's input tracer through to the kit tools it spawns, and nothing else of ours
// (tools/lib/step-trace.mjs; docs/GATES.md "Coverage-based inputs")
import { describe, expect, it } from 'vitest';
import { minimalEnv } from '../src/designs.js';

describe('minimalEnv and the gate tracer', () => {
  it('drops NODE_OPTIONS outside a gate run', () => {
    const e = minimalEnv({ PATH: '/bin', NODE_OPTIONS: '--import=file:///x/tools/lib/step-trace.mjs', SECRET: 's' });
    expect(e.NODE_OPTIONS).toBeUndefined();
    expect(e.SECRET).toBeUndefined();
  });
  it('keeps only the tracer import inside a gate run', () => {
    const e = minimalEnv({ PATH: '/bin', GATE_TRACE_DIR: '/t', GATE_TRACE_ROOTS: '[]', NODE_OPTIONS: '--max-old-space-size=99 --import=file:///x/tools/lib/step-trace.mjs', SECRET: 's' });
    expect(e.NODE_OPTIONS).toBe('--import=file:///x/tools/lib/step-trace.mjs');
    expect(e.GATE_TRACE_DIR).toBe('/t');
    expect(e.SECRET).toBeUndefined();
  });
  it('ignores any other --import', () => {
    const e = minimalEnv({ PATH: '/bin', GATE_TRACE_DIR: '/t', NODE_OPTIONS: '--import=file:///evil.mjs' });
    expect(e.NODE_OPTIONS).toBeUndefined();
  });
});
