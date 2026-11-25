import { describe, expect, it } from 'vitest';
import {
  assistPickBest30,
  DEFAULT_ASSESSMENT_RULES,
  isEligibleForEndsem,
  paperMarksBreakdown,
  validateAssessmentRules,
} from '../../src/lib/logic/endsem';
import {
  applyProctorWarning,
  formatExamCountdown,
  PROCTOR_WARNING_THRESHOLD,
  remainingDisconnectPauseSeconds,
} from '../../src/lib/logic/proctor';

describe('endsem rules and marks', () => {
  it('validates default rules (mix=40, >=1 CO, positive marks) and computes 25/q, 60 total', () => {
    expect(validateAssessmentRules(DEFAULT_ASSESSMENT_RULES, ['co-1'])).toEqual([]);
    expect(paperMarksBreakdown(DEFAULT_ASSESSMENT_RULES)).toEqual({
      perQuestion: 25,
      codingTotal: 50,
      viva: 10,
      total: 60,
    });
  });

  it('rejects invalid mix, missing COs, and non-positive marks', () => {
    const errs = validateAssessmentRules(
      {
        ...DEFAULT_ASSESSMENT_RULES,
        mix: { easy: 10, medium: 10, hard: 10 },
        marks_per_test: 0,
      },
      [],
    );
    expect(errs).toContain('Select at least 1 CO.');
    expect(errs).toContain('Difficulty mix must total 40 (currently 30).');
    expect(errs).toContain('Marks per test must be positive.');
  });

  it('assistPickBest30 picks 30 valid questions with >=4 per CO when available', () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: `q-${i}`,
      co_code: i < 20 ? 'CO1' : 'CO2',
      difficulty: 'medium' as const,
      valid: i % 10 !== 9, // 36 valid, 4 invalid
    }));
    const picked = assistPickBest30(candidates, ['CO1', 'CO2']);
    expect(picked).toHaveLength(30);
    const co1Count = picked.filter((id) => candidates.find((c) => c.id === id)?.co_code === 'CO1').length;
    const co2Count = picked.filter((id) => candidates.find((c) => c.id === id)?.co_code === 'CO2').length;
    expect(co1Count).toBeGreaterThanOrEqual(4);
    expect(co2Count).toBeGreaterThanOrEqual(4);
  });

  it('checks exam eligibility against institution minimum', () => {
    expect(isEligibleForEndsem(75, 75)).toBe(true);
    expect(isEligibleForEndsem(74.9, 75)).toBe(false);
  });
});

describe('proctor warning and disconnect policy', () => {
  it('flags at 3 warnings and never auto-terminates', () => {
    expect(PROCTOR_WARNING_THRESHOLD).toBe(3);
    expect(applyProctorWarning(0)).toEqual({ warnings: 1, flagged: false, terminated: false });
    expect(applyProctorWarning(1)).toEqual({ warnings: 2, flagged: false, terminated: false });
    expect(applyProctorWarning(2)).toEqual({ warnings: 3, flagged: true, terminated: false });
  });

  it('caps disconnect pause at 5 minutes total', () => {
    expect(remainingDisconnectPauseSeconds(0, 120)).toEqual({
      allowedPause: 120,
      totalUsed: 120,
      exceeded: false,
    });
    expect(remainingDisconnectPauseSeconds(240, 120)).toEqual({
      allowedPause: 60,
      totalUsed: 300,
      exceeded: true,
    });
  });

  it('formats countdown cleanly', () => {
    expect(formatExamCountdown(7200)).toBe('02:00:00');
    expect(formatExamCountdown(65)).toBe('00:01:05');
  });
});
