// (6c F3 §7) The forms-II feature: the helper advertises plan.forms2 (appended last), the mod maps it to formsTrees (with formsCave and
// formsWater); the kit's catalogue supports the five grown forms.
import { describe, expect, it } from 'vitest';
import { FEATURES } from '../src/protocol.js';

describe('(6c F3) plan.forms2', () => {
  it('is appended last', () => {
    expect(FEATURES[FEATURES.length - 1]).toBe('plan.forms2');
    expect(FEATURES.indexOf('plan.rules')).toBe(FEATURES.length - 2);
  });
});
