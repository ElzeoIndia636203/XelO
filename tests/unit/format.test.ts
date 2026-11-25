import { describe, expect, it } from 'vitest';
import { formatDateIst, formatTimeIst, todayIso } from '../../src/lib/format';

describe('format helpers', () => {
  it('formats dates and times in IST', () => {
    const sample = '2026-11-25T09:30:00.000Z';
    expect(formatDateIst(sample)).toContain('2026');
    expect(formatTimeIst(sample)).toMatch(/3:00\s*pm/i);
  });

  it('returns YYYY-MM-DD for todayIso', () => {
    expect(todayIso(new Date('2026-11-25T20:00:00.000Z'))).toBe('2026-11-26');
  });
});
