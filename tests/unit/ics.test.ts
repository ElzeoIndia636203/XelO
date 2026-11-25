import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldIcsLine } from '../../supabase/functions/_shared/ics';

describe('RFC 5545 ICS calendar feed generator', () => {
  it('folds long multi-byte UTF-8 lines at <= 75 octets using CRLF + single space', () => {
    const raw = `SUMMARY:${'C programming lab · '.repeat(6)}`;
    const folded = foldIcsLine(raw);
    const segments = folded.split('\r\n');
    expect(segments.length).toBeGreaterThan(1);

    const enc = new TextEncoder();
    for (let i = 0; i < segments.length; i++) {
      expect(enc.encode(segments[i]!).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(segments[i]!.startsWith(' ')).toBe(true);
    }
    expect(folded.replaceAll('\r\n ', '')).toBe(raw);
  });

  it('escapes delimiters and renders valid VCALENDAR VEVENT output with IST timezone metadata', () => {
    expect(escapeIcsText('Room 1, Lab; Block\\A\nBatch B')).toBe('Room 1\\, Lab\\; Block\\\\A\\nBatch B');

    const ics = buildIcs(
      'XeIO Labs',
      [
        {
          uid: 'sess-1@xeio',
          summary: 'CSL-101 · S1 Input & output',
          description: 'Batch A; Lab 3, Main Block',
          day: '2027-01-06',
          location: 'Lab 3',
        },
      ],
      new Date('2026-11-25T10:00:00Z'),
    );

    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('X-WR-TIMEZONE:Asia/Kolkata\r\n');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270106\r\n');
    expect(ics).toContain('DTEND;VALUE=DATE:20270107\r\n');
    expect(ics).toContain('DESCRIPTION:Batch A\\; Lab 3\\, Main Block\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
