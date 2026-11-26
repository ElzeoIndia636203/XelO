import type { AllowedLang, ExecutedTestOutcome } from './judge.ts';

export interface ValidateTestSpec {
  ord: number;
  input: string;
  expected: string;
  hidden: boolean;
}

export interface ValidationResult {
  valid: boolean;
  validation_note: string;
}

export async function validateQuestionWithRunner(params: {
  allowedLangs: readonly AllowedLang[];
  tests: readonly ValidateTestSpec[];
  references: Partial<Record<AllowedLang, string>>;
  runTest: (lang: AllowedLang, code: string, tc: ValidateTestSpec) => Promise<ExecutedTestOutcome>;
}): Promise<ValidationResult> {
  if (params.allowedLangs.length === 0) {
    return { valid: false, validation_note: 'No allowed languages configured on course' };
  }
  if (params.tests.length === 0) {
    return { valid: false, validation_note: 'No test cases defined' };
  }

  const refMap = new Map<string, string>(Object.entries(params.references));
  for (const lang of params.allowedLangs) {
    const code = refMap.get(lang)?.trim();
    if (!code) {
      return {
        valid: false,
        validation_note: `Missing reference solution for ${lang}`,
      };
    }

    const outcomes = await Promise.all(
      params.tests.map(async (tc) => {
        try {
          const outcome = await params.runTest(lang, code, tc);
          return { tc, outcome, err: null as string | null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'runner_error';
          return { tc, outcome: null, err: msg };
        }
      }),
    );

    for (const item of outcomes) {
      if (item.err !== null) {
        return {
          valid: false,
          validation_note: `${lang} failed ${item.tc.hidden ? 'hidden ' : ''}case ${item.tc.ord}: ${item.err}`,
        };
      }
      if (!item.outcome || !item.outcome.passed) {
        return {
          valid: false,
          validation_note: `${lang} failed ${item.tc.hidden ? 'hidden ' : ''}case ${item.tc.ord}: ${item.outcome?.status ?? 'wrong_answer'}`,
        };
      }
    }
  }

  return {
    valid: true,
    validation_note: `Passed all ${params.tests.length} cases in ${params.allowedLangs.join(', ')}`,
  };
}
