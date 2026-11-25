import { describe, expect, it } from 'vitest';
import {
  attendancePct,
  internalOutOf100,
  sessionMarks,
} from '../../src/lib/logic/rubric';

const DEFAULT_RUBRIC = { att: 10, pre: 5, post: 5, vis: 10, hid: 10, viva: 10 };

describe('rubric marks, internal /100, and attendance %', () => {
  it('computes full present, half late attendance, and zero absent attendance/viva', () => {
    const present = sessionMarks(
      {
        attendance: 'present',
        preCorrect: 4,
        postCorrect: 5,
        questions: [
          { visPassed: 2, visTotal: 2, hidPassed: 3, hidTotal: 3 },
          { visPassed: 2, visTotal: 2, hidPassed: 2, hidTotal: 3 },
        ],
        viva: 8,
      },
      DEFAULT_RUBRIC,
    );
    expect(present.att).toBe(10);
    expect(present.pre).toBe(4);
    expect(present.post).toBe(5);
    expect(present.vis).toBe(10);
    expect(present.hid).toBe(8.33);
    expect(present.viva).toBe(8);
    expect(present.total).toBe(45.33);

    const late = sessionMarks(
      {
        attendance: 'late',
        preCorrect: 5,
        postCorrect: 0,
        questions: [{ visPassed: 1, visTotal: 2, hidPassed: 0, hidTotal: 3 }],
        viva: 6,
      },
      DEFAULT_RUBRIC,
    );
    expect(late.att).toBe(5);
    expect(late.viva).toBe(6);

    const absent = sessionMarks(
      {
        attendance: 'absent',
        preCorrect: 0,
        postCorrect: 0,
        questions: [],
        viva: 9,
      },
      DEFAULT_RUBRIC,
    );
    expect(absent.att).toBe(0);
    expect(absent.viva).toBe(0);
    expect(absent.total).toBe(0);
  });

  it('scales internal marks out of 100 and computes attendance % handling empty sets', () => {
    expect(internalOutOf100([])).toBe(0);
    expect(internalOutOf100([40, 50])).toBe(90);
    expect(attendancePct([])).toBe(0);
    expect(attendancePct(['present', 'late', 'absent', 'present'])).toBe(75);
  });
});
