import { z } from 'npm:zod@3.24.2';
import { adminClient, userClient } from '../_shared/clients.ts';
import { json, readPostJson } from '../_shared/http.ts';
import {
  parseRunRequest,
  toResult,
  type ExecutedTestOutcome,
  type TestCaseSpec,
} from '../_shared/judge.ts';
import { resolveLanguageIds, runOnJudge0 } from '../_shared/judge0.ts';

const BodySchema = z.object({
  question_id: z.string().uuid(),
  lang: z.enum(['c', 'cpp', 'java', 'python', 'rust', 'go']),
  code: z.string().min(1).max(50_000),
  mode: z.enum(['run', 'submit']),
  context: z.enum(['lab', 'exam']),
  paper_id: z.string().uuid().nullable().optional(),
});

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_RUNS = 20;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const parsedBody = await readPostJson<unknown>(req);
  if (!parsedBody.ok) {
    return parsedBody.res;
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return json({ error: 'forbidden' }, 401, origin);
  }

  const zodRes = BodySchema.safeParse(parsedBody.data);
  if (!zodRes.success) {
    return json({ error: 'invalid_input' }, 400, origin);
  }

  let input;
  try {
    input = parseRunRequest(zodRes.data);
  } catch {
    return json({ error: 'invalid_input' }, 400, origin);
  }

  const uClient = userClient(authHeader);
  const { data: authData, error: authErr } = await uClient.auth.getUser();
  if (authErr || !authData.user) {
    return json({ error: 'forbidden' }, 401, origin);
  }

  const admin = adminClient();

  const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count: recentCount } = await admin
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', authData.user.id)
    .gte('created_at', sinceIso);

  if ((recentCount ?? 0) >= RATE_MAX_RUNS) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  const { data: authRun, error: runErr } = await admin.rpc('authorize_run', {
    p_user_id: authData.user.id,
    p_question_id: input.question_id,
    p_context: input.context,
    p_mode: input.mode,
    p_paper_id: input.paper_id,
  });

  if (runErr || !authRun) {
    const code = runErr?.message ?? 'forbidden';
    const status = code === 'not_found' ? 404 : code === 'invalid_input' ? 400 : 403;
    return json({ error: code }, status, origin);
  }

  const runAuth = authRun as {
    institution_id: string;
    course_id: string;
    session_id: string | null;
    session_run_id: string | null;
    allowed_langs: string[];
    visible_tests: TestCaseSpec[];
    hidden_tests: TestCaseSpec[];
  };

  if (!runAuth.allowed_langs.includes(input.lang)) {
    return json({ error: 'unsupported_language' }, 400, origin);
  }

  const judgeUrl = Deno.env.get('JUDGE0_URL');
  if (!judgeUrl) {
    return json({ error: 'runner_not_configured' }, 503, origin);
  }

  const langIds = resolveLanguageIds(Deno.env.get('JUDGE0_LANG_IDS'));
  const judgeKey = Deno.env.get('JUDGE0_API_KEY') ?? undefined;
  const judgeHeader = Deno.env.get('JUDGE0_AUTH_HEADER') ?? 'X-Auth-Token';

  const cfg = {
    baseUrl: judgeUrl,
    apiKey: judgeKey,
    authHeader: judgeHeader,
    langIds,
  };

  const visibleOutcomes: ExecutedTestOutcome[] = [];
  for (const tc of runAuth.visible_tests) {
    visibleOutcomes.push(await runOnJudge0(cfg, input.lang, input.code, tc));
  }

  const hiddenOutcomes: ExecutedTestOutcome[] = [];
  if (input.mode === 'submit') {
    for (const tc of runAuth.hidden_tests) {
      hiddenOutcomes.push(await runOnJudge0(cfg, input.lang, input.code, tc));
    }
  }

  const result = toResult(
    input.mode,
    visibleOutcomes,
    hiddenOutcomes,
    runAuth.hidden_tests.length,
  );

  const visMap = new Map(visibleOutcomes.map((o) => [o.ord, o]));
  const hidMap = new Map(hiddenOutcomes.map((o) => [o.ord, o]));
  const earnedMarks =
    runAuth.visible_tests.reduce(
      (sum, tc) => sum + (visMap.get(tc.ord)?.passed ? tc.marks ?? 5 : 0),
      0,
    ) +
    (input.mode === 'submit'
      ? runAuth.hidden_tests.reduce(
          (sum, tc) => sum + (hidMap.get(tc.ord)?.passed ? tc.marks ?? 5 : 0),
          0,
        )
      : 0);

  await admin.from('submissions').insert({
    institution_id: runAuth.institution_id,
    course_id: runAuth.course_id,
    session_id: runAuth.session_id,
    session_run_id: runAuth.session_run_id,
    exam_paper_id: input.context === 'exam' ? input.paper_id : null,
    student_id: authData.user.id,
    question_id: input.question_id,
    context: input.context,
    mode: input.mode,
    lang: input.lang,
    code: input.code,
    visible_passed: result.visible_passed,
    visible_total: result.visible_total,
    hidden_passed: result.hidden_passed,
    hidden_total: result.hidden_total,
    marks: earnedMarks,
    verdict: result.verdict,
    runtime_ms: result.runtime_ms,
    memory_kb: result.memory_kb,
  });

  return json(result, 200, origin);
});
