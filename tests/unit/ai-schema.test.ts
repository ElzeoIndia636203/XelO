import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  validateAnnouncementDraft,
  validateBankDraft,
  validateClassTaskDraft,
  validateLabCandidatesDraft,
  validateOutcomesDraft,
  validateReportNarrativeDraft,
} from '../../supabase/functions/_shared/ai-schema';

describe('AI outcomes schema validation', () => {
  it('extracts fenced JSON and validates valid outcomes draft', () => {
    const raw = [
      '```json',
      JSON.stringify({
        outcomes: [
          { code: 'CO1', statement: 'Write C programs using I/O', btl: 3, unit: 1 },
          { code: 'CO2', statement: 'Implement iterative loops', btl: 3, unit: 2 },
        ],
        map: [
          { co: 'CO1', po: 'PO1', level: 3 },
          { co: 'CO2', po: 'PSO1', level: 2 },
        ],
      }),
      '```',
    ].join('\n');

    const parsed = extractJsonObject(raw);
    const validated = validateOutcomesDraft(parsed);
    expect(validated.outcomes).toHaveLength(2);
    expect(validated.map).toHaveLength(2);
  });

  it('rejects out-of-range BTL or unreferenced CO in map', () => {
    expect(() =>
      validateOutcomesDraft({
        outcomes: [{ code: 'CO1', statement: 'Valid statement', btl: 9, unit: 1 }],
        map: [],
      }),
    ).toThrow('invalid_ai_shape');

    expect(() =>
      validateOutcomesDraft({
        outcomes: [{ code: 'CO1', statement: 'Valid statement', btl: 3, unit: 1 }],
        map: [{ co: 'CO9', po: 'PO1', level: 2 }],
      }),
    ).toThrow('invalid_ai_shape');
  });

  it('validates 4 lab candidates with 2 visible + 3 hidden tests and rejects missing required language or duplicates', () => {
    const makeCand = (idx: number) => ({
      title: `Array Task ${idx}`,
      statement: `Solve problem number ${idx} over standard input integers.`,
      difficulty: idx === 1 ? 'easy' : idx === 3 ? 'hard' : 'medium',
      co_code: 'CO2',
      visible_tests: [
        { input: '1', expected: '1' },
        { input: '2', expected: '2' },
      ],
      hidden_tests: [
        { input: '3', expected: '3' },
        { input: '4', expected: '4' },
        { input: '5', expected: '5' },
      ],
      references: { c: 'int main(){return 0;}', python: 'print(input())' },
    });

    const ok = validateLabCandidatesDraft({ candidates: [1, 2, 3, 4].map(makeCand) }, ['c', 'python']);
    expect(ok).toHaveLength(4);

    expect(() =>
      validateLabCandidatesDraft({ candidates: [1, 2, 3, 4].map(makeCand) }, ['c', 'cpp']),
    ).toThrow('invalid_ai_shape');

    expect(() =>
      validateLabCandidatesDraft(
        { candidates: [1, 2, 3, 4].map(makeCand) },
        ['c'],
        ['Array Task 2'],
      ),
    ).toThrow('invalid_ai_shape');
  });

  it('validates 45 pre + 45 post bank items and rejects pre/post overlap', () => {
    const build45 = (prefix: string) =>
      (['easy', 'medium', 'hard'] as const).flatMap((level) =>
        Array.from({ length: 15 }, (_, i) => ({
          level,
          stem: `${prefix} ${level} question prompt ${i + 1}`,
          options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'],
          answer: i % 4,
        })),
      );

    const ok = validateBankDraft({ pre: build45('Pre'), post: build45('Post') });
    expect(ok.pre).toHaveLength(45);
    expect(ok.post).toHaveLength(45);

    const dupPost = build45('Post');
    dupPost[0]!.stem = 'Pre easy question prompt 1!';
    expect(() => validateBankDraft({ pre: build45('Pre'), post: dupPost })).toThrow('bank_overlap');
  });

  it('validates class_task, announcement, and report_narrative AI outputs', () => {
    const task = validateClassTaskDraft({
      title: 'Predict pointer swap',
      body: 'What does this print?',
      payload: { code: 'printf("%d", 1);', options: ['1', '0'] },
      answer_key: { expected: '1' },
    });
    expect(task.title).toBe('Predict pointer swap');

    const ann = validateAnnouncementDraft({
      title: 'Lab 7 reminder',
      body: 'Pre-test closes at 09:59 tomorrow.',
    });
    expect(ann.body).toContain('09:59');

    const rep = validateReportNarrativeDraft({
      internal_summary: 'Cohort mean 72%.',
      overall_summary: 'Pending end-sem practical.',
      bos_suggestions: 'Add one pointer lab.',
    });
    expect(rep.bos_suggestions).toContain('pointer');
  });
});
