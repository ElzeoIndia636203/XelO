import { describe, expect, it } from 'vitest';
import {
  parseRosterCsv,
  parseRosterGrid,
  splitRosterEvenly,
  validateRoster,
} from '../../src/lib/logic/roster';

describe('roster parsing, domain checks, and even split', () => {
  it('splits 126 students evenly into 63 + 63 and 125 into 63 + 62', () => {
    const rows126 = Array.from({ length: 126 }, (_, i) => i + 1);
    const b126 = splitRosterEvenly(rows126, 65);
    expect(b126).toHaveLength(2);
    expect(b126[0]).toHaveLength(63);
    expect(b126[1]).toHaveLength(63);

    const rows125 = Array.from({ length: 125 }, (_, i) => i + 1);
    const b125 = splitRosterEvenly(rows125, 65);
    expect(b125).toHaveLength(2);
    expect(b125[0]).toHaveLength(63);
    expect(b125[1]).toHaveLength(62);

    expect(splitRosterEvenly([], 65)).toEqual([]);
  });

  it('parses CSV with headers and validates domain and duplicates', () => {
    const csv = [
      'Roll No,Full Name,Email',
      '2301001,"Patil, Aarav",aarav@sanjivani.edu.in',
      '2301002,Meera Joshi,meera@gmail.com',
      '2301003,Dup Email,aarav@sanjivani.edu.in',
    ].join('\n');

    const parsed = parseRosterCsv(csv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      roll_no: '2301001',
      full_name: 'Patil, Aarav',
      email: 'aarav@sanjivani.edu.in',
    });

    const { valid, errors } = validateRoster(parsed, 'sanjivani.edu.in');
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('@sanjivani.edu.in');
    expect(errors[1]).toContain('duplicate email');
  });

  it('parses grid rows without header', () => {
    const rows = parseRosterGrid([
      ['2301010', 'Riya Shah', 'riya@sanjivani.edu.in'],
    ]);
    expect(rows).toEqual([
      { roll_no: '2301010', full_name: 'Riya Shah', email: 'riya@sanjivani.edu.in' },
    ]);
  });
});
