import type { AllowedLang } from './judge.ts';

export interface DraftOutcome {
  code: string;
  statement: string;
  btl: number;
  unit: number;
}

export interface DraftCoPoEntry {
  co: string;
  po: string;
  level: number;
}

export interface OutcomesDraft {
  outcomes: DraftOutcome[];
  map: DraftCoPoEntry[];
}

export interface DraftTestCase {
  input: string;
  expected: string;
}

export interface LabCandidateDraft {
  title: string;
  statement: string;
  input_spec: string;
  output_spec: string;
  constraints: string;
  difficulty: 'easy' | 'medium' | 'hard';
  co_code: string;
  visible_tests: DraftTestCase[];
  hidden_tests: DraftTestCase[];
  references: Partial<Record<AllowedLang, string>>;
}

export interface DraftBankItem {
  level: 'easy' | 'medium' | 'hard';
  stem: string;
  options: string[];
  answer: number;
}

export interface BankPairDraft {
  pre: DraftBankItem[];
  post: DraftBankItem[];
}

export interface ClassTaskDraft {
  title: string;
  body: string;
  payload: {
    code?: string;
    options?: string[];
  };
  answer_key: {
    expected?: string;
    accept?: string[];
  };
}

export interface AnnouncementDraft {
  title: string;
  body: string;
}

export interface ReportNarrativeDraft {
  internal_summary: string;
  overall_summary: string;
  bos_suggestions: string;
}

const VALID_LANGS: readonly AllowedLang[] = ['c', 'cpp', 'java', 'python', 'rust', 'go'];
const LEVELS = ['easy', 'medium', 'hard'] as const;

export function tokenSimilarity(a: string, b: string): number {
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

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('invalid_ai_json');
  }
}

export function validateOutcomesDraft(raw: unknown): OutcomesDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.outcomes) || obj.outcomes.length === 0 || obj.outcomes.length > 12) {
    throw new Error('invalid_ai_shape');
  }

  const seenCodes = new Set<string>();
  const outcomes: DraftOutcome[] = [];

  for (const item of obj.outcomes) {
    if (!item || typeof item !== 'object') throw new Error('invalid_ai_shape');
    const row = item as Record<string, unknown>;
    const code = typeof row.code === 'string' ? row.code.trim().toUpperCase() : '';
    const statement = typeof row.statement === 'string' ? row.statement.trim() : '';
    const btl = Number(row.btl);
    const unit = Number(row.unit ?? 1);

    if (
      !/^CO\d{1,2}$/.test(code) ||
      seenCodes.has(code) ||
      statement.length < 5 ||
      !Number.isInteger(btl) ||
      btl < 1 ||
      btl > 6 ||
      !Number.isInteger(unit) ||
      unit < 1 ||
      unit > 10
    ) {
      throw new Error('invalid_ai_shape');
    }
    seenCodes.add(code);
    outcomes.push({ code, statement, btl, unit });
  }

  const rawMap = Array.isArray(obj.map) ? obj.map : [];
  const map: DraftCoPoEntry[] = [];
  for (const entry of rawMap) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_ai_shape');
    const row = entry as Record<string, unknown>;
    const co = typeof row.co === 'string' ? row.co.trim().toUpperCase() : '';
    const po = typeof row.po === 'string' ? row.po.trim().toUpperCase() : '';
    const level = Number(row.level);

    if (
      !seenCodes.has(co) ||
      !/^(PO|PSO)\d{1,2}$/.test(po) ||
      !Number.isInteger(level) ||
      level < 0 ||
      level > 3
    ) {
      throw new Error('invalid_ai_shape');
    }
    map.push({ co, po, level });
  }

  return { outcomes, map };
}

function parseTests(raw: unknown, expectedCount: number): DraftTestCase[] {
  if (!Array.isArray(raw) || raw.length !== expectedCount) {
    throw new Error('invalid_ai_shape');
  }
  return raw.map((t) => {
    if (!t || typeof t !== 'object') throw new Error('invalid_ai_shape');
    const rec = t as Record<string, unknown>;
    if (typeof rec.input !== 'string' || typeof rec.expected !== 'string') {
      throw new Error('invalid_ai_shape');
    }
    return { input: rec.input, expected: rec.expected };
  });
}

export function validateLabCandidatesDraft(
  raw: unknown,
  requiredLangs: readonly AllowedLang[] = ['c'],
  existingTitles: readonly string[] = [],
): LabCandidateDraft[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.candidates) || obj.candidates.length !== 4) {
    throw new Error('invalid_ai_shape');
  }

  const seenTitles = new Set(existingTitles.map((t) => t.trim().toLowerCase()));
  const out: LabCandidateDraft[] = [];

  for (const item of obj.candidates) {
    if (!item || typeof item !== 'object') throw new Error('invalid_ai_shape');
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const statement = typeof row.statement === 'string' ? row.statement.trim() : '';
    const difficulty = typeof row.difficulty === 'string' ? row.difficulty.trim().toLowerCase() : '';
    const coCode = typeof row.co_code === 'string' ? row.co_code.trim().toUpperCase() : 'CO1';

    if (
      title.length < 3 ||
      statement.length < 15 ||
      seenTitles.has(title.toLowerCase()) ||
      !(LEVELS as readonly string[]).includes(difficulty) ||
      !/^CO\d{1,2}$/.test(coCode)
    ) {
      throw new Error('invalid_ai_shape');
    }
    seenTitles.add(title.toLowerCase());

    const visible_tests = parseTests(row.visible_tests, 2);
    const hidden_tests = parseTests(row.hidden_tests, 3);

    const refMap = new Map<AllowedLang, string>();
    if (row.references && typeof row.references === 'object') {
      for (const [k, v] of Object.entries(row.references as Record<string, unknown>)) {
        const lang = k.toLowerCase() as AllowedLang;
        if (VALID_LANGS.includes(lang) && typeof v === 'string' && v.trim().length > 0 && v.length <= 50_000) {
          refMap.set(lang, v);
        }
      }
    } else if (typeof row.reference_c === 'string' && row.reference_c.trim().length > 0) {
      refMap.set('c', row.reference_c);
    }

    const langsToCheck = requiredLangs.length > 0 ? requiredLangs : (['c'] as const);
    for (const lang of langsToCheck) {
      if (!refMap.has(lang)) {
        throw new Error('invalid_ai_shape');
      }
    }

    const refs = Object.fromEntries(refMap.entries()) as Partial<Record<AllowedLang, string>>;

    out.push({
      title,
      statement,
      input_spec: typeof row.input_spec === 'string' ? row.input_spec : '',
      output_spec: typeof row.output_spec === 'string' ? row.output_spec : '',
      constraints: typeof row.constraints === 'string' ? row.constraints : '',
      difficulty: difficulty as 'easy' | 'medium' | 'hard',
      co_code: coCode,
      visible_tests,
      hidden_tests,
      references: refs,
    });
  }

  return out;
}

function validateSingleBank(raw: unknown): DraftBankItem[] {
  if (!Array.isArray(raw) || raw.length !== 45) {
    throw new Error('invalid_ai_shape');
  }

  const counts = { easy: 0, medium: 0, hard: 0 };
  const items: DraftBankItem[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_ai_shape');
    const row = entry as Record<string, unknown>;
    const level = typeof row.level === 'string' ? row.level.trim().toLowerCase() : '';
    const stem = typeof row.stem === 'string' ? row.stem.trim() : '';
    const rawOpts = Array.isArray(row.options) ? row.options : [];
    const options = rawOpts
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.trim())
      .filter(Boolean);
    const answer = Number(row.answer);

    if (
      !(LEVELS as readonly string[]).includes(level) ||
      stem.length < 5 ||
      options.length < 2 ||
      options.length > 6 ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= options.length
    ) {
      throw new Error('invalid_ai_shape');
    }

    counts[level as keyof typeof counts]++;
    items.push({
      level: level as 'easy' | 'medium' | 'hard',
      stem,
      options,
      answer,
    });
  }

  if (counts.easy !== 15 || counts.medium !== 15 || counts.hard !== 15) {
    throw new Error('bank_incomplete');
  }

  return items;
}

export function validateBankDraft(raw: unknown): BankPairDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  const pre = validateSingleBank(obj.pre);
  const post = validateSingleBank(obj.post);

  for (const p of pre) {
    for (const q of post) {
      if (tokenSimilarity(p.stem, q.stem) >= 0.8) {
        throw new Error('bank_overlap');
      }
    }
  }

  return { pre, post };
}

export function validateClassTaskDraft(raw: unknown): ClassTaskDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  if (title.length < 3 || body.length < 5) {
    throw new Error('invalid_ai_shape');
  }

  const rawPayload =
    obj.payload && typeof obj.payload === 'object'
      ? (obj.payload as Record<string, unknown>)
      : {};
  const payload: ClassTaskDraft['payload'] = {};
  if (typeof rawPayload.code === 'string' && rawPayload.code.trim().length > 0) {
    payload.code = rawPayload.code;
  }
  if (Array.isArray(rawPayload.options)) {
    const opts = rawPayload.options
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (opts.length > 0) payload.options = opts;
  }

  const rawKey =
    obj.answer_key && typeof obj.answer_key === 'object'
      ? (obj.answer_key as Record<string, unknown>)
      : {};
  const answer_key: ClassTaskDraft['answer_key'] = {};
  if (typeof rawKey.expected === 'string') {
    answer_key.expected = rawKey.expected.trim();
  }
  if (Array.isArray(rawKey.accept)) {
    answer_key.accept = rawKey.accept
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.trim())
      .filter(Boolean);
  }

  return { title, body, payload, answer_key };
}

export function validateAnnouncementDraft(raw: unknown): AnnouncementDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  if (title.length < 3 || body.length < 10) {
    throw new Error('invalid_ai_shape');
  }
  return { title, body };
}

export function validateReportNarrativeDraft(raw: unknown): ReportNarrativeDraft {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  const internal_summary =
    typeof obj.internal_summary === 'string' ? obj.internal_summary.trim() : '';
  const overall_summary =
    typeof obj.overall_summary === 'string' ? obj.overall_summary.trim() : '';
  const bos_suggestions =
    typeof obj.bos_suggestions === 'string' ? obj.bos_suggestions.trim() : '';
  if (!internal_summary || !bos_suggestions) {
    throw new Error('invalid_ai_shape');
  }
  return { internal_summary, overall_summary, bos_suggestions };
}

export interface FeedbackQuestionDraft {
  id: string;
  category: 'engagement' | 'support' | 'co_specific';
  prompt: string;
}

export function validateFeedbackLoopDraft(raw: unknown): FeedbackQuestionDraft[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid_ai_shape');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length < 15) {
    throw new Error('invalid_ai_shape');
  }
  const out: FeedbackQuestionDraft[] = [];
  for (const [i, item] of obj.questions.slice(0, 15).entries()) {
    if (!item || typeof item !== 'object') throw new Error('invalid_ai_shape');
    const row = item as Record<string, unknown>;
    const cat = row.category;
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
    if (
      (cat !== 'engagement' && cat !== 'support' && cat !== 'co_specific') ||
      prompt.length < 8
    ) {
      throw new Error('invalid_ai_shape');
    }
    out.push({
      id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `q_${i + 1}`,
      category: cat,
      prompt,
    });
  }
  return out;
}
