export interface PlanDatesInput {
  start: string;
  end: string;
  weekdays: readonly number[];
  holidays: ReadonlyArray<{ day: string; label?: string }>;
  sessions: number;
  reserveLast: boolean;
}

export interface PlannedPeriod {
  date: string;
  kind: 'lab' | 'blocked' | 'reserved' | 'spare';
  label: string;
  sessionIndices: number[];
}

export interface PlanDatesResult {
  periods: PlannedPeriod[];
  availablePeriods: number;
  neededPeriods: number;
  shortBy: number;
  sessionDates: string[];
}

function toUtcDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function planDates(input: PlanDatesInput): PlanDatesResult {
  const startDate = toUtcDate(input.start);
  const endDate = toUtcDate(input.end);
  const sessionCount = Math.max(0, input.sessions);
  const neededPeriods = Math.ceil(sessionCount / 2);

  if (!startDate || !endDate || startDate > endDate || input.weekdays.length === 0) {
    return {
      periods: [],
      availablePeriods: 0,
      neededPeriods,
      shortBy: neededPeriods,
      sessionDates: [],
    };
  }

  const weekdaySet = new Set(input.weekdays);
  const holidayMap = new Map(input.holidays.map((h) => [h.day, h.label?.trim() || 'Holiday']));

  const slots: Array<{ date: string; blockedLabel: string | null }> = [];
  const cur = new Date(startDate.getTime());
  while (cur <= endDate) {
    if (weekdaySet.has(cur.getUTCDay())) {
      const iso = toIsoDate(cur);
      slots.push({ date: iso, blockedLabel: holidayMap.get(iso) ?? null });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  let reservedDate: string | null = null;
  if (input.reserveLast) {
    for (let i = slots.length - 1; i >= 0; i--) {
      if (!slots[i]!.blockedLabel) {
        reservedDate = slots[i]!.date;
        break;
      }
    }
  }

  let labCursor = 0;
  const periods: PlannedPeriod[] = [];
  const sessionDates: string[] = [];

  for (const slot of slots) {
    if (slot.blockedLabel) {
      periods.push({
        date: slot.date,
        kind: 'blocked',
        label: slot.blockedLabel,
        sessionIndices: [],
      });
      continue;
    }

    if (reservedDate && slot.date === reservedDate) {
      periods.push({
        date: slot.date,
        kind: 'reserved',
        label: 'Reserved for makeup / practical exam',
        sessionIndices: [],
      });
      continue;
    }

    const s1 = labCursor * 2;
    labCursor++;
    if (s1 < sessionCount) {
      const indices = [s1];
      sessionDates.push(slot.date);
      if (s1 + 1 < sessionCount) {
        indices.push(s1 + 1);
        sessionDates.push(slot.date);
      }
      periods.push({
        date: slot.date,
        kind: 'lab',
        label: `Lab ${labCursor}`,
        sessionIndices: indices,
      });
    } else {
      periods.push({
        date: slot.date,
        kind: 'spare',
        label: 'Spare practice slot',
        sessionIndices: [],
      });
    }
  }

  const availablePeriods = slots.filter(
    (s) => !s.blockedLabel && s.date !== reservedDate,
  ).length;
  const shortBy = Math.max(0, neededPeriods - availablePeriods);

  return {
    periods,
    availablePeriods,
    neededPeriods,
    shortBy,
    sessionDates,
  };
}

export interface MergeSuggestion {
  index: number;
  a: string;
  b: string;
  merged: string;
}

export function suggestMerge(topics: readonly string[]): MergeSuggestion | null {
  if (topics.length < 2) return null;
  let bestIdx = 0;
  let bestScore = Infinity;

  for (let i = 0; i < topics.length - 1; i++) {
    const score = topics[i]!.trim().length + topics[i + 1]!.trim().length;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const a = topics[bestIdx]!.trim();
  const b = topics[bestIdx + 1]!.trim();
  return {
    index: bestIdx,
    a,
    b,
    merged: `${a} & ${b}`,
  };
}

export function applyMerge(topics: readonly string[], index: number): string[] {
  if (index < 0 || index >= topics.length - 1) return [...topics];
  const merged = `${topics[index]!.trim()} & ${topics[index + 1]!.trim()}`;
  return [...topics.slice(0, index), merged, ...topics.slice(index + 2)];
}

export type PrepDifficulty = 'easy' | 'medium' | 'hard';

export interface PickCandidate {
  id: string;
  difficulty: PrepDifficulty;
  valid: boolean | null;
}

export function pickTwo(cands: readonly PickCandidate[]): string[] {
  const valid = cands.filter((c) => c.valid === true);
  if (valid.length < 2) return [];

  const firstByDiff = (diff: PrepDifficulty, excludeId?: string) =>
    valid.find((c) => c.difficulty === diff && c.id !== excludeId);

  const med = firstByDiff('medium');
  const hard = firstByDiff('hard', med?.id);
  if (med && hard) return [med.id, hard.id];

  const easy = firstByDiff('easy');
  const hard2 = firstByDiff('hard', easy?.id);
  if (easy && hard2) return [easy.id, hard2.id];

  const easy2 = firstByDiff('easy');
  const med2 = firstByDiff('medium', easy2?.id);
  if (easy2 && med2) return [easy2.id, med2.id];

  return [valid[0]!.id, valid[1]!.id];
}

export function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const tok of sa) {
    if (sb.has(tok)) inter++;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface StemItem {
  id: string;
  stem: string;
}

export interface OverlapPair {
  preId: string;
  postId: string;
  preStem: string;
  postStem: string;
  score: number;
}

export function overlaps(
  pre: readonly StemItem[],
  post: readonly StemItem[],
  threshold = 0.8,
): OverlapPair[] {
  const out: OverlapPair[] = [];
  for (const p of pre) {
    for (const q of post) {
      const score = similarity(p.stem, q.stem);
      if (score >= threshold) {
        out.push({
          preId: p.id,
          postId: q.id,
          preStem: p.stem,
          postStem: q.stem,
          score,
        });
      }
    }
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
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
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

export interface ParsedMcqRow {
  bank: 'pre' | 'post';
  level: PrepDifficulty;
  stem: string;
  options: string[];
  answer: number;
}

export function parseMcqCsv(text: string): { rows: ParsedMcqRow[]; errors: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { rows: [], errors: ['CSV is empty.'] };
  }

  const rows: ParsedMcqRow[] = [];
  const errors: string[] = [];
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  lines.forEach((line, idx) => {
    const cells = splitCsvLine(line);
    if (
      idx === 0 &&
      cells[0]?.toLowerCase() === 'stage' &&
      cells[1]?.toLowerCase() === 'level'
    ) {
      return;
    }

    if (cells.length < 5) {
      errors.push(`Row ${idx + 1}: expected 5 columns (stage, level, question, options, answer).`);
      return;
    }

    const bankRaw = cells[0]!.toLowerCase();
    const levelRaw = cells[1]!.toLowerCase();
    const stem = cells[2]!.trim();
    const options = cells[3]!
      .split('|')
      .map((o) => o.trim())
      .filter(Boolean);
    const ansRaw = cells[4]!.toUpperCase().trim();
    const ansIdx = LETTERS.indexOf(ansRaw);

    if (bankRaw !== 'pre' && bankRaw !== 'post') {
      errors.push(`Row ${idx + 1}: stage must be "pre" or "post".`);
      return;
    }
    if (levelRaw !== 'easy' && levelRaw !== 'medium' && levelRaw !== 'hard') {
      errors.push(`Row ${idx + 1}: level must be easy, medium, or hard.`);
      return;
    }
    if (!stem) {
      errors.push(`Row ${idx + 1}: question stem is missing.`);
      return;
    }
    if (options.length < 2 || options.length > 6) {
      errors.push(`Row ${idx + 1}: options separated by "|" must have 2 to 6 choices.`);
      return;
    }
    if (ansIdx < 0 || ansIdx >= options.length) {
      errors.push(`Row ${idx + 1}: answer must be a letter A–${LETTERS[options.length - 1]}.`);
      return;
    }

    rows.push({
      bank: bankRaw,
      level: levelRaw,
      stem,
      options,
      answer: ansIdx,
    });
  });

  return { rows, errors };
}

export interface ParsedLabQuestion {
  title: string;
  statement: string;
  input_spec: string;
  output_spec: string;
  constraints: string;
  difficulty: PrepDifficulty;
  co_code: string;
  visible_tests: Array<{ input: string; expected: string }>;
  hidden_tests: Array<{ input: string; expected: string }>;
  references: Record<string, string>;
}

const VALID_REF_LANGS = new Set(['c', 'cpp', 'java', 'python', 'rust', 'go']);

export function parseQuestionsJson(text: string): {
  questions: ParsedLabQuestion[];
  errors: string[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { questions: [], errors: ['Invalid JSON file.'] };
  }

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).questions)
      ? ((raw as Record<string, unknown>).questions as unknown[])
      : null;

  if (!list || list.length === 0) {
    return { questions: [], errors: ['Expected a non-empty array of questions or {"questions":[...]}.'] };
  }

  const questions: ParsedLabQuestion[] = [];
  const errors: string[] = [];

  list.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`Question ${idx + 1}: expected an object.`);
      return;
    }
    const row = entry as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const statement = typeof row.statement === 'string' ? row.statement.trim() : '';
    const diffRaw = typeof row.difficulty === 'string' ? row.difficulty.trim().toLowerCase() : 'medium';
    const coCode = typeof row.co_code === 'string' ? row.co_code.trim().toUpperCase() : 'CO1';

    if (!title || !statement) {
      errors.push(`Question ${idx + 1}: title and statement are required.`);
      return;
    }
    if (diffRaw !== 'easy' && diffRaw !== 'medium' && diffRaw !== 'hard') {
      errors.push(`Question ${idx + 1}: difficulty must be easy, medium, or hard.`);
      return;
    }

    const vis = Array.isArray(row.visible_tests) ? row.visible_tests : [];
    const hid = Array.isArray(row.hidden_tests) ? row.hidden_tests : [];
    if (vis.length !== 2 || hid.length !== 3) {
      errors.push(`Question ${idx + 1}: must have exactly 2 visible_tests and 3 hidden_tests.`);
      return;
    }

    const parseTcList = (arr: unknown[]) =>
      arr.map((t) => {
        const rec = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        return {
          input: typeof rec.input === 'string' ? rec.input : String(rec.input ?? ''),
          expected: typeof rec.expected === 'string' ? rec.expected : String(rec.expected ?? ''),
        };
      });

    const refs: Record<string, string> = {};
    if (row.references && typeof row.references === 'object') {
      for (const [k, v] of Object.entries(row.references as Record<string, unknown>)) {
        const lang = k.toLowerCase();
        if (VALID_REF_LANGS.has(lang) && typeof v === 'string' && v.trim().length > 0) {
          refs[lang] = v;
        }
      }
    }
    if (Object.keys(refs).length === 0 && typeof row.reference_c === 'string' && row.reference_c.trim()) {
      refs.c = row.reference_c;
    }
    if (Object.keys(refs).length === 0) {
      errors.push(`Question ${idx + 1}: at least one reference solution is required in "references".`);
      return;
    }

    questions.push({
      title,
      statement,
      input_spec: typeof row.input_spec === 'string' ? row.input_spec : '',
      output_spec: typeof row.output_spec === 'string' ? row.output_spec : '',
      constraints: typeof row.constraints === 'string' ? row.constraints : '',
      difficulty: diffRaw,
      co_code: /^CO\d{1,2}$/.test(coCode) ? coCode : 'CO1',
      visible_tests: parseTcList(vis),
      hidden_tests: parseTcList(hid),
      references: refs,
    });
  });

  return { questions, errors };
}

export interface AnalyticsAttemptInput {
  item_ids?: readonly string[] | null;
  answers: Readonly<Record<string, number>>;
  score: number | null;
  submitted_at: string | null;
}

export interface AnalyticsBankItemInput {
  id: string;
  level: PrepDifficulty;
  answer: number;
}

export interface PreTestAnalyticsResult {
  submittedCount: number;
  histogram: [number, number, number, number, number, number];
  averageScore: number;
  byLevel: { easy: number; medium: number; hard: number };
  insight: string;
}

export function preTestAnalytics(
  attempts: readonly AnalyticsAttemptInput[],
  items: readonly AnalyticsBankItemInput[],
): PreTestAnalyticsResult {
  const histogram: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  const itemMap = new Map(items.map((it) => [it.id, it]));
  const stats = {
    easy: { right: 0, total: 0 },
    medium: { right: 0, total: 0 },
    hard: { right: 0, total: 0 },
  };

  let submittedCount = 0;
  let scoreSum = 0;

  for (const att of attempts) {
    if (!att.submitted_at) continue;
    submittedCount++;
    const s = Math.max(0, Math.min(5, Math.round(att.score ?? 0)));
    const curCount = histogram[s] ?? 0;
    if (s === 0) histogram[0] = curCount + 1;
    else if (s === 1) histogram[1] = curCount + 1;
    else if (s === 2) histogram[2] = curCount + 1;
    else if (s === 3) histogram[3] = curCount + 1;
    else if (s === 4) histogram[4] = curCount + 1;
    else histogram[5] = curCount + 1;
    scoreSum += s;

    const ids = Array.isArray(att.item_ids) ? att.item_ids : [];
    const ansMap = new Map<string, number>(Object.entries(att.answers ?? {}));
    for (const id of ids) {
      const bankItem = itemMap.get(id);
      if (!bankItem) continue;
      const bucket = stats[bankItem.level];
      bucket.total++;
      if (ansMap.get(id) === bankItem.answer) {
        bucket.right++;
      }
    }
  }

  const pct = (b: { right: number; total: number }) =>
    b.total > 0 ? Math.round((b.right / b.total) * 100) : 0;

  const byLevel = {
    easy: pct(stats.easy),
    medium: pct(stats.medium),
    hard: pct(stats.hard),
  };

  let insight = 'No pre-test submissions yet.';
  if (submittedCount > 0) {
    const entries: Array<[PrepDifficulty, number]> = [
      ['hard', byLevel.hard],
      ['medium', byLevel.medium],
      ['easy', byLevel.easy],
    ];
    const weak = entries.filter(([, p]) => p < 60);
    if (weak.length > 0) {
      const lowest = weak.sort((a, b) => a[1] - b[1])[0]!;
      insight = `Weakest area: ${lowest[0]} items (${lowest[1]}% correct). Review before live coding starts.`;
    } else {
      insight = 'Pre-test readiness is solid across easy, medium, and hard concepts.';
    }
  }

  return {
    submittedCount,
    histogram,
    averageScore: submittedCount > 0 ? Math.round((scoreSum / submittedCount) * 10) / 10 : 0,
    byLevel,
    insight,
  };
}

export interface MonitorStudentInput {
  id: string;
  fullName: string;
  rollNo: string;
}

export interface MonitorSubmissionInput {
  student_id: string;
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  created_at: string;
}

export interface MonitorAlert {
  studentId: string;
  rollNo: string;
  fullName: string;
  kind: 'struggling' | 'idle';
  detail: string;
}

export function monitorAlerts(
  students: readonly MonitorStudentInput[],
  subs: readonly MonitorSubmissionInput[],
  lastDraftMs: ReadonlyMap<string, number>,
  absentSet: ReadonlySet<string>,
  nowMs: number,
  runStartedMs?: number | null,
): MonitorAlert[] {
  const subsByStudent = new Map<string, MonitorSubmissionInput[]>();
  for (const s of subs) {
    const list = subsByStudent.get(s.student_id) ?? [];
    list.push(s);
    subsByStudent.set(s.student_id, list);
  }

  const alerts: MonitorAlert[] = [];

  for (const stu of students) {
    if (absentSet.has(stu.id)) continue;

    const mySubs = subsByStudent.get(stu.id) ?? [];
    const anyPassed = mySubs.some((s) => s.visible_passed > 0 || s.hidden_passed > 0);
    const allHiddenPassed = mySubs.some((s) => s.hidden_total > 0 && s.hidden_passed >= s.hidden_total);

    if (mySubs.length >= 4 && !anyPassed) {
      alerts.push({
        studentId: stu.id,
        rollNo: stu.rollNo,
        fullName: stu.fullName,
        kind: 'struggling',
        detail: `${mySubs.length} runs with no passing tests`,
      });
      continue;
    }

    if (!allHiddenPassed) {
      const subTimes = mySubs.map((s) => Date.parse(s.created_at)).filter((t) => !Number.isNaN(t));
      const draftTime = lastDraftMs.get(stu.id) ?? 0;
      const latestActivity = Math.max(0, ...subTimes, draftTime, runStartedMs ?? 0);
      if (latestActivity > 0 && nowMs - latestActivity >= 15 * 60_000) {
        const mins = Math.floor((nowMs - latestActivity) / 60_000);
        alerts.push({
          studentId: stu.id,
          rollNo: stu.rollNo,
          fullName: stu.fullName,
          kind: 'idle',
          detail: `No activity for ${mins} min`,
        });
      }
    }
  }

  return alerts;
}

export function weekOf(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateIso;
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
