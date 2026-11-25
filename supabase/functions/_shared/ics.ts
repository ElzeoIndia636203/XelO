export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  day: string; // YYYY-MM-DD (IST)
  location?: string;
}

const enc = new TextEncoder();

export function escapeIcsText(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * Folds an iCalendar content line per RFC 5545 §3.1 at <= 75 UTF-8 octets
 * without splitting multi-byte code points.
 */
export function foldIcsLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;

  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > limit && cur.length > 0) {
      chunks.push(chunks.length === 0 ? cur : ` ${cur}`);
      cur = ch;
      curBytes = chBytes;
      limit = 74; // reserve 1 byte for leading space on continuation lines
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur.length > 0) {
    chunks.push(chunks.length === 0 ? cur : ` ${cur}`);
  }
  return chunks.join('\r\n');
}

function nextDayIso(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day.replaceAll('-', '');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

function dtStampUtc(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

export function buildIcs(
  calName: string,
  events: readonly IcsEvent[],
  now: Date = new Date(),
): string {
  const stamp = dtStampUtc(now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//XeIO//Elzeo Future Technologies//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(calName)}`),
    'X-WR-TIMEZONE:Asia/Kolkata',
  ];

  for (const ev of events) {
    const startCompact = ev.day.replaceAll('-', '');
    const endCompact = nextDayIso(ev.day);
    lines.push('BEGIN:VEVENT');
    lines.push(foldIcsLine(`UID:${escapeIcsText(ev.uid)}`));
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${startCompact}`);
    lines.push(`DTEND;VALUE=DATE:${endCompact}`);
    lines.push(foldIcsLine(`SUMMARY:${escapeIcsText(ev.summary)}`));
    if (ev.description) {
      lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(ev.description)}`));
    }
    if (ev.location) {
      lines.push(foldIcsLine(`LOCATION:${escapeIcsText(ev.location)}`));
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
