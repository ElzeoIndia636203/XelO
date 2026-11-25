export interface AssessmentRules {
  questions_per_student: number;
  mix: { easy: number; medium: number; hard: number };
  visible_count: number;
  hidden_count: number;
  marks_per_test: number;
  viva_marks: number;
  duration_min: number;
}

export const DEFAULT_ASSESSMENT_RULES: AssessmentRules = {
  questions_per_student: 2,
  mix: { easy: 15, medium: 15, hard: 10 },
  visible_count: 2,
  hidden_count: 3,
  marks_per_test: 5,
  viva_marks: 10,
  duration_min: 120,
};

export function validateAssessmentRules(rules: AssessmentRules, coIds: readonly string[]): string[] {
  const errs: string[] = [];
  if (coIds.length < 1) {
    errs.push('Select at least 1 CO.');
  }
  const mixSum = rules.mix.easy + rules.mix.medium + rules.mix.hard;
  if (mixSum !== 40) {
    errs.push(`Difficulty mix must total 40 (currently ${mixSum}).`);
  }
  if (rules.mix.easy < 0 || rules.mix.medium < 0 || rules.mix.hard < 0) {
    errs.push('Difficulty counts cannot be negative.');
  }
  if (rules.questions_per_student < 1) {
    errs.push('Questions per student must be at least 1.');
  }
  if (rules.visible_count < 1 || rules.hidden_count < 1) {
    errs.push('Both visible and hidden test counts must be at least 1.');
  }
  if (rules.marks_per_test <= 0) {
    errs.push('Marks per test must be positive.');
  }
  if (rules.viva_marks < 0) {
    errs.push('Viva marks cannot be negative.');
  }
  if (rules.duration_min <= 0) {
    errs.push('Duration must be positive.');
  }
  return errs;
}

export function paperMarksBreakdown(rules: AssessmentRules): {
  perQuestion: number;
  codingTotal: number;
  viva: number;
  total: number;
} {
  const perQuestion = (rules.visible_count + rules.hidden_count) * rules.marks_per_test;
  const codingTotal = perQuestion * rules.questions_per_student;
  const viva = rules.viva_marks;
  return {
    perQuestion,
    codingTotal,
    viva,
    total: codingTotal + viva,
  };
}

export interface EndsemCandidate {
  id: string;
  co_code: string;
  difficulty: 'easy' | 'medium' | 'hard';
  valid: boolean | null;
}

/**
 * Picks best 30 valid candidates ensuring >= 4 per selected CO code when possible.
 */
export function assistPickBest30(
  candidates: readonly EndsemCandidate[],
  selectedCoCodes: readonly string[],
): string[] {
  const valid = candidates.filter((c) => c.valid === true);
  const picked = new Set<string>();

  for (const co of selectedCoCodes) {
    const forCo = valid.filter((c) => c.co_code === co && !picked.has(c.id));
    for (const item of forCo.slice(0, 4)) {
      if (picked.size < 30) picked.add(item.id);
    }
  }

  for (const item of valid) {
    if (picked.size >= 30) break;
    picked.add(item.id);
  }

  return Array.from(picked);
}

export function isEligibleForEndsem(attendancePct: number, minAttendancePct: number): boolean {
  return attendancePct >= minAttendancePct;
}
