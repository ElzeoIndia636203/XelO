import { describe, expect, it } from 'vitest';
import { histogram10, learners, mean, normalPdf, sd, toCsv } from '../../src/lib/logic/stats';

describe('stats, learner classification, and CSV formatting', () => {
  it('computes mean, sd, 10-bin histogram, and Gaussian pdf safely including empty input', () => {
    expect(mean([])).toBe(0);
    expect(sd([])).toBe(0);
    expect(normalPdf(50, 50, 0)).toBe(0);

    expect(mean([60, 80])).toBe(70);
    expect(sd([60, 80])).toBe(10);
    expect(normalPdf(70, 70, 10)).toBeCloseTo(1 / (10 * Math.sqrt(2 * Math.PI)), 6);

    expect(histogram10([-5, 0, 15, 99, 100, 110])).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
  });

  it('classifies slow (<40 or bottom 10%) and fast (top 10%) across empty, small, and 12-student classes', () => {
    expect(learners([])).toEqual({ slow: [], fast: [] });

    expect(
      learners([{ studentId: 's1', rollNo: '01', fullName: 'Solo', overallPct: 88 }]),
    ).toEqual({ slow: [], fast: [] });

    const roster = Array.from({ length: 12 }, (_, i) => ({
      studentId: `s-${i + 1}`,
      rollNo: String(100 + i + 1),
      fullName: `Student ${i + 1}`,
      overallPct: i === 0 ? 32 : i === 1 ? 45 : 50 + i * 4, // max 94
    }));
    const res = learners(roster);
    expect(res.slow.map((x) => x.studentId)).toEqual(['s-1']);
    expect(res.fast.map((x) => x.studentId)).toEqual(['s-12']);
  });

  it('quotes RFC 4180 CSV special characters and optionally adds UTF-8 BOM', () => {
    const plain = toCsv(
      ['Name', 'Note'],
      [
        ['Patil, "Aarav"', 'Line1\nLine2'],
        ['Diya', 92],
      ],
    );
    expect(plain).toBe('Name,Note\r\n"Patil, ""Aarav""","Line1\nLine2"\r\nDiya,92\r\n');

    const withBom = toCsv(['A'], [['1']], true);
    expect(withBom.startsWith('\uFEFFA\r\n1\r\n')).toBe(true);
  });
});
