import { describe, expect, it } from 'vitest';
import { computeCreditStatus, creditTone, usagePct } from '../../src/lib/logic/credits';

describe('credit status logic', () => {
  it('returns No active plan when planActive is false or cap is 0', () => {
    expect(
      computeCreditStatus({
        totalUsed: 0,
        totalCap: 125,
        todayUsed: 0,
        dailyCap: 5,
        planActive: false,
      }),
    ).toBe('No active plan');
  });

  it('detects total cap, daily cap, running low, and OK states', () => {
    expect(
      computeCreditStatus({
        totalUsed: 125,
        totalCap: 125,
        todayUsed: 0,
        dailyCap: 5,
        planActive: true,
      }),
    ).toBe('Subscription runs used up');

    expect(
      computeCreditStatus({
        totalUsed: 100,
        totalCap: 125,
        todayUsed: 5,
        dailyCap: 5,
        planActive: true,
      }),
    ).toBe('Daily cap reached');

    expect(
      computeCreditStatus({
        totalUsed: 112,
        totalCap: 125,
        todayUsed: 1,
        dailyCap: 5,
        planActive: true,
      }),
    ).toBe('Running low');

    expect(
      computeCreditStatus({
        totalUsed: 38,
        totalCap: 125,
        todayUsed: 3,
        dailyCap: 5,
        planActive: true,
      }),
    ).toBe('OK');
  });

  it('clamps usagePct and maps tones', () => {
    expect(usagePct(0, 0)).toBe(0);
    expect(usagePct(150, 125)).toBe(100);
    expect(usagePct(63, 125)).toBe(50);
    expect(creditTone('OK')).toBe('good');
    expect(creditTone('Running low')).toBe('warn');
    expect(creditTone('Daily cap reached')).toBe('bad');
  });
});
