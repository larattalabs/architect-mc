// (6c F3 §7) The forms-II feature: the helper advertises plan.forms2 (appended after RS's region.survival), the mod maps it to formsTrees (with formsCave and
// formsWater); the kit's catalogue supports the five grown forms.
import { describe, expect, it } from 'vitest';
import { FEATURES } from '../src/protocol.js';

describe('(6c F3) plan.forms2', () => {
  it('is appended after plan.rules and RS\'s region.survival (the batch v0.41.0 appends S3\'s and FL\'s after it)', () => {
    expect(FEATURES.indexOf('plan.forms2')).toBe(FEATURES.indexOf('region.survival') + 1);
    expect(FEATURES.indexOf('region.survival')).toBe(FEATURES.indexOf('plan.rules') + 1);
  });
});
