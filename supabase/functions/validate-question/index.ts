import { z } from 'npm:zod@3.24.2';
import { adminClient, userClient } from '../_shared/clients.ts';
import { json, readPostJson } from '../_shared/http.ts';
import type { AllowedLang } from '../_shared/judge.ts';
import { resolveLanguageIds, runOnJudge0 } from '../_shared/judge0.ts';
import { validateQuestionWithRunner } from '../_shared/validate.ts';

const BodySchema = z.object({
  question_id: z.string().uuid(),
});

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

  const parsed = BodySchema.safeParse(parsedBody.data);
  if (!parsed.success) {
    return json({ error: 'invalid_input' }, 400, origin);
  }

  const uClient = userClient(authHeader);
  const { data: authData, error: authErr } = await uClient.auth.getUser();
  if (authErr || !authData.user) {
    return json({ error: 'forbidden' }, 401, origin);
  }

  const admin = adminClient();
  const { data: question } = await admin
    .from('questions')
    .select('id, course_id, session_id, institution_id')
    .eq('id', parsed.data.question_id)
    .single();

  if (!question) {
    return json({ error: 'not_found' }, 404, origin);
  }

  const { data: course } = await admin
    .from('courses')
    .select('id, faculty_id, allowed_langs')
    .eq('id', question.course_id)
    .single();

  if (!course || course.faculty_id !== authData.user.id) {
    return json({ error: 'forbidden' }, 403, origin);
  }

  const judgeUrl = Deno.env.get('JUDGE0_URL');
  if (!judgeUrl) {
    return json({ error: 'runner_not_configured' }, 503, origin);
  }

  const [{ data: testRows }, { data: refRows }] = await Promise.all([
    admin
      .from('test_cases')
      .select('ord, input, expected, hidden')
      .eq('question_id', question.id)
      .order('ord'),
    admin
      .from('reference_solutions')
      .select('lang, code')
      .eq('question_id', question.id),
  ]);

  const references: Partial<Record<AllowedLang, string>> = {};
  for (const r of refRows ?? []) {
    references[r.lang as AllowedLang] = r.code;
  }

  const langIds = resolveLanguageIds(Deno.env.get('JUDGE0_LANG_IDS'));
  const judgeKey = Deno.env.get('JUDGE0_API_KEY') ?? undefined;
  const judgeHeader = Deno.env.get('JUDGE0_AUTH_HEADER') ?? 'X-Auth-Token';

  const result = await validateQuestionWithRunner({
    allowedLangs: (course.allowed_langs ?? ['c']) as AllowedLang[],
    tests: (testRows ?? []) as Array<{ ord: number; input: string; expected: string; hidden: boolean }>,
    references,
    runTest: (lang, code, tc) =>
      runOnJudge0(
        { baseUrl: judgeUrl, apiKey: judgeKey, authHeader: judgeHeader, langIds },
        lang,
        code,
        tc,
      ),
  });

  const updatePatch: { valid: boolean; validation_note: string; status?: 'candidate' } = {
    valid: result.valid,
    validation_note: result.validation_note,
  };
  if (!result.valid) {
    updatePatch.status = 'candidate';
  }

  await admin
    .from('questions')
    .update(updatePatch)
    .eq('id', question.id);

  let sessionStatus: string | null = null;
  if (question.session_id) {
    const { data: refreshed } = await admin.rpc('refresh_session_status', {
      p_session_id: question.session_id,
    });
    sessionStatus = (refreshed as string | null) ?? null;
  }

  return json({ ...result, session_status: sessionStatus }, 200, origin);
});
