import { describe, expect, it } from 'vitest';
import {
  applyMerge,
  monitorAlerts,
  overlaps,
  parseMcqCsv,
  parseQuestionsJson,
  pickTwo,
  planDates,
  preTestAnalytics,
  similarity,
  suggestMerge,
  weekOf,
} from '../../src/lib/logic/flows';

describe('session plan date scheduling and topic merging', () => {
  it('plans dates on selected weekdays, skips holidays, reserves last day, and reports shortBy', () => {
    // Wednesdays from 2027-01-06 to 2027-04-21 is 16 Wednesdays
    const res = planDates({
      start: '2027-01-06',
      end: '2027-04-21',
      weekdays: [3],
      holidays: [{ day: '2027-01-27', label: 'Mid-term' }],
      sessions: 30,
      reserveLast: true,
    });

    // 16 Wednesdays - 1 holiday - 1 reserved = 14 lab periods (need 15 -> short by 1)
    expect(res.availablePeriods).toBe(14);
    expect(res.neededPeriods).toBe(15);
    expect(res.shortBy).toBe(1);
    expect(res.periods.some((p) => p.kind === 'blocked')).toBe(true);
    expect(res.periods.some((p) => p.kind === 'reserved')).toBe(true);

    // Extending end by 1 week resolves shortfall
    const enough = planDates({
      start: '2027-01-06',
      end: '2027-04-28',
      weekdays: [3],
      holidays: [{ day: '2027-01-27', label: 'Mid-term' }],
      sessions: 30,
      reserveLast: true,
    });
    expect(enough.shortBy).toBe(0);
    expect(enough.sessionDates).toHaveLength(30);
  });

  it('blocks odd, even, or all Saturdays according to saturdayRule', () => {
    // Jan 2027 Saturdays: Jan 2 (1st/odd), Jan 9 (2nd/even), Jan 16 (3rd/odd), Jan 23 (4th/even)
    const oddBlocked = planDates({
      start: '2027-01-01',
      end: '2027-01-25',
      weekdays: [6],
      holidays: [],
      sessions: 4,
      reserveLast: false,
      saturdayRule: 'odd',
    });
    expect(oddBlocked.sessionDates).toEqual(['2027-01-09', '2027-01-09', '2027-01-23', '2027-01-23']);

    const evenBlocked = planDates({
      start: '2027-01-01',
      end: '2027-01-25',
      weekdays: [6],
      holidays: [],
      sessions: 4,
      reserveLast: false,
      saturdayRule: 'even',
    });
    expect(evenBlocked.sessionDates).toEqual(['2027-01-02', '2027-01-02', '2027-01-16', '2027-01-16']);
  });

  it('suggests merging shortest adjacent topic pair and applies merge', () => {
    const topics = ['Introduction to Input and Output', 'for loop', 'if else', 'Dynamic memory allocation'];
    const suggestion = suggestMerge(topics);
    expect(suggestion).toEqual({
      index: 1,
      a: 'for loop',
      b: 'if else',
      merged: 'for loop & if else',
    });

    const merged = applyMerge(topics, suggestion!.index);
    expect(merged).toEqual([
      'Introduction to Input and Output',
      'for loop & if else',
      'Dynamic memory allocation',
    ]);
  });

  it('picks two valid questions with different difficulty preferring medium and hard', () => {
    expect(
      pickTwo([
        { id: 'q1', difficulty: 'easy', valid: true },
        { id: 'q2', difficulty: 'medium', valid: true },
        { id: 'q3', difficulty: 'hard', valid: false },
        { id: 'q4', difficulty: 'hard', valid: true },
      ]),
    ).toEqual(['q2', 'q4']);

    expect(
      pickTwo([
        { id: 'q1', difficulty: 'easy', valid: true },
        { id: 'q2', difficulty: 'medium', valid: false },
      ]),
    ).toEqual([]);
  });

  it('detects near-duplicate MCQ stems across pre and post banks', () => {
    expect(similarity('What happens if break is omitted?', 'What happens if break is omitted!')).toBe(1);
    const hits = overlaps(
      [{ id: 'p1', stem: 'What happens when break is left out of switch?' }],
      [
        { id: 'q1', stem: 'What happens when break is left out of switch' },
        { id: 'q2', stem: 'Compute time complexity of binary search' },
      ],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.postId).toBe('q1');
  });

  it('parses MCQ CSV and rejects malformed rows cleanly', () => {
    const good = [
      'stage,level,question,options,answer',
      'pre,easy,"What exits a loop early?",break|continue|return|exit,A',
      'post,hard,"Output for n=0?",0|1|error,C',
    ].join('\n');
    const parsedGood = parseMcqCsv(good);
    expect(parsedGood.errors).toEqual([]);
    expect(parsedGood.rows).toHaveLength(2);
    expect(parsedGood.rows[0]?.answer).toBe(0);
    expect(parsedGood.rows[1]?.answer).toBe(2);

    const bad = 'mid,easy,Question?,A|B,D';
    const parsedBad = parseMcqCsv(bad);
    expect(parsedBad.rows).toHaveLength(0);
    expect(parsedBad.errors.length).toBeGreaterThan(0);
  });

  it('parses uploaded JSON lab questions and rejects incomplete test cases or solutions', () => {
    const validJson = JSON.stringify([
      {
        title: 'Sum Array',
        statement: 'Read n integers and print their sum.',
        difficulty: 'medium',
        co_code: 'CO2',
        visible_tests: [
          { input: '3\n1 2 3', expected: '6' },
          { input: '1\n9', expected: '9' },
        ],
        hidden_tests: [
          { input: '2\n-1 1', expected: '0' },
          { input: '4\n10 20 30 40', expected: '100' },
          { input: '1\n0', expected: '0' },
        ],
        references: { c: 'int main(){return 0;}' },
      },
    ]);
    const ok = parseQuestionsJson(validJson);
    expect(ok.errors).toEqual([]);
    expect(ok.questions).toHaveLength(1);

    const badJson = JSON.stringify([{ title: 'Broken', statement: 'No tests', visible_tests: [], hidden_tests: [] }]);
    const bad = parseQuestionsJson(badJson);
    expect(bad.questions).toHaveLength(0);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('computes pre-test analytics tolerating missing item IDs', () => {
    const items = [
      { id: 'i1', level: 'easy' as const, answer: 0 },
      { id: 'i2', level: 'medium' as const, answer: 1 },
      { id: 'i3', level: 'hard' as const, answer: 2 },
    ];
    const analytics = preTestAnalytics(
      [
        {
          item_ids: ['i1', 'i2', 'i3', 'missing-item'],
          answers: { i1: 0, i2: 1, i3: 0 },
          score: 3,
          submitted_at: '2027-01-06T09:00:00Z',
        },
        {
          item_ids: null,
          answers: {},
          score: 5,
          submitted_at: '2027-01-06T09:05:00Z',
        },
      ],
      items,
    );
    expect(analytics.submittedCount).toBe(2);
    expect(analytics.histogram).toEqual([0, 0, 0, 1, 0, 1]);
    expect(analytics.averageScore).toBe(4);
    expect(analytics.byLevel).toEqual({ easy: 100, medium: 100, hard: 0 });
    expect(analytics.insight).toContain('hard');
  });

  it('flags struggling (4+ zero-pass runs) and idle (15+ min) students, excluding absent students', () => {
    const now = Date.parse('2027-01-06T10:30:00Z');
    const alerts = monitorAlerts(
      [
        { id: 's1', rollNo: '2301001', fullName: 'Struggler' },
        { id: 's2', rollNo: '2301002', fullName: 'Idler' },
        { id: 's3', rollNo: '2301003', fullName: 'AbsentStu' },
      ],
      [
        { student_id: 's1', visible_passed: 0, visible_total: 2, hidden_passed: 0, hidden_total: 3, created_at: '2027-01-06T10:10:00Z' },
        { student_id: 's1', visible_passed: 0, visible_total: 2, hidden_passed: 0, hidden_total: 3, created_at: '2027-01-06T10:12:00Z' },
        { student_id: 's1', visible_passed: 0, visible_total: 2, hidden_passed: 0, hidden_total: 3, created_at: '2027-01-06T10:14:00Z' },
        { student_id: 's1', visible_passed: 0, visible_total: 2, hidden_passed: 0, hidden_total: 3, created_at: '2027-01-06T10:25:00Z' },
        { student_id: 's3', visible_passed: 0, visible_total: 2, hidden_passed: 0, hidden_total: 3, created_at: '2027-01-06T10:00:00Z' },
      ],
      new Map([['s2', Date.parse('2027-01-06T10:10:00Z')]]),
      new Set(['s3']),
      now,
    );
    expect(alerts.map((a) => `${a.studentId}:${a.kind}`)).toEqual(['s1:struggling', 's2:idle']);
    expect(weekOf('2027-01-06')).toBe('2027-01-04');
  });
});
