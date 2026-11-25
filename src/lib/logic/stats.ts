export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function sd(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mu = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - mu) * (v - mu), 0) / values.length;
  return Math.sqrt(variance);
}

export function histogram10(values: readonly number[]): number[] {
  const bins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of values) {
    const clamped = Math.max(0, Math.min(100, v));
    const idx = Math.min(9, Math.floor(clamped / 10));
    if (idx === 0) bins[0]! += 1;
    else if (idx === 1) bins[1]! += 1;
    else if (idx === 2) bins[2]! += 1;
    else if (idx === 3) bins[3]! += 1;
    else if (idx === 4) bins[4]! += 1;
    else if (idx === 5) bins[5]! += 1;
    else if (idx === 6) bins[6]! += 1;
    else if (idx === 7) bins[7]! += 1;
    else if (idx === 8) bins[8]! += 1;
    else bins[9]! += 1;
  }
  return bins;
}

export function normalPdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return 0;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

export interface LearnerMetricRow {
  studentId: string;
  rollNo: string;
  fullName: string;
  overallPct: number;
}

export interface ClassifiedLearner extends LearnerMetricRow {
  reason: string;
}

export function learners(rows: readonly LearnerMetricRow[]): {
  slow: ClassifiedLearner[];
  fast: ClassifiedLearner[];
} {
  if (rows.length === 0) {
    return { slow: [], fast: [] };
  }

  const asc = [...rows].sort(
    (a, b) => a.overallPct - b.overallPct || a.rollNo.localeCompare(b.rollNo),
  );
  const desc = [...rows].sort(
    (a, b) => b.overallPct - a.overallPct || a.rollNo.localeCompare(b.rollNo),
  );

  const topCount = rows.length >= 10 ? Math.max(1, Math.floor(rows.length * 0.1)) : rows.length >= 2 ? 1 : 0;
  const fastIds = new Set<string>();
  const fast: ClassifiedLearner[] = [];

  for (const r of desc.slice(0, topCount)) {
    if (r.overallPct >= 60) {
      fastIds.add(r.studentId);
      fast.push({ ...r, reason: 'Top 10%' });
    }
  }
  for (const r of desc) {
    if (!fastIds.has(r.studentId) && r.overallPct >= 80 && topCount > 0 && fast.length === 0) {
      fastIds.add(r.studentId);
      fast.push({ ...r, reason: '80% and above' });
    }
  }

  const bottomCount = rows.length >= 10 ? Math.max(1, Math.floor(rows.length * 0.1)) : rows.length >= 3 ? 1 : 0;
  const slowIds = new Set<string>();
  const slow: ClassifiedLearner[] = [];

  for (const r of asc) {
    if (r.overallPct < 40) {
      slowIds.add(r.studentId);
      slow.push({ ...r, reason: 'Below 40%' });
    }
  }
  for (const r of asc.slice(0, bottomCount)) {
    if (!slowIds.has(r.studentId) && !fastIds.has(r.studentId) && r.overallPct < 75) {
      slowIds.add(r.studentId);
      slow.push({ ...r, reason: 'Bottom 10%' });
    }
  }

  return { slow, fast };
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const raw = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
  withBom = false,
): string {
  const lines = [
    headers.map((h) => escapeCsvCell(h)).join(','),
    ...rows.map((r) => r.map((cell) => escapeCsvCell(cell)).join(',')),
  ];
  const body = `${lines.join('\r\n')}\r\n`;
  return withBom ? `\uFEFF${body}` : body;
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
