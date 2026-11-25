import { describe, expect, it } from 'vitest';
import { coAttainment, level, overall, poAttainment } from '../../src/lib/logic/attainment';

describe('attainment calculations', () => {
  it('computes levels at 60/70/80 thresholds cleanly', () => {
    expect(level(59)).toBe(0);
    expect(level(60)).toBe(1);
    expect(level(69.9)).toBe(1);
    expect(level(70)).toBe(2);
    expect(level(79)).toBe(2);
    expect(level(80)).toBe(3);
    expect(level(100)).toBe(3);
  });

  it('computes CO attainment for empty and non-empty student scores', () => {
    expect(coAttainment([])).toEqual({ attainedCount: 0, totalCount: 0, pct: 0, level: 0 });
    expect(coAttainment([80, 65, 60, 55, 70])).toEqual({
      attainedCount: 4,
      totalCount: 5,
      pct: 80,
      level: 3,
    });
    expect(coAttainment([50, 58, 62])).toEqual({
      attainedCount: 1,
      totalCount: 3,
      pct: 33,
      level: 0,
    });
  });

  it('combines internal and end-sem with configurable 40/60 weights and computes PO weighted levels', () => {
    expect(overall(75, 85)).toBe(81);
    expect(overall(50, 90, 0.5, 0.5)).toBe(70);

    const pos = poAttainment(
      [
        { coId: 'co-1', level: 3 },
        { coId: 'co-2', level: 1 },
      ],
      [
        { co_id: 'co-1', po_code: 'PO1', level: 3 },
        { co_id: 'co-2', po_code: 'PO1', level: 1 },
        { co_id: 'co-2', po_code: 'PO2', level: 0 },
        { co_id: 'co-2', po_code: 'PSO1', level: 2 },
      ],
    );
    expect(pos).toEqual([
      { poCode: 'PO1', attainment: 2.5, mappedCos: 2 },
      { poCode: 'PSO1', attainment: 1, mappedCos: 1 },
    ]);
  });
});
