import type { RubricWeights } from '../types';

export type AttendanceState = 'present' | 'late' | 'absent';

export interface QuestionProgressInput {
  visPassed: number;
  visTotal: number;
  hidPassed: number;
  hidTotal: number;
}

export interface SessionMarksInput {
  attendance: AttendanceState | null;
  preCorrect: number;
  postCorrect: number;
  questions: readonly QuestionProgressInput[];
  viva: number;
}

export interface SessionMarksBreakdown {
  att: number;
  pre: number;
  post: number;
  vis: number;
  hid: number;
  viva: number;
  total: number;
  outOf: number;
}

export function sessionMarks(
  input: SessionMarksInput,
  rubric: RubricWeights,
): SessionMarksBreakdown {
  const att =
    input.attendance === 'present'
      ? rubric.att
      : input.attendance === 'late'
        ? rubric.att / 2
        : 0;

  const clampedPre = Math.max(0, Math.min(5, input.preCorrect));
  const clampedPost = Math.max(0, Math.min(5, input.postCorrect));
  const pre = (clampedPre / 5) * rubric.pre;
  const post = (clampedPost / 5) * rubric.post;

  const visTotals = input.questions.reduce(
    (acc, q) => ({ passed: acc.passed + Math.max(0, q.visPassed), total: acc.total + Math.max(0, q.visTotal) }),
    { passed: 0, total: 0 },
  );
  const hidTotals = input.questions.reduce(
    (acc, q) => ({ passed: acc.passed + Math.max(0, q.hidPassed), total: acc.total + Math.max(0, q.hidTotal) }),
    { passed: 0, total: 0 },
  );

  const vis = visTotals.total > 0 ? Math.min(1, visTotals.passed / visTotals.total) * rubric.vis : 0;
  const hid = hidTotals.total > 0 ? Math.min(1, hidTotals.passed / hidTotals.total) * rubric.hid : 0;

  const viva =
    input.attendance === 'absent' || input.attendance === null
      ? 0
      : Math.max(0, Math.min(rubric.viva, input.viva));

  const outOf = rubric.att + rubric.pre + rubric.post + rubric.vis + rubric.hid + rubric.viva;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const parts = {
    att: round2(att),
    pre: round2(pre),
    post: round2(post),
    vis: round2(vis),
    hid: round2(hid),
    viva: round2(viva),
  };

  return {
    ...parts,
    total: round2(parts.att + parts.pre + parts.post + parts.vis + parts.hid + parts.viva),
    outOf,
  };
}

export function internalOutOf100(
  sessionRawTotals: readonly number[],
  rubricTotal = 50,
): number {
  if (sessionRawTotals.length === 0 || rubricTotal <= 0) return 0;
  const mean =
    sessionRawTotals.reduce((acc, v) => acc + Math.max(0, v), 0) / sessionRawTotals.length;
  return Math.round((mean / rubricTotal) * 1000) / 10;
}

export function attendancePct(states: readonly AttendanceState[]): number {
  if (states.length === 0) return 0;
  const attended = states.filter((s) => s === 'present' || s === 'late').length;
  return Math.round((attended / states.length) * 100);
}
