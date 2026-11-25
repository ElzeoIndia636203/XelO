import { describe, expect, it } from 'vitest';
import { planChecks } from '../../src/lib/logic/checks';

describe('planChecks', () => {
  it('passes when rubric totals 50, all COs are mapped, and BTLs vary', () => {
    const checks = planChecks(
      { att: 10, pre: 5, post: 5, vis: 10, hid: 10, viva: 10 },
      [
        { code: 'CO1', btl: 2 },
        { code: 'CO2', btl: 4 },
      ],
      ['CO1', 'CO2'],
    );
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('flags invalid rubric sum, unmapped CO, and flat BTL', () => {
    const checks = planChecks(
      { att: 10, pre: 5, post: 5, vis: 10, hid: 10, viva: 5 },
      [
        { code: 'CO1', btl: 3 },
        { code: 'CO2', btl: 3 },
      ],
      ['CO1'],
    );
    expect(checks[0]?.ok).toBe(false);
    expect(checks[1]?.ok).toBe(false);
    expect(checks[2]?.ok).toBe(false);
  });
});
