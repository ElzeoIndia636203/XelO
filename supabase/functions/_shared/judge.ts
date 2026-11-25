export type AllowedLang = 'c' | 'cpp' | 'java' | 'python' | 'rust' | 'go';
export type RunMode = 'run' | 'submit';
export type RunContext = 'lab' | 'exam';

export const ALLOWED_LANGS: readonly AllowedLang[] = [
  'c',
  'cpp',
  'java',
  'python',
  'rust',
  'go',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunRequest {
  question_id: string;
  lang: AllowedLang;
  code: string;
  mode: RunMode;
  context: RunContext;
  paper_id: string | null;
}

export interface TestCaseSpec {
  ord: number;
  input: string;
  expected: string;
  marks?: number;
}

export interface ExecutedTestOutcome {
  ord: number;
  passed: boolean;
  status: string;
  actual: string;
  expected: string;
  input: string;
  time_ms: number;
  memory_kb: number;
  compile_error?: string;
}

export interface VisibleTestVerdict {
  ord: number;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  status: string;
  time_ms: number;
}

export interface RunSummary {
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  verdict: string;
  runtime_ms: number;
  memory_kb: number;
}

export interface ClientRunResult extends RunSummary {
  mode: RunMode;
  compile_error: string | null;
  visible_results: VisibleTestVerdict[];
  hidden_summary: { passed: number; total: number };
}

export function normalise(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
}

export function outputsMatch(actual: string, expected: string): boolean {
  return normalise(actual) === normalise(expected);
}

export function parseRunRequest(raw: unknown): RunRequest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_input');
  }
  const obj = raw as Record<string, unknown>;
  const question_id = typeof obj.question_id === 'string' ? obj.question_id.trim() : '';
  const lang = typeof obj.lang === 'string' ? obj.lang.trim() : '';
  const code = typeof obj.code === 'string' ? obj.code : '';
  const mode = typeof obj.mode === 'string' ? obj.mode.trim() : '';
  const context = typeof obj.context === 'string' ? obj.context.trim() : '';
  const paper_id =
    obj.paper_id === undefined || obj.paper_id === null || obj.paper_id === ''
      ? null
      : typeof obj.paper_id === 'string'
        ? obj.paper_id.trim()
        : 'INVALID';

  if (
    !UUID_RE.test(question_id) ||
    !ALLOWED_LANGS.includes(lang as AllowedLang) ||
    code.length === 0 ||
    code.length > 50_000 ||
    (mode !== 'run' && mode !== 'submit') ||
    (context !== 'lab' && context !== 'exam') ||
    (paper_id !== null && !UUID_RE.test(paper_id))
  ) {
    throw new Error('invalid_input');
  }

  return {
    question_id,
    lang: lang as AllowedLang,
    code,
    mode,
    context,
    paper_id,
  };
}

export function summarise(
  visibleOutcomes: readonly ExecutedTestOutcome[],
  hiddenOutcomes: readonly ExecutedTestOutcome[],
): RunSummary {
  const visible_total = visibleOutcomes.length;
  const visible_passed = visibleOutcomes.filter((t) => t.passed).length;
  const hidden_total = hiddenOutcomes.length;
  const hidden_passed = hiddenOutcomes.filter((t) => t.passed).length;

  const all = [...visibleOutcomes, ...hiddenOutcomes];
  const runtime_ms = all.reduce((mx, t) => Math.max(mx, t.time_ms), 0);
  const memory_kb = all.reduce((mx, t) => Math.max(mx, t.memory_kb), 0);

  let verdict = 'accepted';
  const compileErr = all.find((t) => t.compile_error);
  if (compileErr) {
    verdict = 'compile_error';
  } else if (all.some((t) => t.status === 'time_limit_exceeded')) {
    verdict = 'time_limit_exceeded';
  } else if (all.some((t) => t.status === 'runtime_error')) {
    verdict = 'runtime_error';
  } else if (visible_passed < visible_total || hidden_passed < hidden_total) {
    verdict = 'wrong_answer';
  }

  return {
    visible_passed,
    visible_total,
    hidden_passed,
    hidden_total,
    verdict,
    runtime_ms,
    memory_kb,
  };
}

export function toResult(
  mode: RunMode,
  visibleOutcomes: readonly ExecutedTestOutcome[],
  hiddenOutcomes: readonly ExecutedTestOutcome[],
  hiddenTotalOverride?: number,
): ClientRunResult {
  const summary = summarise(visibleOutcomes, hiddenOutcomes);
  const compile_error =
    visibleOutcomes.find((t) => t.compile_error)?.compile_error ??
    hiddenOutcomes.find((t) => t.compile_error)?.compile_error ??
    null;

  const visible_results: VisibleTestVerdict[] = visibleOutcomes.map((t) => ({
    ord: t.ord,
    input: t.input,
    expected: t.expected,
    actual: t.actual,
    passed: t.passed,
    status: t.status,
    time_ms: t.time_ms,
  }));

  const hidden_total =
    typeof hiddenTotalOverride === 'number' ? hiddenTotalOverride : summary.hidden_total;

  return {
    ...summary,
    hidden_total,
    mode,
    compile_error,
    visible_results,
    hidden_summary: {
      passed: summary.hidden_passed,
      total: hidden_total,
    },
  };
}
