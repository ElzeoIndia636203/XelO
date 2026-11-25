import { describe, expect, it } from 'vitest';
import {
  normalise,
  outputsMatch,
  parseRunRequest,
  summarise,
  toResult,
  type ExecutedTestOutcome,
} from '../../supabase/functions/_shared/judge';
import {
  buildSubmissionPayload,
  fromBase64,
  JUDGE0_LIMITS,
  resolveLanguageIds,
  runOnJudge0,
  toBase64,
} from '../../supabase/functions/_shared/judge0';
import { validateQuestionWithRunner } from '../../supabase/functions/_shared/validate';

const Q_UUID = '11111111-1111-1111-1111-111111111111';

describe('judge helpers, redaction, and mocked Judge0 orchestration', () => {
  it('normalises trailing spaces/CR/newlines and compares outputs', () => {
    expect(normalise('42  \r\n99\t\n\n')).toBe('42\n99');
    expect(outputsMatch('hello   \r\nworld\n\n', 'hello\nworld')).toBe(true);
    expect(outputsMatch('41', '42')).toBe(false);
  });

  it('validates run requests including max code size of 50,000 chars', () => {
    const ok = parseRunRequest({
      question_id: Q_UUID,
      lang: 'python',
      code: 'print(1)',
      mode: 'run',
      context: 'lab',
    });
    expect(ok.lang).toBe('python');
    expect(ok.paper_id).toBeNull();

    expect(() =>
      parseRunRequest({
        question_id: Q_UUID,
        lang: 'c',
        code: 'a'.repeat(50_001),
        mode: 'submit',
        context: 'lab',
      }),
    ).toThrow('invalid_input');

    expect(() =>
      parseRunRequest({
        question_id: 'not-a-uuid',
        lang: 'c',
        code: 'int main(){}',
        mode: 'run',
        context: 'lab',
      }),
    ).toThrow('invalid_input');
  });

  it('summarises verdicts and redacts hidden inputs, expected outputs, and stdout from client responses', () => {
    const visible: ExecutedTestOutcome[] = [
      {
        ord: 1,
        passed: true,
        status: 'accepted',
        input: '1 2',
        expected: '3',
        actual: '3\n',
        time_ms: 12,
        memory_kb: 1024,
      },
      {
        ord: 2,
        passed: true,
        status: 'accepted',
        input: '4 5',
        expected: '9',
        actual: '9',
        time_ms: 14,
        memory_kb: 1040,
      },
    ];
    const hidden: ExecutedTestOutcome[] = [
      {
        ord: 3,
        passed: true,
        status: 'accepted',
        input: 'SECRET_INPUT_ALPHA',
        expected: 'SECRET_EXPECTED_ALPHA',
        actual: 'SECRET_ACTUAL_ALPHA',
        time_ms: 20,
        memory_kb: 2048,
      },
      {
        ord: 4,
        passed: false,
        status: 'wrong_answer',
        input: 'SECRET_INPUT_BETA',
        expected: 'SECRET_EXPECTED_BETA',
        actual: 'SECRET_ACTUAL_BETA',
        time_ms: 18,
        memory_kb: 2048,
      },
    ];

    const summary = summarise(visible, hidden);
    expect(summary.verdict).toBe('wrong_answer');
    expect(summary.visible_passed).toBe(2);
    expect(summary.hidden_passed).toBe(1);

    const payload = toResult('submit', visible, hidden);
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('SECRET_INPUT');
    expect(serialised).not.toContain('SECRET_EXPECTED');
    expect(serialised).not.toContain('SECRET_ACTUAL');
    expect(payload.hidden_summary).toEqual({ passed: 1, total: 2 });
    expect(payload.visible_results).toHaveLength(2);
  });

  it('encodes UTF-8 base64 payloads with Judge0 security limits and handles mocked run and submit responses', async () => {
    const text = 'int main() { return 0; } // αβγ';
    expect(fromBase64(toBase64(text))).toBe(text);

    const ids = resolveLanguageIds(JSON.stringify({ python: 109 }));
    expect(ids.python).toBe(109);
    expect(ids.c).toBe(50);

    const built = buildSubmissionPayload({ lang: 'c', code: 'int main(){}', stdin: '5\n', langIds: ids });
    expect(built.cpu_time_limit).toBe(JUDGE0_LIMITS.cpu_time_limit);
    expect(built.memory_limit).toBe(JUDGE0_LIMITS.memory_limit);
    expect(built.max_file_size).toBe(JUDGE0_LIMITS.max_file_size);
    expect(built.enable_network).toBe(false);

    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stdin: string };
      const stdinVal = fromBase64(body.stdin).trim();
      const out = String(Number(stdinVal) * 2);
      return new Response(
        JSON.stringify({
          stdout: toBase64(`${out}\n`),
          stderr: '',
          compile_output: '',
          time: '0.015',
          memory: 3200,
          status: { id: stdinVal === '99' ? 5 : 3 },
        }),
        { status: 200 },
      );
    };

    const okCase = await runOnJudge0(
      { baseUrl: 'https://judge.local', fetchFn: mockFetch, langIds: ids },
      'c',
      'int main(){}',
      { ord: 1, input: '7\n', expected: '14' },
    );
    expect(okCase.passed).toBe(true);
    expect(okCase.status).toBe('accepted');

    const tleCase = await runOnJudge0(
      { baseUrl: 'https://judge.local', fetchFn: mockFetch, langIds: ids },
      'c',
      'int main(){}',
      { ord: 2, input: '99\n', expected: '198' },
    );
    expect(tleCase.passed).toBe(false);
    expect(tleCase.status).toBe('time_limit_exceeded');
  });

  it('validates a question across all enabled languages and reports failing hidden case details', async () => {
    const tests = [
      { ord: 1, input: '1', expected: '2', hidden: false },
      { ord: 2, input: '2', expected: '4', hidden: true },
    ];
    const ok = await validateQuestionWithRunner({
      allowedLangs: ['c', 'python'],
      tests,
      references: { c: 'c code', python: 'py code' },
      runTest: async (_l, _c, tc) => ({
        ord: tc.ord,
        passed: true,
        status: 'accepted',
        actual: tc.expected,
        expected: tc.expected,
        input: tc.input,
        time_ms: 10,
        memory_kb: 500,
      }),
    });
    expect(ok.valid).toBe(true);

    const fail = await validateQuestionWithRunner({
      allowedLangs: ['c', 'python'],
      tests,
      references: { c: 'c code', python: 'py code' },
      runTest: async (lang, _c, tc) => ({
        ord: tc.ord,
        passed: !(lang === 'python' && tc.hidden),
        status: lang === 'python' && tc.hidden ? 'wrong_answer' : 'accepted',
        actual: '0',
        expected: tc.expected,
        input: tc.input,
        time_ms: 10,
        memory_kb: 500,
      }),
    });
    expect(fail.valid).toBe(false);
    expect(fail.validation_note).toBe('python failed hidden case 2: wrong_answer');
  });
});
