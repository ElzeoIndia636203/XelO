import { emailDomain } from './domain';

export interface RosterRow {
  roll_no: string;
  full_name: string;
  email: string;
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function parseRosterCsv(text: string): RosterRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const delimiter = lines[0]!.includes('\t') ? '\t' : ',';
  const rows = lines.map((line) => parseDelimitedLine(line, delimiter));
  return parseRosterGrid(rows);
}

export function parseRosterGrid(rawRows: readonly (readonly unknown[])[]): RosterRow[] {
  const cleanRows = rawRows
    .map((r) => r.map((c) => String(c ?? '').trim()))
    .filter((r) => r.some(Boolean));
  if (cleanRows.length === 0) return [];

  const first = cleanRows[0]!.map((h) => h.toLowerCase());
  const hasHeader =
    first.some((h) => h.includes('roll') || h.includes('prn') || h.includes('email') || h.includes('name'));

  let rollIdx = 0;
  let nameIdx = 1;
  let emailIdx = 2;
  let startRow = 0;

  if (hasHeader) {
    startRow = 1;
    const r = first.findIndex((h) => h.includes('roll') || h.includes('prn'));
    const n = first.findIndex((h) => h.includes('name'));
    const e = first.findIndex((h) => h.includes('email') || h.includes('mail'));
    if (r >= 0) rollIdx = r;
    if (n >= 0) nameIdx = n;
    if (e >= 0) emailIdx = e;
  }

  const out: RosterRow[] = [];
  for (let i = startRow; i < cleanRows.length; i++) {
    const cols = cleanRows[i]!;
    const roll_no = cols[rollIdx] ?? '';
    const full_name = cols[nameIdx] ?? '';
    const email = (cols[emailIdx] ?? '').toLowerCase();
    if (!roll_no && !full_name && !email) continue;
    out.push({ roll_no, full_name, email });
  }
  return out;
}

export const ALLOWED_PERSONAL_STUDENT_DOMAINS = ['gmail.com', 'outlook.com'] as const;

export function validateRoster(
  rows: readonly RosterRow[],
  institutionDomain: string,
  allowPersonalEmails = false,
): { valid: RosterRow[]; errors: string[] } {
  const errors: string[] = [];
  const valid: RosterRow[] = [];
  const seenEmails = new Set<string>();
  const seenRolls = new Set<string>();
  const expectedDomain = institutionDomain.trim().toLowerCase();

  rows.forEach((row, idx) => {
    const lineNo = idx + 1;
    const roll = row.roll_no.trim();
    const name = row.full_name.trim();
    const email = row.email.trim().toLowerCase();

    if (!roll || !name || !email) {
      errors.push(`Row ${lineNo}: roll number, name, and email are required.`);
      return;
    }
    const dom = emailDomain(email);
    if (!dom) {
      errors.push(`Row ${lineNo}: invalid email (${email}).`);
      return;
    }
    const matchesPersonal =
      allowPersonalEmails &&
      (ALLOWED_PERSONAL_STUDENT_DOMAINS as readonly string[]).includes(dom);
    if (expectedDomain && dom !== expectedDomain && !matchesPersonal) {
      errors.push(
        allowPersonalEmails
          ? `Row ${lineNo}: ${email} must use @${expectedDomain}, @gmail.com, or @outlook.com.`
          : `Row ${lineNo}: ${email} does not match @${expectedDomain}.`,
      );
      return;
    }
    if (seenEmails.has(email)) {
      errors.push(`Row ${lineNo}: duplicate email (${email}).`);
      return;
    }
    if (seenRolls.has(roll.toLowerCase())) {
      errors.push(`Row ${lineNo}: duplicate roll number (${roll}).`);
      return;
    }

    seenEmails.add(email);
    seenRolls.add(roll.toLowerCase());
    valid.push({ roll_no: roll, full_name: name, email });
  });

  return { valid, errors };
}

export type BatchOrderMode = 'prn_asc' | 'random' | 'upload';

function prnLast4Value(rollNo: string): number {
  const digits = rollNo.trim().match(/(\d{1,4})\s*$/);
  if (digits) return Number(digits[1]);
  return Number.MAX_SAFE_INTEGER;
}

export function orderRosterRows(rows: readonly RosterRow[], mode: BatchOrderMode): RosterRow[] {
  const copy = [...rows];
  if (mode === 'upload') return copy;
  if (mode === 'prn_asc') {
    return copy.sort((a, b) => {
      const diff = prnLast4Value(a.roll_no) - prnLast4Value(b.roll_no);
      if (diff !== 0) return diff;
      return a.roll_no.localeCompare(b.roll_no);
    });
  }
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function splitRosterEvenly<T>(rows: readonly T[], maxPerBatch = 65): T[][] {
  if (rows.length === 0) return [];
  const cap = Math.max(1, maxPerBatch);
  const numBatches = Math.max(1, Math.ceil(rows.length / cap));
  const baseSize = Math.floor(rows.length / numBatches);
  const remainder = rows.length % numBatches;

  const batches: T[][] = [];
  let cursor = 0;
  for (let b = 0; b < numBatches; b++) {
    const size = baseSize + (b < remainder ? 1 : 0);
    batches.push(rows.slice(cursor, cursor + size));
    cursor += size;
  }
  return batches;
}
