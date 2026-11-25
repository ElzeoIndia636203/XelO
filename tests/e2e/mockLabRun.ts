import type { Route } from '@playwright/test';

export function istTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export interface Phase4State {
  sessionRuns: Array<{
    id: string;
    institution_id: string;
    session_id: string;
    batch_id: string;
    started_by: string;
    started_at: string;
    attendance_done: boolean;
    attendance_at: string | null;
    ended_at: string | null;
    remark: string | null;
  }>;
  attendance: Array<{
    id: string;
    institution_id: string;
    session_run_id: string;
    assessment_id: string | null;
    student_id: string;
    state: 'present' | 'late' | 'absent';
    marked_by: string;
    marked_at: string;
  }>;
  submissions: Array<{
    id: string;
    institution_id: string;
    course_id: string;
    session_id: string;
    assessment_id: string | null;
    session_run_id: string | null;
    question_id: string;
    student_id: string;
    context: 'lab' | 'exam';
    mode: 'run' | 'submit';
    lang: string;
    code: string;
    verdict: string;
    runtime_ms: number;
    memory_kb: number;
    visible_passed: number;
    visible_total: number;
    hidden_passed: number;
    hidden_total: number;
    created_at: string;
  }>;
  testAttempts: Array<{
    id: string;
    institution_id: string;
    session_id: string;
    student_id: string;
    bank: 'pre' | 'post';
    item_ids: string[];
    started_at: string;
    submitted_at: string | null;
    score: number | null;
    answers?: Record<string, number>;
  }>;
  drafts: Array<{
    id: string;
    institution_id: string;
    student_id: string;
    question_id: string;
    context: 'lab' | 'endsem';
    lang: string;
    code: string;
    updated_at: string;
  }>;
  viva: Array<{
    id: string;
    institution_id: string;
    session_id: string;
    assessment_id: string | null;
    student_id: string;
    marks: number;
    graded_by: string;
    graded_at: string;
  }>;
  labCheckins: Array<{
    id: string;
    institution_id: string;
    session_id: string;
    student_id: string;
    checked_at: string;
  }>;
  courseFlags: Array<{
    id: string;
    institution_id: string;
    course_id: string;
    student_id: string;
    kind: string;
    note: string;
    flagged_by: string;
    created_at: string;
  }>;
  notifications: Array<{
    id: string;
    institution_id: string;
    user_id: string;
    kind: string;
    title: string;
    body: string;
    link: string | null;
    read_at: string | null;
    created_at: string;
  }>;
}

export function createPhase4State(
  instId: string,
  courseId: string,
  seedRun?: boolean | 'pending_attendance' | 'live',
): Phase4State {
  if (!seedRun) {
    return {
      sessionRuns: [],
      attendance: [],
      submissions: [],
      testAttempts: [],
      drafts: [],
      viva: [],
      labCheckins: [],
      courseFlags: [],
      notifications: [],
    };
  }

  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 25 * 60_000).toISOString();
  const isLive = seedRun === 'live';

  const sessionRuns = [
    {
      id: 'run-s1-a',
      institution_id: instId,
      session_id: 'sess-1',
      batch_id: 'batch-a',
      started_by: 'uid-faculty',
      started_at: new Date(Date.now() - 40 * 60_000).toISOString(),
      attendance_done: isLive,
      attendance_at: isLive ? nowIso : null,
      ended_at: null,
      remark: null,
    },
  ];

  const attendance = isLive
    ? [
        {
          id: 'att-1',
          institution_id: instId,
          session_run_id: 'run-s1-a',
          assessment_id: null,
          student_id: 'uid-student-1',
          state: 'present' as const,
          marked_by: 'uid-faculty',
          marked_at: nowIso,
        },
        {
          id: 'att-2',
          institution_id: instId,
          session_run_id: 'run-s1-a',
          assessment_id: null,
          student_id: 'uid-student-2',
          state: 'present' as const,
          marked_by: 'uid-faculty',
          marked_at: nowIso,
        },
        {
          id: 'att-3',
          institution_id: instId,
          session_run_id: 'run-s1-a',
          assessment_id: null,
          student_id: 'uid-student-3',
          state: 'late' as const,
          marked_by: 'uid-faculty',
          marked_at: nowIso,
        },
      ]
    : [];

  const testAttempts = [
    ...(isLive
      ? [
          {
            id: 'ta-pre-1',
            institution_id: instId,
            session_id: 'sess-1',
            student_id: 'uid-student-1',
            bank: 'pre' as const,
            item_ids: ['sess-1-pre-easy-1', 'sess-1-pre-easy-2', 'sess-1-pre-medium-1', 'sess-1-pre-medium-2', 'sess-1-pre-hard-1'],
            answers: {
              'sess-1-pre-easy-1': 0,
              'sess-1-pre-easy-2': 0,
              'sess-1-pre-medium-1': 0,
              'sess-1-pre-medium-2': 0,
              'sess-1-pre-hard-1': 0,
            },
            started_at: staleIso,
            submitted_at: nowIso,
            score: 5,
          },
        ]
      : []),
    {
      id: 'ta-pre-2',
      institution_id: instId,
      session_id: 'sess-1',
      student_id: 'uid-student-2',
      bank: 'pre' as const,
      item_ids: ['sess-1-pre-easy-1', 'sess-1-pre-easy-2', 'sess-1-pre-medium-1', 'sess-1-pre-medium-2', 'sess-1-pre-hard-1'],
      answers: {
        'sess-1-pre-easy-1': 0,
        'sess-1-pre-easy-2': 0,
        'sess-1-pre-medium-1': 1,
        'sess-1-pre-medium-2': 1,
        'sess-1-pre-hard-1': 1,
      },
      started_at: staleIso,
      submitted_at: nowIso,
      score: 2,
    },
    {
      id: 'ta-pre-3',
      institution_id: instId,
      session_id: 'sess-1',
      student_id: 'uid-student-3',
      bank: 'pre' as const,
      item_ids: ['sess-1-pre-easy-1', 'sess-1-pre-easy-2', 'sess-1-pre-medium-1', 'sess-1-pre-medium-2', 'sess-1-pre-hard-1'],
      answers: {
        'sess-1-pre-easy-1': 0,
        'sess-1-pre-easy-2': 1,
        'sess-1-pre-medium-1': 1,
        'sess-1-pre-medium-2': 1,
        'sess-1-pre-hard-1': 1,
      },
      started_at: staleIso,
      submitted_at: nowIso,
      score: 1,
    },
  ];

  const submissions = isLive
    ? [
        {
          id: 'sub-live-1',
          institution_id: instId,
          course_id: courseId,
          session_id: 'sess-1',
          assessment_id: null,
          session_run_id: 'run-s1-a',
          question_id: 'q-s1-1',
          student_id: 'uid-student-1',
          context: 'lab' as const,
          mode: 'submit' as const,
          lang: 'c',
          code: '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d%d",&a,&b)==2)printf("%d:%d\\n",a,b);return 0;}',
          verdict: 'accepted',
          runtime_ms: 8,
          memory_kb: 1820,
          visible_passed: 2,
          visible_total: 2,
          hidden_passed: 3,
          hidden_total: 3,
          created_at: nowIso,
        },
        {
          id: 'sub-live-2',
          institution_id: instId,
          course_id: courseId,
          session_id: 'sess-1',
          assessment_id: null,
          session_run_id: 'run-s1-a',
          question_id: 'q-s1-2',
          student_id: 'uid-student-1',
          context: 'lab' as const,
          mode: 'run' as const,
          lang: 'c',
          code: '#include <stdio.h>\nint main(void){return 0;}',
          verdict: 'visible_passed',
          runtime_ms: 11,
          memory_kb: 1940,
          visible_passed: 2,
          visible_total: 2,
          hidden_passed: 0,
          hidden_total: 0,
          created_at: nowIso,
        },
        ...Array.from({ length: 4 }, (_, idx) => ({
          id: `sub-struggle-${idx + 1}`,
          institution_id: instId,
          course_id: courseId,
          session_id: 'sess-1',
          assessment_id: null,
          session_run_id: 'run-s1-a',
          question_id: 'q-s1-1',
          student_id: 'uid-student-2',
          context: 'lab' as const,
          mode: 'submit' as const,
          lang: 'c',
          code: 'int main(){return 0;}',
          verdict: 'wrong_answer',
          runtime_ms: 10,
          memory_kb: 1700,
          visible_passed: 0,
          visible_total: 2,
          hidden_passed: 0,
          hidden_total: 3,
          created_at: nowIso,
        })),
      ]
    : [];

  const drafts = isLive
    ? [
        {
          id: 'dr-3',
          institution_id: instId,
          student_id: 'uid-student-3',
          question_id: 'q-s1-1',
          context: 'lab' as const,
          lang: 'c',
          code: 'int main(){return 0;}',
          updated_at: staleIso,
        },
      ]
    : [];

  const viva = isLive
    ? [
        {
          id: 'viva-1',
          institution_id: instId,
          session_id: 'sess-1',
          assessment_id: null,
          student_id: 'uid-student-1',
          marks: 9,
          graded_by: 'uid-faculty',
          graded_at: nowIso,
        },
      ]
    : [];

  const labCheckins = [
    { id: 'chk-1', institution_id: instId, session_id: 'sess-1', student_id: 'uid-student-1', checked_at: nowIso },
    { id: 'chk-2', institution_id: instId, session_id: 'sess-1', student_id: 'uid-student-2', checked_at: nowIso },
  ];

  const notifications = [
    {
      id: 'notif-hint-1',
      institution_id: instId,
      user_id: 'uid-student-1',
      kind: 'hint',
      title: 'Hint for S1 · Input and output',
      body: 'Read both integers with scanf("%d %d", &a, &b) before printing.',
      link: '/student/lab/sess-1',
      read_at: null,
      created_at: nowIso,
    },
  ];

  return {
    sessionRuns,
    attendance,
    submissions,
    testAttempts,
    drafts,
    viva,
    labCheckins,
    courseFlags: [],
    notifications,
  };
}

export function applyPostgrestFilters<T extends object>(
  rows: readonly T[],
  url: URL,
): T[] {
  let out = [...rows];
  const valOf = (row: T, key: string): unknown => new Map(Object.entries(row)).get(key);
  for (const [key, val] of url.searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    if (val.startsWith('eq.')) {
      const target = val.slice(3);
      out = out.filter((r) => String(valOf(r, key) ?? '') === target);
    } else if (val.startsWith('in.(') && val.endsWith(')')) {
      const inner = val.slice(4, -1);
      const set = new Set(
        inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')),
      );
      out = out.filter((r) => set.has(String(valOf(r, key) ?? '')));
    } else if (val === 'is.null') {
      out = out.filter((r) => {
        const v = valOf(r, key);
        return v === null || v === undefined;
      });
    }
  }
  return out;
}

export async function handlePhase4Edge(
  route: Route,
  urlStr: string,
  bodyJson: Record<string, unknown>,
  ctx: {
    instId: string;
    courseId: string;
    actorId: string;
    state: Phase4State;
    testCases: Array<{
      id: string;
      question_id: string;
      ord: number;
      input: string;
      expected: string;
      hidden: boolean;
    }>;
  },
): Promise<boolean> {
  if (!urlStr.endsWith('/run-code')) return false;

  const qid = String(bodyJson.question_id ?? '');
  const lang = String(bodyJson.lang ?? 'c');
  const code = String(bodyJson.code ?? '');
  const mode = bodyJson.mode === 'submit' ? 'submit' : 'run';

  if (code.includes('COMPILE_ERR')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode,
        verdict: 'compile_error',
        runtime_ms: 0,
        memory_kb: 0,
        compile_error: 'error: expected ; before return',
        visible_passed: 0,
        visible_total: 2,
        hidden_passed: 0,
        hidden_total: 0,
        visible_results: [],
        hidden_summary: { passed: 0, total: 3 },
      }),
    });
    return true;
  }

  const vis = ctx.testCases
    .filter((tc) => tc.question_id === qid && !tc.hidden)
    .sort((a, b) => a.ord - b.ord);
  const hidCount = ctx.testCases.filter((tc) => tc.question_id === qid && tc.hidden).length || 3;
  const failVis = code.includes('FAIL_VISIBLE');
  const failHid = code.includes('FAIL_HIDDEN');
  const visiblePassed = failVis ? 0 : vis.length;
  const hiddenPassed = mode === 'submit' ? (failVis || failHid ? 0 : hidCount) : 0;
  const hiddenTotal = mode === 'submit' ? hidCount : 0;
  const verdict =
    visiblePassed < vis.length
      ? 'wrong_answer'
      : mode === 'submit' && hiddenPassed < hidCount
        ? 'wrong_answer'
        : mode === 'submit'
          ? 'accepted'
          : 'visible_passed';

  const run = ctx.state.sessionRuns.find((r) => r.session_id === 'sess-1');
  ctx.state.submissions.unshift({
    id: `sub-${ctx.state.submissions.length + 1}`,
    institution_id: ctx.instId,
    course_id: ctx.courseId,
    session_id: 'sess-1',
    assessment_id: null,
    session_run_id: run?.id ?? null,
    question_id: qid,
    student_id: ctx.actorId,
    context: 'lab',
    mode,
    lang,
    code,
    verdict,
    runtime_ms: 14,
    memory_kb: 2048,
    visible_passed: visiblePassed,
    visible_total: vis.length,
    hidden_passed: hiddenPassed,
    hidden_total: hiddenTotal,
    created_at: new Date().toISOString(),
  });

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      mode,
      verdict,
      runtime_ms: 14,
      memory_kb: 2048,
      compile_error: null,
      visible_passed: visiblePassed,
      visible_total: vis.length,
      hidden_passed: hiddenPassed,
      hidden_total: hiddenTotal,
      visible_results: vis.map((tc) => ({
        ord: tc.ord,
        input: tc.input,
        expected: tc.expected,
        actual: failVis ? 'wrong' : tc.expected,
        passed: !failVis,
        status: failVis ? 'Wrong Answer' : 'Accepted',
        time_ms: 7,
      })),
      hidden_summary: { passed: hiddenPassed, total: hidCount },
    }),
  });
  return true;
}

export async function handlePhase4Rpc(
  route: Route,
  path: string,
  body: Record<string, unknown>,
  ctx: {
    instId: string;
    courseId: string;
    actorId: string;
    state: Phase4State;
    batches: Array<{ id: string; course_id: string; class_code: string }>;
    enrollments: Array<{ id: string; course_id: string; batch_id: string; institution_id: string; student_id: string; created_at: string }>;
    profiles: Array<{ id: string; full_name: string; roll_no: string | null; email: string }>;
    sessions: Array<{ id: string; status: string }>;
    sessionQuestions: Array<{ session_id: string; question_id: string }>;
    bankItems: Array<{ id: string; session_id: string; bank: string; level: string; stem: string; options: string[]; answer: number; approved: boolean }>;
  },
): Promise<boolean> {
  const fulfill = (status: number, data: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

  if (path.endsWith('/rpc/hidden_test_counts')) {
    const qIds = (body.p_question_ids as string[]) ?? [];
    await fulfill(
      200,
      qIds.map((qid) => ({ question_id: qid, visible_count: 2, hidden_count: 3 })),
    );
    return true;
  }

  if (path.endsWith('/rpc/join_with_code')) {
    const code = String(body.p_class_code ?? '').trim().toUpperCase();
    const batch = ctx.batches.find((b) => b.class_code.toUpperCase() === code);
    if (!batch) {
      await fulfill(400, { message: 'invalid_class_code' });
      return true;
    }
    if (!ctx.enrollments.some((e) => e.student_id === ctx.actorId && e.batch_id === batch.id)) {
      ctx.enrollments.push({
        id: `enr-${ctx.enrollments.length + 1}`,
        course_id: batch.course_id,
        batch_id: batch.id,
        institution_id: ctx.instId,
        student_id: ctx.actorId,
        created_at: new Date().toISOString(),
      });
    }
    await fulfill(200, batch.id);
    return true;
  }

  if (path.endsWith('/rpc/start_session_run')) {
    const sid = String(body.p_session_id ?? '');
    const bid = String(body.p_batch_id ?? '');
    const hit = ctx.state.sessionRuns.find((r) => r.session_id === sid && r.batch_id === bid);
    if (hit) {
      await fulfill(200, hit.id);
      return true;
    }
    const id = `run-${ctx.state.sessionRuns.length + 1}`;
    ctx.state.sessionRuns.push({
      id,
      institution_id: ctx.instId,
      session_id: sid,
      batch_id: bid,
      started_by: ctx.actorId,
      started_at: new Date().toISOString(),
      attendance_done: false,
      attendance_at: null,
      ended_at: null,
      remark: null,
    });
    await fulfill(200, id);
    return true;
  }

  if (path.endsWith('/rpc/lab_checkin')) {
    const sid = String(body.p_session_id ?? '');
    if (!ctx.state.labCheckins.some((c) => c.session_id === sid && c.student_id === ctx.actorId)) {
      ctx.state.labCheckins.push({
        id: `chk-${ctx.state.labCheckins.length + 1}`,
        institution_id: ctx.instId,
        session_id: sid,
        student_id: ctx.actorId,
        checked_at: new Date().toISOString(),
      });
    }
    await fulfill(200, new Date().toISOString());
    return true;
  }

  if (path.endsWith('/rpc/suggest_attendance')) {
    const rid = String(body.p_run_id ?? '');
    const run = ctx.state.sessionRuns.find((r) => r.id === rid);
    if (!run) {
      await fulfill(404, { message: 'not_found' });
      return true;
    }
    const stuIds = ctx.enrollments
      .filter((e) => e.batch_id === run.batch_id)
      .map((e) => e.student_id);
    const out = stuIds.map((sid) => {
      const p = ctx.profiles.find((pr) => pr.id === sid);
      const existing = ctx.state.attendance.find(
        (a) => a.session_run_id === rid && a.student_id === sid,
      );
      const checked = ctx.state.labCheckins.some(
        (c) => c.session_id === run.session_id && c.student_id === sid,
      );
      return {
        student_id: sid,
        full_name: p?.full_name ?? 'Student',
        roll_no: p?.roll_no ?? '2301000',
        email: p?.email ?? 'student@sanjivani.edu.in',
        suggested_state: existing?.state ?? (checked ? 'present' : 'absent'),
      };
    });
    await fulfill(200, out);
    return true;
  }

  if (path.endsWith('/rpc/save_attendance')) {
    const rid = String(body.p_run_id ?? '');
    const entries = (body.p_entries as Array<{ student_id: string; state: 'present' | 'late' | 'absent' }>) ?? [];
    const run = ctx.state.sessionRuns.find((r) => r.id === rid);
    if (run) {
      run.attendance_done = true;
      run.attendance_at = new Date().toISOString();
    }
    for (const ent of entries) {
      const existing = ctx.state.attendance.find(
        (a) => a.session_run_id === rid && a.student_id === ent.student_id,
      );
      if (existing) {
        existing.state = ent.state;
        existing.marked_at = new Date().toISOString();
      } else {
        ctx.state.attendance.push({
          id: `att-${ctx.state.attendance.length + 1}`,
          institution_id: ctx.instId,
          session_run_id: rid,
          assessment_id: null,
          student_id: ent.student_id,
          state: ent.state,
          marked_by: ctx.actorId,
          marked_at: new Date().toISOString(),
        });
      }
    }
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/end_session_run')) {
    const rid = String(body.p_run_id ?? '');
    const remark = (body.p_remark as string | null) ?? null;
    const run = ctx.state.sessionRuns.find((r) => r.id === rid);
    if (run) {
      run.ended_at = new Date().toISOString();
      run.remark = remark;
      const sess = ctx.sessions.find((s) => s.id === run.session_id);
      if (sess) sess.status = 'conducted';
    }
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/start_test')) {
    const sid = String(body.p_session_id ?? '');
    const bank: 'pre' | 'post' = body.p_bank === 'post' ? 'post' : 'pre';
    const existing = ctx.state.testAttempts.find(
      (a) => a.session_id === sid && a.student_id === ctx.actorId && a.bank === bank,
    );
    if (existing?.submitted_at) {
      await fulfill(400, { message: 'already_submitted' });
      return true;
    }
    if (bank === 'post') {
      const sqs = ctx.sessionQuestions.filter((sq) => sq.session_id === sid);
      const allHid =
        sqs.length >= 2 &&
        sqs.every((sq) =>
          ctx.state.submissions.some(
            (s) =>
              s.student_id === ctx.actorId &&
              s.question_id === sq.question_id &&
              s.mode === 'submit' &&
              s.hidden_total > 0 &&
              s.hidden_passed >= s.hidden_total,
          ),
        );
      if (!allHid) {
        await fulfill(400, { message: 'post_test_locked' });
        return true;
      }
    }

    const pool = ctx.bankItems.filter((b) => b.session_id === sid && b.bank === bank && b.approved);
    const draw = existing
      ? existing.item_ids
          .map((id) => pool.find((b) => b.id === id))
          .filter((b): b is NonNullable<typeof b> => Boolean(b))
      : [
          ...pool.filter((b) => b.level === 'easy').slice(0, bank === 'pre' ? 2 : 1),
          ...pool.filter((b) => b.level === 'medium').slice(0, 2),
          ...pool.filter((b) => b.level === 'hard').slice(0, bank === 'pre' ? 1 : 2),
        ];

    const attempt =
      existing ??
      (() => {
        const created = {
          id: `ta-${ctx.state.testAttempts.length + 1}`,
          institution_id: ctx.instId,
          session_id: sid,
          student_id: ctx.actorId,
          bank,
          item_ids: draw.map((d) => d.id),
          started_at: new Date().toISOString(),
          submitted_at: null,
          score: null,
        };
        ctx.state.testAttempts.push(created);
        return created;
      })();

    await fulfill(200, {
      attempt_id: attempt.id,
      bank,
      started_at: attempt.started_at,
      items: draw.map((d) => ({ id: d.id, level: d.level, stem: d.stem, options: d.options })),
    });
    return true;
  }

  if (path.endsWith('/rpc/submit_test')) {
    const aid = String(body.p_attempt_id ?? '');
    const answerMap = new Map<string, unknown>(Object.entries((body.p_answers as Record<string, unknown>) ?? {}));
    const attempt = ctx.state.testAttempts.find((a) => a.id === aid);
    if (!attempt) {
      await fulfill(404, { message: 'not_found' });
      return true;
    }
    let score = 0;
    for (const itemId of attempt.item_ids) {
      const item = ctx.bankItems.find((b) => b.id === itemId);
      if (item && answerMap.get(itemId) === item.answer) score++;
    }
    attempt.submitted_at = new Date().toISOString();
    attempt.score = score;
    await fulfill(200, { score, total: attempt.item_ids.length });
    return true;
  }

  if (path.endsWith('/rpc/save_draft')) {
    const qid = String(body.p_question_id ?? '');
    const context = body.p_context === 'endsem' ? 'endsem' : 'lab';
    const lang = String(body.p_lang ?? 'c');
    const code = String(body.p_code ?? '');
    const existing = ctx.state.drafts.find(
      (d) =>
        d.student_id === ctx.actorId &&
        d.question_id === qid &&
        d.context === context &&
        d.lang === lang,
    );
    if (existing) {
      existing.code = code;
      existing.updated_at = new Date().toISOString();
      await fulfill(200, existing.id);
    } else {
      const id = `dr-${ctx.state.drafts.length + 1}`;
      ctx.state.drafts.push({
        id,
        institution_id: ctx.instId,
        student_id: ctx.actorId,
        question_id: qid,
        context,
        lang,
        code,
        updated_at: new Date().toISOString(),
      });
      await fulfill(200, id);
    }
    return true;
  }

  if (path.endsWith('/rpc/set_viva')) {
    const sid = String(body.p_session_id ?? '');
    const stuId = String(body.p_student_id ?? '');
    const marks = Number(body.p_marks ?? 0);
    if (marks < 0 || marks > 10) {
      await fulfill(400, { message: 'viva_exceeds_rubric' });
      return true;
    }
    const run = ctx.state.sessionRuns.find((r) => r.session_id === sid);
    const att = run
      ? ctx.state.attendance.find((a) => a.session_run_id === run.id && a.student_id === stuId)
      : null;
    if (att?.state === 'absent') {
      await fulfill(400, { message: 'student_absent' });
      return true;
    }
    const existing = ctx.state.viva.find((v) => v.session_id === sid && v.student_id === stuId);
    if (existing) {
      existing.marks = marks;
      existing.graded_at = new Date().toISOString();
    } else {
      ctx.state.viva.push({
        id: `viva-${ctx.state.viva.length + 1}`,
        institution_id: ctx.instId,
        session_id: sid,
        assessment_id: null,
        student_id: stuId,
        marks,
        graded_by: ctx.actorId,
        graded_at: new Date().toISOString(),
      });
    }
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/send_hint')) {
    const runId = String(body.p_run_id ?? '');
    const run = ctx.state.sessionRuns.find((r) => r.id === runId);
    const sid = run?.session_id ?? String(body.p_session_id ?? 'sess-1');
    const stuIds = (body.p_student_ids as string[]) ?? [];
    const msg = String(body.p_text ?? body.p_body ?? '');
    for (const uid of stuIds) {
      ctx.state.notifications.unshift({
        id: `notif-${ctx.state.notifications.length + 1}`,
        institution_id: ctx.instId,
        user_id: uid,
        kind: 'hint',
        title: `Hint for ${sid}`,
        body: msg,
        link: `/student/lab/${sid}`,
        read_at: null,
        created_at: new Date().toISOString(),
      });
    }
    await fulfill(200, stuIds.length);
    return true;
  }

  if (path.endsWith('/rpc/flag_student')) {
    ctx.state.courseFlags.push({
      id: `flg-${ctx.state.courseFlags.length + 1}`,
      institution_id: ctx.instId,
      course_id: String(body.p_course_id ?? ctx.courseId),
      student_id: String(body.p_student_id ?? ''),
      kind: String(body.p_kind ?? 'slow'),
      note: String(body.p_note ?? ''),
      flagged_by: ctx.actorId,
      created_at: new Date().toISOString(),
    });
    await fulfill(200, null);
    return true;
  }

  return false;
}

export async function handlePhase4Rest(
  route: Route,
  method: string,
  path: string,
  url: URL,
  isSingle: boolean,
  bodyJson: Record<string, unknown> | null,
  state: Phase4State,
): Promise<boolean> {
  const fulfillRows = (rows: Array<Record<string, unknown>>) => {
    const filtered = applyPostgrestFilters(rows, url);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isSingle ? (filtered[0] ?? null) : filtered),
    });
  };

  if (method === 'PATCH' && path.endsWith('/notifications')) {
    const matching = applyPostgrestFilters(state.notifications, url);
    const readAt = typeof bodyJson?.read_at === 'string' ? bodyJson.read_at : new Date().toISOString();
    for (const n of matching) n.read_at = readAt;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(matching) });
    return true;
  }

  if (method !== 'GET') return false;

  if (path.endsWith('/session_runs')) {
    await fulfillRows(state.sessionRuns);
    return true;
  }
  if (path.endsWith('/attendance')) {
    await fulfillRows(state.attendance);
    return true;
  }
  if (path.endsWith('/submissions')) {
    await fulfillRows(state.submissions);
    return true;
  }
  if (path.endsWith('/test_attempts')) {
    await fulfillRows(state.testAttempts);
    return true;
  }
  if (path.endsWith('/drafts')) {
    await fulfillRows(state.drafts);
    return true;
  }
  if (path.endsWith('/viva')) {
    await fulfillRows(state.viva);
    return true;
  }
  if (path.endsWith('/lab_checkins')) {
    await fulfillRows(state.labCheckins);
    return true;
  }
  if (path.endsWith('/course_flags')) {
    await fulfillRows(state.courseFlags);
    return true;
  }
  if (path.endsWith('/notifications')) {
    await fulfillRows(state.notifications);
    return true;
  }

  return false;
}
