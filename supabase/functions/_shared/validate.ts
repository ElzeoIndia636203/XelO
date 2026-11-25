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

    for (const tc of params.tests) {
      let outcome: ExecutedTestOutcome;
      try {
        outcome = await params.runTest(lang, code, tc);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'runner_error';
        return {
          valid: false,
          validation_note: `${lang} failed ${tc.hidden ? 'hidden ' : ''}case ${tc.ord}: ${msg}`,
        };
      }

      if (!outcome.passed) {
        return {
          valid: false,
          validation_note: `${lang} failed ${tc.hidden ? 'hidden ' : ''}case ${tc.ord}: ${outcome.status}`,
        };
      }
    }
  }

  return {
    valid: true,
    validation_note: `Passed all ${params.tests.length} cases in ${params.allowedLangs.join(', ')}`,
  };
}
