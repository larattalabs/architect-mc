// kit/test/village.test.mjs item 1, claims 250-374 of the 500 (village-layout.mjs).
import test from 'node:test';
import { assertQuarter, layoutClaims } from './village-layout.mjs';

test('layout: seeded synthetic flat claims 250-374 of 500 (no overlap, margin, gaps, fronting, lanes outside boxes and keep-out, unplaced exact, deterministic)', async () => {
  assertQuarter(await layoutClaims(250, 375));
});
