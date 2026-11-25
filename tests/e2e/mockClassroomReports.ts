import type { Route } from '@playwright/test';
import { applyPostgrestFilters, istTodayIso, type Phase4State } from './mockLabRun';

export interface ClassItemMock {
  id: string;
  institution_id: string;
  course_id: string;
  week: number;
  kind: 'task' | 'resource' | 'announcement';
  task_type: 'quiz' | 'fill' | 'predict' | 'debug' | 'assignment' | 'poll' | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  due_at: string | null;
  url: string | null;
  file_path: string | null;
  created_by: string;
  created_at: string;
}

export interface ClassAnswerKeyMock {
  id: string;
  institution_id: string;
  item_id: string;
  answer: { expected?: string };
}

export interface ClassResponseMock {
  id: string;
  institution_id: string;
  item_id: string;
  student_id: string;
  answer: { value: string };
  score: number | null;
  submitted_at: string;
}

export interface CourseNotesMock {
  course_id: string;
  institution_id: string;
  bos_suggestions: string;
  internal_summary: string;
  overall_summary: string;
  updated_by: string;
  updated_at: string;
}

export interface Phase5State {
  classItems: ClassItemMock[];
  classAnswerKeys: ClassAnswerKeyMock[];
  classResponses: ClassResponseMock[];
  courseNotes: CourseNotesMock | null;
  courseSnapshots: Array<Record<string, unknown>>;
  approvals: Array<{
    id: string;
    institution_id: string;
    object_type: string;
    object_id: string;
    approver_id: string;
    decision: 'approved' | 'declined' | 'returned';
    remark: string | null;
    content_hash: string;
    at: string;
  }>;
  tokenCounter: number;
  itemCounter: number;
}

export function addDaysIso(baseIso: string, deltaDays: number): string {
  const dt = new Date(`${baseIso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

export function createPhase5State(instId: string, courseId: string, seed?: boolean): Phase5State {
  if (!seed) {
    return {
      classItems: [],
      classAnswerKeys: [],
      classResponses: [],
      courseNotes: null,
      courseSnapshots: [],
      approvals: [],
      tokenCounter: 1,
      itemCounter: 1,
    };
  }

  const nowIso = '2026-11-25T10:00:00Z';
  return {
    classItems: [
      {
        id: 'ci-ann-1',
        institution_id: instId,
        course_id: courseId,
        week: 2,
        kind: 'announcement',
        task_type: null,
        title: 'Lab S2 pre-test window closes at 10:00',
        body: 'Finish your 5-question pre-test before entering Lab 3.',
        payload: {},
        due_at: null,
        url: null,
        file_path: null,
        created_by: 'uid-faculty',
        created_at: nowIso,
      },
      {
        id: 'ci-res-1',
        institution_id: instId,
        course_id: courseId,
        week: 2,
        kind: 'resource',
        task_type: null,
        title: 'C Operator Precedence Sheet',
        body: 'Printable reference chart for arithmetic and bitwise operators.',
        payload: {},
        due_at: null,
        url: null,
        file_path: `${courseId}/c-operators.pdf`,
        created_by: 'uid-faculty',
        created_at: nowIso,
      },
      {
        id: 'ci-res-link',
        institution_id: instId,
        course_id: courseId,
        week: 2,
        kind: 'resource',
        task_type: null,
        title: 'GNU C Reference Manual',
        body: 'External standard C expressions reference.',
        payload: {},
        due_at: null,
        url: 'https://www.gnu.org/software/gnu-c-manual/',
        file_path: null,
        created_by: 'uid-faculty',
        created_at: nowIso,
      },
      {
        id: 'ci-task-1',
        institution_id: instId,
        course_id: courseId,
        week: 2,
        kind: 'task',
        task_type: 'predict',
        title: 'Predict printf return value',
        body: 'What is printed to stdout by the C snippet below?',
        payload: { code: 'int x = 5 > 3 && 2;\nprintf("%d", x);' },
        due_at: null,
        url: null,
        file_path: null,
        created_by: 'uid-faculty',
        created_at: nowIso,
      },
    ],
    classAnswerKeys: [
      {
        id: 'cak-1',
        institution_id: instId,
        item_id: 'ci-task-1',
        answer: { expected: '1' },
      },
    ],
    classResponses: [
      {
        id: 'cr-1',
        institution_id: instId,
        item_id: 'ci-task-1',
        student_id: 'uid-student-2',
        answer: { value: '1' },
        score: 1,
        submitted_at: nowIso,
      },
    ],
    courseNotes: {
      course_id: courseId,
      institution_id: instId,
      bos_suggestions: 'Include step-by-step GDB memory inspection in Week 3.',
      internal_summary: 'Batch A progressed steadily in S1; targeted practice planned for struggling students.',
      overall_summary: '',
      updated_by: 'uid-faculty',
      updated_at: nowIso,
    },
    courseSnapshots: [],
    approvals: [
      {
        id: 'app-plan-1',
        institution_id: instId,
        object_type: 'course_plan',
        object_id: courseId,
        approver_id: 'uid-hod',
        decision: 'approved',
        remark: 'Course outcomes and lab schedule approved.',
        content_hash: 'e9f4b2c1a0847d9e1234',
        at: '2026-11-24T11:30:00Z',
      },
    ],
    tokenCounter: 1,
    itemCounter: 10,
  };
}

export function augmentPhase4ForReports(instId: string, courseId: string, state: Phase4State) {
  const nowIso = new Date().toISOString();
  const todayIso = istTodayIso();
  const run1 = state.sessionRuns.find((r) => r.id === 'run-s1-a');
  if (run1) {
    run1.started_at = `${todayIso}T04:30:00Z`;
    run1.ended_at = nowIso;
    run1.remark = 'Completed Batch A cleanly';
  }
  if (!state.sessionRuns.some((r) => r.id === 'run-s1-b')) {
    state.sessionRuns.push({
      id: 'run-s1-b',
      institution_id: instId,
      session_id: 'sess-1',
      batch_id: 'batch-b',
      started_by: 'uid-faculty',
      started_at: `${todayIso}T08:30:00Z`,
      attendance_done: true,
      attendance_at: `${todayIso}T08:35:00Z`,
      ended_at: nowIso,
      remark: 'Completed Batch B on schedule',
    });
  }
  if (!state.submissions.some((s) => s.id === 'sub-live-1b')) {
    state.submissions.push({
      id: 'sub-live-1b',
      institution_id: instId,
      course_id: courseId,
      session_id: 'sess-1',
      assessment_id: null,
      session_run_id: 'run-s1-a',
      question_id: 'q-s1-2',
      student_id: 'uid-student-1',
      context: 'lab',
      mode: 'submit',
      lang: 'c',
      code: '#include <stdio.h>\nint main(void){long long a,b;if(scanf("%lld%lld",&a,&b)==2)printf("%lld\\n",a+b);return 0;}',
      verdict: 'accepted',
      runtime_ms: 9,
      memory_kb: 1850,
      visible_passed: 2,
      visible_total: 2,
      hidden_passed: 3,
      hidden_total: 3,
      created_at: nowIso,
    });
  }
  if (!state.testAttempts.some((a) => a.id === 'ta-post-1')) {
    state.testAttempts.push({
      id: 'ta-post-1',
      institution_id: instId,
      session_id: 'sess-1',
      student_id: 'uid-student-1',
      bank: 'post',
      item_ids: ['sess-1-post-easy-1', 'sess-1-post-medium-1', 'sess-1-post-medium-2', 'sess-1-post-hard-1', 'sess-1-post-hard-2'],
      answers: {
        'sess-1-post-easy-1': 0,
        'sess-1-post-medium-1': 0,
        'sess-1-post-medium-2': 0,
        'sess-1-post-hard-1': 0,
        'sess-1-post-hard-2': 0,
      },
      started_at: nowIso,
      submitted_at: nowIso,
      score: 5,
    });
  }
  if (!state.notifications.some((n) => n.user_id === 'uid-faculty')) {
    state.notifications.unshift({
      id: 'notif-fac-1',
      institution_id: instId,
      user_id: 'uid-faculty',
      kind: 'course_plan_decided',
      title: 'Course plan approved by HOD',
      body: 'CSL-101 · Programming in C Lab plan is ready for scheduled labs.',
      link: `/faculty/c/${courseId}/classroom`,
      read_at: null,
      created_at: nowIso,
    });
  }
  if (!state.notifications.some((n) => n.user_id === 'uid-hod')) {
    state.notifications.unshift({
      id: 'notif-hod-1',
      institution_id: instId,
      user_id: 'uid-hod',
      kind: 'final_marks_submitted',
      title: 'CSL-101 · Final marks pending approval',
      body: 'Demo Faculty submitted CSL-101 final marks.',
      link: '/hod?tab=approvals',
      read_at: null,
      created_at: nowIso,
    });
  }
}

export async function handlePhase5Edge(
  route: Route,
  url: string,
  body: Record<string, unknown>,
  aiCallCount: number,
): Promise<boolean> {
  if (url.includes('/functions/v1/calendar')) {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('t') ?? '';
    if (!token || token === 'invalid') {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_token' }),
      });
      return true;
    }
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//XeIO by Elzeo//Lab Schedule//EN',
      'BEGIN:VEVENT',
      'UID:sess-2@xeio.in',
      'SUMMARY:CSL-101 · S2 Operators and expressions',
      'DTSTART:20261125T043000Z',
      'DTEND:20261125T063000Z',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    await route.fulfill({
      status: 200,
      contentType: 'text/calendar; charset=utf-8',
      body: ics,
    });
    return true;
  }

  if (!url.endsWith('/ai-generate')) return false;

  const kind = String(body.kind ?? '');
  if (kind === 'class_task') {
    const ttype = String(body.task_type ?? 'quiz');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run_id: `run-p5-${aiCallCount}`,
        draft: {
          kind: 'class_task',
          task_type: ttype,
          title: ttype === 'quiz' ? 'Operator precedence check' : 'Trace bitwise AND expression',
          body:
            ttype === 'quiz'
              ? 'Which value does (2 + 3 * 4) evaluate to in C?'
              : 'State the exact integer printed to stdout.',
          payload: {
            code: ttype === 'quiz' ? 'printf("%d", 2 + 3 * 4);' : 'int a = 6, b = 3;\nprintf("%d", a & b);',
            ...(ttype === 'quiz' || ttype === 'poll' ? { options: ['14', '20', '24', '9'] } : {}),
          },
          answer_key: { expected: ttype === 'quiz' ? '0' : '2' },
        },
      }),
    });
    return true;
  }

  if (kind === 'announcement') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run_id: `run-p5-${aiCallCount}`,
        draft: {
          kind: 'announcement',
          title: 'Bring lab manual printout for S2',
          body: 'Students must verify S1 hidden pass status before entering Lab 3.',
        },
      }),
    });
    return true;
  }

  if (kind === 'report_narrative') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run_id: `run-p5-${aiCallCount}`,
        draft: {
          kind: 'report_narrative',
          internal_summary: 'Internal cohort average reached 46% across S1 with high top-end mastery.',
          overall_summary: 'Awaiting end-sem practical conduct for combined 0.4/0.6 CO attainment.',
          bos_suggestions: 'Introduce extra debugging exercises prior to pointer units.',
        },
      }),
    });
    return true;
  }

  return false;
}

export async function handlePhase5Storage(route: Route): Promise<boolean> {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname;
  const method = req.method();

  if (method === 'POST' && path.includes('/storage/v1/object/sign/class-files/')) {
    const idx = path.indexOf('/storage/v1/object/sign/class-files/');
    const rel = path.slice(idx + '/storage/v1/object/sign/class-files/'.length);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        signedURL: `/object/sign/class-files/${rel}?token=mock-signed-token`,
      }),
    });
    return true;
  }

  if (method === 'POST' && path.includes('/storage/v1/object/class-files/')) {
    const idx = path.indexOf('/storage/v1/object/class-files/');
    const rel = path.slice(idx + '/storage/v1/object/class-files/'.length);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ Key: `class-files/${rel}`, Id: `file-${Date.now()}` }),
    });
    return true;
  }

  if (method === 'GET' && path.includes('/storage/v1/object/')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4\n% Mock XeIO Private Course Resource\n',
    });
    return true;
  }

  return false;
}

export interface Phase5RpcContext {
  instId: string;
  instName: string;
  courseId: string;
  actorId: string;
  actorRole: string | null;
  state: Phase5State;
  phase4State: Phase4State;
  courses: Array<Record<string, unknown>>;
  profiles: Array<{ id: string; full_name: string; roll_no: string | null; calendar_token: string }>;
  enrollments: Array<{ course_id: string; student_id: string }>;
  rotateSessionToken: (newToken: string) => void;
}

export async function handlePhase5Rpc(
  route: Route,
  path: string,
  body: Record<string, unknown>,
  ctx: Phase5RpcContext,
): Promise<boolean> {
  const fulfill = (status: number, payload: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

  if (path.endsWith('/rpc/rotate_calendar_token')) {
    ctx.state.tokenCounter += 1;
    const nextToken = `55555555-5555-4444-8888-${String(ctx.state.tokenCounter).padStart(12, '0')}`;
    const prof = ctx.profiles.find((p) => p.id === ctx.actorId);
    if (prof) prof.calendar_token = nextToken;
    ctx.rotateSessionToken(nextToken);
    await fulfill(200, nextToken);
    return true;
  }

  if (path.endsWith('/rpc/create_class_item')) {
    ctx.state.itemCounter += 1;
    const id = `ci-${ctx.state.itemCounter}`;
    const kind = (String(body.p_kind ?? 'task') as ClassItemMock['kind']);
    const ttype = body.p_task_type ? (String(body.p_task_type) as ClassItemMock['task_type']) : null;
    ctx.state.classItems.push({
      id,
      institution_id: ctx.instId,
      course_id: String(body.p_course_id ?? ctx.courseId),
      week: Number(body.p_week ?? 1),
      kind,
      task_type: kind === 'task' ? ttype : null,
      title: String(body.p_title ?? ''),
      body: String(body.p_body ?? ''),
      payload: (body.p_payload ?? {}) as Record<string, unknown>,
      due_at: body.p_due_at ? String(body.p_due_at) : null,
      url: body.p_url ? String(body.p_url) : null,
      file_path: body.p_file_path ? String(body.p_file_path) : null,
      created_by: ctx.actorId,
      created_at: new Date().toISOString(),
    });
    const ansKey = body.p_answer_key as { expected?: string } | null | undefined;
    if (kind === 'task' && ansKey) {
      ctx.state.classAnswerKeys.push({
        id: `cak-${ctx.state.itemCounter}`,
        institution_id: ctx.instId,
        item_id: id,
        answer: ansKey,
      });
    }
    await fulfill(200, id);
    return true;
  }

  if (path.endsWith('/rpc/submit_class_response')) {
    const itemId = String(body.p_item_id ?? '');
    const ansObj = (body.p_answer ?? {}) as { value?: string };
    const val = String(ansObj.value ?? '').trim();
    const keyRow = ctx.state.classAnswerKeys.find((k) => k.item_id === itemId);
    const itemRow = ctx.state.classItems.find((i) => i.id === itemId);
    let score: number | null = 1;
    if (itemRow?.task_type === 'poll') {
      score = 1;
    } else if (keyRow && keyRow.answer.expected !== undefined) {
      score = val.toLowerCase() === keyRow.answer.expected.trim().toLowerCase() ? 1 : 0;
    }
    const existing = ctx.state.classResponses.find(
      (r) => r.item_id === itemId && r.student_id === ctx.actorId,
    );
    if (existing) {
      existing.answer = { value: val };
      existing.score = score;
      existing.submitted_at = new Date().toISOString();
    } else {
      ctx.state.classResponses.push({
        id: `cr-${ctx.state.classResponses.length + 1}`,
        institution_id: ctx.instId,
        item_id: itemId,
        student_id: ctx.actorId,
        answer: { value: val },
        score,
        submitted_at: new Date().toISOString(),
      });
    }
    await fulfill(200, score);
    return true;
  }

  if (path.endsWith('/rpc/save_course_notes')) {
    ctx.state.courseNotes = {
      course_id: String(body.p_course_id ?? ctx.courseId),
      institution_id: ctx.instId,
      bos_suggestions: String(body.p_bos_suggestions ?? ''),
      internal_summary: String(body.p_internal_summary ?? ''),
      overall_summary: String(body.p_overall_summary ?? ''),
      updated_by: ctx.actorId,
      updated_at: new Date().toISOString(),
    };
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/save_course_snapshot')) {
    const snapId = `snap-${ctx.state.courseSnapshots.length + 1}`;
    ctx.state.courseSnapshots.push({
      id: snapId,
      institution_id: ctx.instId,
      course_id: String(body.p_course_id ?? ctx.courseId),
      students: Number(body.p_students ?? 0),
      internal_mean: Number(body.p_internal_mean ?? 0),
      below_40: Number(body.p_below_40 ?? 0),
      co_internal: body.p_co_internal ?? {},
      co_overall: body.p_co_overall ?? {},
      overall_pct: Number(body.p_overall_pct ?? 0),
      computed_at: new Date().toISOString(),
    });
    await fulfill(200, snapId);
    return true;
  }

  if (path.endsWith('/rpc/submit_final_marks')) {
    const cid = String(body.p_course_id ?? ctx.courseId);
    const course = ctx.courses.find((c) => c.id === cid);
    if (!course) {
      await fulfill(400, { message: 'not_found' });
      return true;
    }
    course.final_status = 'sent';
    ctx.phase4State.notifications.unshift({
      id: `notif-fin-${Date.now()}`,
      institution_id: ctx.instId,
      user_id: 'uid-hod',
      kind: 'final_marks_submitted',
      title: `${String(course.code ?? 'Course')} · Final marks pending approval`,
      body: 'Faculty submitted final marks.',
      link: '/hod?tab=approvals',
      read_at: null,
      created_at: new Date().toISOString(),
    });
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/decide_final_marks')) {
    const cid = String(body.p_course_id ?? ctx.courseId);
    const approve = Boolean(body.p_approve);
    const remark = String(body.p_remark ?? '').trim();
    const course = ctx.courses.find((c) => c.id === cid);
    if (!course) {
      await fulfill(400, { message: 'not_found' });
      return true;
    }
    if (!approve && !remark) {
      await fulfill(400, { message: 'remark_required' });
      return true;
    }
    if (ctx.actorRole === 'hod') {
      course.final_status = approve ? 'hod_approved' : 'returned';
    } else if (ctx.actorRole === 'coe') {
      course.final_status = approve ? 'coe_accepted' : 'returned';
    } else {
      await fulfill(403, { message: 'forbidden' });
      return true;
    }
    ctx.state.approvals.unshift({
      id: `app-fin-${ctx.state.approvals.length + 1}`,
      institution_id: ctx.instId,
      object_type: 'final_marks',
      object_id: cid,
      approver_id: ctx.actorId,
      decision: approve ? 'approved' : 'returned',
      remark: remark || null,
      content_hash: `hash-${cid.slice(0, 6)}`,
      at: new Date().toISOString(),
    });
    await fulfill(200, null);
    return true;
  }

  if (path.endsWith('/rpc/verify_lab_file')) {
    const cid = String(body.p_course_id ?? '');
    const sid = String(body.p_student_id ?? '');
    const course = ctx.courses.find((c) => c.id === cid);
    const student = ctx.profiles.find((p) => p.id === sid);
    const enrolled = ctx.enrollments.some((e) => e.course_id === cid && e.student_id === sid);
    if (!course || !student || !enrolled) {
      await fulfill(200, { found: false });
      return true;
    }
    const stuAtt = ctx.phase4State.attendance.filter((a) => a.student_id === sid);
    const attPresent = stuAtt.filter((a) => a.state === 'present' || a.state === 'late').length;
    const attPct = stuAtt.length > 0 ? Math.round((attPresent / stuAtt.length) * 100) : 100;
    const vivaRow = ctx.phase4State.viva.find((v) => v.student_id === sid);
    const internalOut = sid === 'uid-student-1' ? 98 : vivaRow ? 64 : 28;
    const rawCode = `${String(course.code ?? 'CSL')}-${student.roll_no ?? '0'}-${sid.slice(0, 6)}`;
    await fulfill(200, {
      found: true,
      institution_name: ctx.instName,
      course_code: String(course.code ?? 'CSL-101'),
      course_title: String(course.title ?? 'Programming in C Lab'),
      academic_year: String(course.academic_year ?? '2026-27'),
      semester: String(course.semester ?? 'IV'),
      student_name: student.full_name,
      roll_no: student.roll_no ?? '',
      attendance_pct: attPct,
      internal_out_of_100: internalOut,
      final_status: String(course.final_status ?? 'none'),
      verification_code: rawCode.toUpperCase(),
    });
    return true;
  }

  return false;
}

export async function handlePhase5Rest(
  route: Route,
  method: string,
  path: string,
  url: URL,
  isSingle: boolean,
  state: Phase5State,
  phase4State: Phase4State,
  actorId: string | null,
  actorRole: string | null,
): Promise<boolean> {
  const fulfillRows = (rows: Array<Record<string, unknown>>) => {
    const filtered = applyPostgrestFilters(rows, url);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isSingle ? (filtered[0] ?? null) : filtered),
    });
  };

  if (method === 'DELETE' && path.endsWith('/course_flags')) {
    const matching = new Set(
      applyPostgrestFilters(phase4State.courseFlags, url).map((f) => String(f.id ?? '')),
    );
    phase4State.courseFlags = phase4State.courseFlags.filter((f) => !matching.has(f.id));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return true;
  }

  if (method !== 'GET') return false;

  if (path.endsWith('/class_items')) {
    await fulfillRows(state.classItems as unknown as Array<Record<string, unknown>>);
    return true;
  }

  if (path.endsWith('/class_answer_keys')) {
    // Students and unauthenticated callers never see answer keys over the API.
    if (!actorRole || actorRole === 'student') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return true;
    }
    await fulfillRows(state.classAnswerKeys as unknown as Array<Record<string, unknown>>);
    return true;
  }

  if (path.endsWith('/class_responses')) {
    const rows =
      actorRole === 'student' && actorId
        ? state.classResponses.filter((r) => r.student_id === actorId)
        : state.classResponses;
    await fulfillRows(rows as unknown as Array<Record<string, unknown>>);
    return true;
  }

  if (path.endsWith('/course_notes')) {
    const rows = state.courseNotes ? [state.courseNotes] : [];
    await fulfillRows(rows as unknown as Array<Record<string, unknown>>);
    return true;
  }

  if (path.endsWith('/course_snapshots')) {
    await fulfillRows(state.courseSnapshots);
    return true;
  }

  if (path.endsWith('/approvals')) {
    await fulfillRows(state.approvals as unknown as Array<Record<string, unknown>>);
    return true;
  }

  return false;
}
