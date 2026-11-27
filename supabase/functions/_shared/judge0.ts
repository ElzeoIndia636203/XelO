import {
  ALLOWED_LANGS,
  outputsMatch,
  type AllowedLang,
  type ExecutedTestOutcome,
  type TestCaseSpec,
} from './judge.ts';

export const DEFAULT_LANG_IDS: Record<AllowedLang, number> = {
  c: 50,
  cpp: 54,
  java: 91,
  python: 71,
  rust: 73,
  go: 95,
};

export const JUDGE0_LIMITS = {
  cpu_time_limit: 2,
  memory_limit: 262144, // 256 MB in KB
  max_file_size: 64, // 64 KB
  enable_network: false,
} as const;

export function resolveLanguageIds(envJson?: string): Record<AllowedLang, number> {
  const idMap = new Map<AllowedLang, number>(
    Object.entries(DEFAULT_LANG_IDS) as Array<[AllowedLang, number]>,
  );
  if (!envJson || !envJson.trim()) {
    return Object.fromEntries(idMap.entries()) as Record<AllowedLang, number>;
  }
  try {
    const parsed = JSON.parse(envJson) as Record<string, unknown>;
    for (const [key, rawVal] of Object.entries(parsed)) {
      const lang = key as AllowedLang;
      const val = Number(rawVal);
      if (ALLOWED_LANGS.includes(lang) && Number.isInteger(val) && val > 0) {
        idMap.set(lang, val);
      }
    }
  } catch {
    // Keep defaults if JUDGE0_LANG_IDS env override is malformed
  }
  return Object.fromEntries(idMap.entries()) as Record<AllowedLang, number>;
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const chars = Array.from(bytes, (b) => String.fromCharCode(b));
  return btoa(chars.join(''));
}

export function fromBase64(b64: string | null | undefined): string {
  if (!b64) return '';
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface Judge0SubmissionPayload {
  language_id: number;
  source_code: string;
  stdin: string;
  cpu_time_limit: number;
  memory_limit: number;
  max_file_size: number;
  enable_network: boolean;
}

export function buildSubmissionPayload(params: {
  lang: AllowedLang;
  code: string;
  stdin: string;
  langIds?: Record<AllowedLang, number>;
}): Judge0SubmissionPayload {
  const idMap = new Map<string, number>(
    Object.entries(params.langIds ?? DEFAULT_LANG_IDS),
  );
  return {
    language_id: idMap.get(params.lang) ?? DEFAULT_LANG_IDS.c,
    source_code: toBase64(params.code),
    stdin: toBase64(params.stdin),
    cpu_time_limit: JUDGE0_LIMITS.cpu_time_limit,
    memory_limit: JUDGE0_LIMITS.memory_limit,
    max_file_size: JUDGE0_LIMITS.max_file_size,
    enable_network: JUDGE0_LIMITS.enable_network,
  };
}

export interface Judge0RunConfig {
  baseUrl: string;
  apiKey?: string;
  authHeader?: string;
  langIds?: Record<AllowedLang, number>;
  fetchFn?: typeof fetch;
}

interface Judge0ResponseJson {
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  time?: string | null;
  memory?: number | null;
  status?: { id?: number; description?: string };
}

function mapStatus(statusId: number, matched: boolean): string {
  if (statusId === 6) return 'compile_error';
  if (statusId === 5) return 'time_limit_exceeded';
  if (statusId >= 7 && statusId <= 14) return 'runtime_error';
  if (statusId === 3) return matched ? 'accepted' : 'wrong_answer';
  return matched ? 'accepted' : 'wrong_answer';
}

export async function runOnJudge0(
  cfg: Judge0RunConfig,
  lang: AllowedLang,
  code: string,
  testCase: TestCaseSpec,
): Promise<ExecutedTestOutcome> {
  const fetcher = cfg.fetchFn ?? fetch;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/submissions?base64_encoded=true&wait=true`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (cfg.apiKey) {
    const authHeader = cfg.authHeader ?? 'X-Auth-Token';
    headers[authHeader] = cfg.apiKey;
    if (authHeader.toLowerCase() === 'x-rapidapi-key') {
      headers['X-RapidAPI-Host'] = new URL(cfg.baseUrl).host;
    }
  }

  const payload = buildSubmissionPayload({
    lang,
    code,
    stdin: testCase.input,
    langIds: cfg.langIds,
  });

  const res = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`judge_http_${res.status}`);
  }

  const data = (await res.json()) as Judge0ResponseJson;
  const stdout = fromBase64(data.stdout);
  const stderr = fromBase64(data.stderr);
  const compileOut = fromBase64(data.compile_output);
  const statusId = Number(data.status?.id ?? 0);

  const timeMs = Math.max(0, Math.round(Number(data.time ?? 0) * 1000));
  const memoryKb = Math.max(0, Math.round(Number(data.memory ?? 0)));

  const compiledOk = statusId !== 6 && !compileOut.trim();
  const runtimeOk = !(statusId >= 5 && statusId <= 14);
  const passed = compiledOk && runtimeOk && outputsMatch(stdout, testCase.expected);
  const status = mapStatus(statusId, passed);

  return {
    ord: testCase.ord,
    passed,
    status,
    actual: statusId === 6 ? '' : stdout || stderr,
    expected: testCase.expected,
    input: testCase.input,
    time_ms: timeMs,
    memory_kb: memoryKb,
    compile_error: statusId === 6 ? compileOut || stderr || 'Compilation error' : undefined,
  };
}
