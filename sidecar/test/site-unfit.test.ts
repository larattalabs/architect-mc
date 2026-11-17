// (UI slice) SITE_UNFIT refuses on a site ERROR only (site_bound, site_keep); site warnings pass, as they do for a plain design.
// DS's reading 3 refused on any finding, so a design installed with a site warning refused its own variant on the same site.
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/designs.js';
import { unfitMessage, unfitRule } from '../src/sitevariants.js';

const res = (ok: boolean, findings: Array<Record<string, unknown>> | null): CheckResult => ({
  ok,
  warnings: [],
  output: findings ? `log line\n${JSON.stringify({ site: { fit: 'attach_to_cliff', ok: findings.length === 0, findings } })}\n` : 'no json',
});

describe('unfitRule', () => {
  it('passes a build whose only site findings are warnings', () => {
    const r = res(true, [{ rule: 'cantilever', severity: 'warning', message: 'cantilever: 9 > 8' }, { rule: 'floors_reachable', severity: 'warning', message: 'x' }]);
    expect(unfitRule(r)).toBeUndefined();
  });
  it('refuses with the first error, even after a warning', () => {
    const r = res(true, [{ rule: 'cantilever', severity: 'warning', message: 'w' }, { rule: 'site_keep', severity: 'error', message: 'site_keep: a player pillar' }]);
    expect(unfitRule(r)).toBe('site_keep');
    expect(unfitMessage(r)).toBe('site_keep: a player pillar');
  });
  it('a finding without a severity counts as an error', () => {
    expect(unfitRule(res(true, [{ rule: 'site_bound', message: 'm' }]))).toBe('site_bound');
  });
  it('a build that failed is site_bound; a clean one passes', () => {
    expect(unfitRule(res(false, null))).toBe('site_bound');
    expect(unfitRule(res(true, []))).toBeUndefined();
    expect(unfitRule(res(true, null))).toBeUndefined();
  });
});
