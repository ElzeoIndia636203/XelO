import { z } from 'npm:zod@3.24.2';
import {
  validateAnnouncementDraft,
  validateBankDraft,
  validateClassTaskDraft,
  validateLabCandidatesDraft,
  validateOutcomesDraft,
  validateReportNarrativeDraft,
} from '../_shared/ai-schema.ts';
import { adminClient, userClient } from '../_shared/clients.ts';
import { json, readPostJson } from '../_shared/http.ts';
import type { AllowedLang } from '../_shared/judge.ts';
import { resolveLanguageIds, runOnJudge0 } from '../_shared/judge0.ts';
import { callLlmJson } from '../_shared/llm.ts';
import { validateQuestionWithRunner } from '../_shared/validate.ts';

const BodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('outcomes'),
    course_id: z.string().uuid(),
    syllabus: z.string().min(20).max(50_000),
  }),
  z.object({
    kind: z.literal('lab_candidates'),
    course_id: z.string().uuid(),
    session_id: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('bank'),
    course_id: z.string().uuid(),
    session_id: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('class_task'),
    course_id: z.string().uuid(),
    week: z.number().int().min(1).max(30),
    task_type: z.enum(['quiz', 'fill', 'predict', 'debug', 'assignment', 'poll']),
    topic: z.string().min(2).max(200),
  }),
  z.object({
    kind: z.literal('announcement'),
    course_id: z.string().uuid(),
    topic: z.string().min(2).max(200),
    context: z.string().max(1000).optional(),
  }),
  z.object({
    kind: z.literal('report_narrative'),
    course_id: z.string().uuid(),
    metrics: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal('endsem_set'),
    course_id: z.string().uuid(),
    assessment_id: z.string().uuid(),
  }),
]);

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
  const { data: course } = await admin
    .from('courses')
    .select('id, code, title, faculty_id, institution_id, allowed_langs')
    .eq('id', parsed.data.course_id)
    .single();

  if (!course || course.faculty_id !== authData.user.id) {
    return json({ error: 'forbidden' }, 403, origin);
  }

  const { data: runId, error: creditErr } = await uClient.rpc('consume_ai_credit', {
    p_feature: parsed.data.kind,
    p_course_id: parsed.data.course_id,
  });

  if (creditErr || !runId) {
    const code = creditErr?.message ?? 'insufficient_credits';
    return json({ error: code }, 400, origin);
  }

  try {
    if (parsed.data.kind === 'outcomes') {
      const draft = await callLlmJson(
        {
          system:
            'You are XeIO Assist. Return ONLY valid JSON with shape {"outcomes":[{"code":"CO1","statement":"...","btl":3,"unit":1}],"map":[{"co":"CO1","po":"PO1","level":3}]}. Use CO1..CO6, BTL 1..6, unit 1..6, PO codes PO1..PO12 or PSO1..PSO2, and levels 0..3.',
          user: `Course: ${course.code} ${course.title}\n\nSyllabus:\n${parsed.data.syllabus}`,
        },
        validateOutcomesDraft,
      );

      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      await admin.rpc('audit', {
        p_action: 'ai_generate_outcomes',
        p_object_type: 'course',
        p_object_id: course.id,
        p_detail: { run_id: runId, outcomes: draft.outcomes.length },
        p_institution_id: course.institution_id,
        p_actor_id: authData.user.id,
      });
      return json({ draft, run_id: runId }, 200, origin);
    }

    if (parsed.data.kind === 'class_task') {
      const draft = await callLlmJson(
        {
          system:
            'You are XeIO Assist. Return ONLY valid JSON {"title":"...","body":"...","payload":{"code":"...","options":["..."]},"answer_key":{"expected":"...","accept":["..."]}}. Draft one concise in-class task matching the requested type (quiz needs 4 options & 0-based index string expected; poll needs 3-4 options; fill/predict/debug include C code snippet & expected answer; assignment states input/output specs).',
          user: `Course: ${course.code} ${course.title}\nWeek: ${parsed.data.week}\nTask type: ${parsed.data.task_type}\nTopic: ${parsed.data.topic}`,
        },
        validateClassTaskDraft,
      );

      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      await admin.rpc('audit', {
        p_action: 'ai_generate_class_task',
        p_object_type: 'course',
        p_object_id: course.id,
        p_detail: { run_id: runId, week: parsed.data.week, task_type: parsed.data.task_type },
        p_institution_id: course.institution_id,
        p_actor_id: authData.user.id,
      });
      return json({ draft, run_id: runId }, 200, origin);
    }

    if (parsed.data.kind === 'announcement') {
      const draft = await callLlmJson(
        {
          system:
            'You are XeIO Assist. Return ONLY valid JSON {"title":"...","body":"..."} with a short, plain classroom announcement for university programming lab students.',
          user: `Course: ${course.code} ${course.title}\nTopic: ${parsed.data.topic}\nContext: ${parsed.data.context ?? ''}`,
        },
        validateAnnouncementDraft,
      );

      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      await admin.rpc('audit', {
        p_action: 'ai_generate_announcement',
        p_object_type: 'course',
        p_object_id: course.id,
        p_detail: { run_id: runId },
        p_institution_id: course.institution_id,
        p_actor_id: authData.user.id,
      });
      return json({ draft, run_id: runId }, 200, origin);
    }

    if (parsed.data.kind === 'report_narrative') {
      const draft = await callLlmJson(
        {
          system:
            'You are XeIO Assist. Return ONLY valid JSON {"internal_summary":"...","overall_summary":"...","bos_suggestions":"..."}. Base every percentage or count strictly on the supplied metrics.',
          user: `Course: ${course.code} ${course.title}\nComputed metrics JSON:\n${JSON.stringify(parsed.data.metrics)}`,
        },
        validateReportNarrativeDraft,
      );

      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      await admin.rpc('audit', {
        p_action: 'ai_generate_report_narrative',
        p_object_type: 'course',
        p_object_id: course.id,
        p_detail: { run_id: runId },
        p_institution_id: course.institution_id,
        p_actor_id: authData.user.id,
      });
      return json({ draft, run_id: runId }, 200, origin);
    }

    const sessionId = parsed.data.session_id;
    const { data: session } = await admin
      .from('sessions')
      .select('id, course_id, n, topic, btl, co_id')
      .eq('id', sessionId)
      .single();

    if (!session || session.course_id !== course.id) {
      throw new Error('not_found');
    }

    const { data: coRow } = session.co_id
      ? await admin.from('course_outcomes').select('code, statement').eq('id', session.co_id).single()
      : { data: null };

    if (parsed.data.kind === 'lab_candidates') {
      const { data: existingQs } = await admin
        .from('questions')
        .select('title')
        .eq('course_id', course.id);
      const existingTitles = (existingQs ?? []).map((q) => q.title as string);
      const allowedLangs = ((course.allowed_langs as AllowedLang[] | null) ?? ['c']);

      const candidates = await callLlmJson(
        {
          system:
            'You are XeIO Assist. Return ONLY valid JSON {"candidates":[...]}. Generate exactly 4 distinct programming lab questions (easy, medium, hard, medium). Each candidate has: title, statement, input_spec, output_spec, constraints, difficulty, co_code, visible_tests (exact array of 2 {input, expected}), hidden_tests (exact array of 3 {input, expected}), and references (object mapping every required language code to working stdin/stdout solution).',
          user: `Course: ${course.code} ${course.title}\nSession S${session.n}: ${session.topic}\nCO: ${coRow?.code ?? 'CO1'} (${coRow?.statement ?? ''}), BTL L${session.btl}\nRequired languages: ${allowedLangs.join(', ')}\nAvoid these existing titles: ${existingTitles.slice(0, 40).join(' | ')}`,
          maxTokens: 4096,
        },
        (raw) => validateLabCandidatesDraft(raw, allowedLangs, existingTitles),
      );

      const judgeUrl = Deno.env.get('JUDGE0_URL');
      const langIds = resolveLanguageIds(Deno.env.get('JUDGE0_LANG_IDS'));
      const judgeKey = Deno.env.get('JUDGE0_API_KEY') ?? undefined;
      const judgeHeader = Deno.env.get('JUDGE0_AUTH_HEADER') ?? 'X-Auth-Token';

      const insertedIds: string[] = [];
      for (const cand of candidates) {
        const { data: qRow, error: insErr } = await admin
          .from('questions')
          .insert({
            institution_id: course.institution_id,
            course_id: course.id,
            kind: 'lab',
            session_id: session.id,
            co_code: cand.co_code,
            difficulty: cand.difficulty,
            title: cand.title,
            statement: cand.statement,
            input_spec: cand.input_spec,
            output_spec: cand.output_spec,
            constraints: cand.constraints,
            status: 'candidate',
            source: 'ai',
            valid: null,
            created_by: authData.user.id,
          })
          .select('id')
          .single();

        if (insErr || !qRow) {
          throw new Error('db_insert_failed');
        }

        const tcRows = [
          ...cand.visible_tests.map((tc, i) => ({
            institution_id: course.institution_id,
            question_id: qRow.id,
            ord: i + 1,
            input: tc.input,
            expected: tc.expected,
            hidden: false,
            marks: 5,
          })),
          ...cand.hidden_tests.map((tc, i) => ({
            institution_id: course.institution_id,
            question_id: qRow.id,
            ord: i + 3,
            input: tc.input,
            expected: tc.expected,
            hidden: true,
            marks: 5,
          })),
        ];
        await admin.from('test_cases').insert(tcRows);

        const refRows = Object.entries(cand.references).map(([lang, code]) => ({
          institution_id: course.institution_id,
          question_id: qRow.id,
          lang,
          code,
        }));
        await admin.from('reference_solutions').insert(refRows);

        if (judgeUrl) {
          const valRes = await validateQuestionWithRunner({
            allowedLangs,
            tests: tcRows,
            references: cand.references,
            runTest: (lang, code, tc) =>
              runOnJudge0(
                { baseUrl: judgeUrl, apiKey: judgeKey, authHeader: judgeHeader, langIds },
                lang,
                code,
                tc,
              ),
          });
          await admin
            .from('questions')
            .update({ valid: valRes.valid, validation_note: valRes.validation_note })
            .eq('id', qRow.id);
        }

        insertedIds.push(qRow.id as string);
      }

      await admin.rpc('refresh_session_status', { p_session_id: session.id });
      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      await admin.rpc('audit', {
        p_action: 'ai_generate_lab_candidates',
        p_object_type: 'session',
        p_object_id: session.id,
        p_detail: { run_id: runId, count: insertedIds.length },
        p_institution_id: course.institution_id,
        p_actor_id: authData.user.id,
      });

      return json({ question_ids: insertedIds, run_id: runId }, 200, origin);
    }

    if (parsed.data.kind === 'endsem_set') {
      const { data: assess } = await admin
        .from('assessments')
        .select('id, course_id, rules, cos')
        .eq('id', parsed.data.assessment_id)
        .eq('course_id', course.id)
        .single();
      if (!assess) {
        await admin.rpc('refund_ai_credit', { p_run_id: runId, p_reason: 'assessment_not_found' });
        return json({ error: 'not_found' }, 404, origin);
      }

      const { data: existingTitles } = await admin
        .from('dept_question_titles')
        .select('normalized_title, title')
        .eq('department_id', course.department_id);
      const usedSet = new Set((existingTitles ?? []).map((r) => String(r.normalized_title)));
      const excludeList = (existingTitles ?? []).slice(0, 80).map((r) => String(r.title));

      const raw = await callLlmJson(
        {
          system:
            'Generate 40 distinct programming exam questions as JSON {"candidates": [...]}. Each candidate has co_code, difficulty, title, statement, input_spec, output_spec, constraints, visible_tests (2), hidden_tests (3), references (map of lang->code), starter_code (map of lang->code). Do NOT reuse any title in exclude_titles.',
          user: JSON.stringify({
            course_code: course.code,
            course_title: course.title,
            allowed_langs: allowedLangs,
            rules: assess.rules,
            exclude_titles: excludeList,
          }),
        },
        (data) => {
          const obj = data as { candidates?: unknown[] };
          if (!Array.isArray(obj?.candidates) || obj.candidates.length === 0) {
            return { ok: false, error: 'missing_candidates' } as const;
          }
          // Validate first 4 as structural sample via existing lab candidate schema
          const sample = validateLabCandidatesDraft({ candidates: obj.candidates.slice(0, 4) }, allowedLangs);
          if (!sample.ok) return sample;
          return { ok: true, value: obj.candidates } as const;
        },
      );

      if (!raw.ok) {
        await admin.rpc('refund_ai_credit', { p_run_id: runId, p_reason: raw.error });
        return json({ error: 'ai_invalid_output' }, 502, origin);
      }

      const judgeUrl = Deno.env.get('JUDGE0_URL');
      const judgeKey = Deno.env.get('JUDGE0_API_KEY') ?? '';
      const judgeHeader = Deno.env.get('JUDGE0_AUTH_HEADER') ?? 'X-Auth-Token';
      const langIds = await resolveLanguageIds(judgeUrl ?? '', judgeKey, judgeHeader);
      const marksPerTest = Number((assess.rules as { marks_per_test?: number })?.marks_per_test ?? 5);

      const insertedIds: string[] = [];
      for (const item of raw.value.slice(0, 40)) {
        const cand = item as {
          co_code?: string;
          difficulty?: string;
          title?: string;
          statement?: string;
          input_spec?: string;
          output_spec?: string;
          constraints?: string;
          starter_code?: Record<string, string>;
          visible_tests?: { input: string; expected: string }[];
          hidden_tests?: { input: string; expected: string }[];
          references?: Record<string, string>;
        };
        const title = String(cand.title ?? '').trim();
        if (!title || usedSet.has(title.toLowerCase())) continue;
        usedSet.add(title.toLowerCase());

        const { data: qRow } = await admin
          .from('questions')
          .insert({
            institution_id: course.institution_id,
            course_id: course.id,
            kind: 'endsem',
            assessment_id: assess.id,
            co_code: cand.co_code ?? 'CO1',
            difficulty: cand.difficulty ?? 'medium',
            title,
            statement: cand.statement ?? title,
            input_spec: cand.input_spec ?? '',
            output_spec: cand.output_spec ?? '',
            constraints: cand.constraints ?? '',
            starter_code: cand.starter_code ?? {},
            status: 'candidate',
            source: 'ai',
            valid: judgeUrl ? null : true,
            created_by: authData.user.id,
          })
          .select('id')
          .single();

        if (!qRow) continue;

        const tcRows = [
          ...(cand.visible_tests ?? []).map((tc, i) => ({
            institution_id: course.institution_id,
            question_id: qRow.id,
            ord: i + 1,
            input: tc.input,
            expected: tc.expected,
            hidden: false,
            marks: marksPerTest,
          })),
          ...(cand.hidden_tests ?? []).map((tc, i) => ({
            institution_id: course.institution_id,
            question_id: qRow.id,
            ord: i + 10,
            input: tc.input,
            expected: tc.expected,
            hidden: true,
            marks: marksPerTest,
          })),
        ];
        if (tcRows.length > 0) await admin.from('test_cases').insert(tcRows);

        const refRows = Object.entries(cand.references ?? {}).map(([lang, code]) => ({
          institution_id: course.institution_id,
          question_id: qRow.id,
          lang,
          code,
        }));
        if (refRows.length > 0) await admin.from('reference_solutions').insert(refRows);

        await admin.from('assessment_questions').insert({
          institution_id: course.institution_id,
          assessment_id: assess.id,
          question_id: qRow.id,
          approved: false,
        });

        if (judgeUrl && tcRows.length > 0 && cand.references) {
          const valRes = await validateQuestionWithRunner({
            allowedLangs,
            tests: tcRows,
            references: cand.references,
            runTest: (lang, code, tc) =>
              runOnJudge0({ baseUrl: judgeUrl, apiKey: judgeKey, authHeader: judgeHeader, langIds }, lang, code, tc),
          });
          await admin
            .from('questions')
            .update({ valid: valRes.valid, validation_note: valRes.validation_note })
            .eq('id', qRow.id);
        }

        insertedIds.push(String(qRow.id));
      }

      await admin
        .from('assessments')
        .update({ stage: 'generate', rules_locked: true })
        .eq('id', assess.id)
        .eq('stage', 'rules');

      await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
      return json({ question_ids: insertedIds, run_id: runId }, 200, origin);
    }

    // kind === 'bank'
    const bankPair = await callLlmJson(
      {
        system:
          'You are XeIO Assist. Return ONLY valid JSON {"pre":[...],"post":[...]}. Both arrays must contain 45 distinct MCQs: 15 easy, 15 medium, 15 hard. Zero overlap or paraphrased duplicates between pre and post. Each item: {"level":"easy|medium|hard","stem":"...","options":["A","B","C","D"],"answer":0}.',
        user: `Course: ${course.code} ${course.title}\nSession S${session.n}: ${session.topic}\nCO: ${coRow?.code ?? 'CO1'}, BTL L${session.btl}\nPre-test checks conceptual readiness before lab; post-test checks code behaviour, edge cases, and complexity after solving the lab.`,
        maxTokens: 4096,
      },
      validateBankDraft,
    );

    await admin.from('bank_items').delete().eq('session_id', session.id);

    const bankRows = [
      ...bankPair.pre.map((item) => ({
        institution_id: course.institution_id,
        session_id: session.id,
        bank: 'pre' as const,
        level: item.level,
        stem: item.stem,
        options: item.options,
        answer: item.answer,
        approved: false,
      })),
      ...bankPair.post.map((item) => ({
        institution_id: course.institution_id,
        session_id: session.id,
        bank: 'post' as const,
        level: item.level,
        stem: item.stem,
        options: item.options,
        answer: item.answer,
        approved: false,
      })),
    ];

    const { error: bankErr } = await admin.from('bank_items').insert(bankRows);
    if (bankErr) {
      throw new Error('db_insert_failed');
    }

    await admin.rpc('refresh_session_status', { p_session_id: session.id });
    await admin.from('ai_runs').update({ status: 'completed' }).eq('id', runId);
    await admin.rpc('audit', {
      p_action: 'ai_generate_bank',
      p_object_type: 'session',
      p_object_id: session.id,
      p_detail: { run_id: runId, count: bankRows.length },
      p_institution_id: course.institution_id,
      p_actor_id: authData.user.id,
    });

    return json({ count: bankRows.length, run_id: runId }, 200, origin);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'validation_failed';
    await admin.rpc('refund_ai_credit', {
      p_run_id: runId,
      p_reason: reason,
    });
    return json({ error: reason }, 502, origin);
  }
});
