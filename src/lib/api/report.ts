import { formatDateIst } from '../format';
import {
  coAttainment,
  overall,
  poAttainment,
  type AttainmentLevel,
  type CoAttainmentResult,
  type PoAttainmentRow,
} from '../logic/attainment';
import { attendancePct, internalOutOf100, sessionMarks, type SessionMarksBreakdown } from '../logic/rubric';
import { learners, mean, sd, type ClassifiedLearner } from '../logic/stats';
import { fetchAll, supabase } from '../supabase';
import type {
  AttendanceRow,
  AttendanceState,
  Batch,
  CoPoMapRow,
  Course,
  CourseFlagRow,
  CourseNotesRow,
  CourseOutcome,
  Enrollment,
  Institution,
  Profile,
  QuestionRow,
  SessionQuestionRow,
  SessionRow,
  SessionRunRow,
  SubmissionRow,
  TestAttemptRow,
  VivaRow,
} from '../types';

export interface ApprovalRecord {
  id: string;
  object_type: string;
  object_id: string;
  approver_id: string;
  decision: 'approved' | 'declined' | 'returned';
  remark: string | null;
  content_hash: string;
  at: string;
}

export interface CourseReportDataset {
  course: Course;
  institution: Pick<
    Institution,
    | 'name'
    | 'min_attendance_pct'
    | 'attainment_threshold_pct'
    | 'level_1_pct'
    | 'level_2_pct'
    | 'level_3_pct'
    | 'internal_weight'
    | 'endsem_weight'
  >;
  outcomes: readonly CourseOutcome[];
  coPoMap: readonly CoPoMapRow[];
  batches: readonly Batch[];
  enrollments: readonly Enrollment[];
  students: readonly Profile[];
  sessions: readonly SessionRow[];
  sessionRuns: readonly SessionRunRow[];
  attendance: readonly AttendanceRow[];
  attempts: readonly TestAttemptRow[];
  sessionQuestions: readonly SessionQuestionRow[];
  questions: readonly QuestionRow[];
  submissions: readonly SubmissionRow[];
  vivas: readonly VivaRow[];
  notes: CourseNotesRow | null;
  flags: readonly CourseFlagRow[];
  approvals: readonly ApprovalRecord[];
  /** Optional Phase 7 hook: studentId -> end-sem overall % (0..100). */
  endsemPctByStudent?: ReadonlyMap<string, number>;
  /** Optional Phase 7 hook: studentId -> Map<coId, endsem %>. */
  endsemCoPctByStudent?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export interface StudentSessionDetail {
  session: SessionRow;
  batchId: string | null;
  conducted: boolean;
  attendance: AttendanceState | null;
  preScore: number | null;
  postScore: number | null;
  visPassed: number;
  visTotal: number;
  hidPassed: number;
  hidTotal: number;
  viva: number;
  lastSubmittedAt: string | null;
  breakdown: SessionMarksBreakdown;
}

export interface StudentProgramRecord {
  sessionId: string;
  sessionNumber: number;
  sessionTopic: string;
  questionId: string;
  questionTitle: string;
  submission: SubmissionRow | null;
}

export interface ComputedStudentReportRow {
  student: Profile;
  batch: Batch | null;
  sessions: StudentSessionDetail[];
  programs: StudentProgramRecord[];
  rubricTotals: SessionMarksBreakdown;
  internalPct: number;
  endsemPct: number | null;
  overallPct: number;
  attendancePct: number;
  lastSubmittedAt: string | null;
  coInternal: Map<string, number>;
  coOverall: Map<string, number>;
}

export interface CoReportRow {
  co: CourseOutcome;
  internal: CoAttainmentResult;
  endsem: CoAttainmentResult | null;
  overall: CoAttainmentResult;
  meanPct: number;
  slowCount: number;
  fastCount: number;
  attained: boolean;
}

export interface CourseFileSectionRow {
  n: number;
  title: string;
  status: string;
  ready: boolean;
}

export interface ActualLogRow {
  sessionNumber: number;
  topic: string;
  plannedDate: string | null;
  batchesRun: number;
  status: 'As planned' | 'Partial' | 'In progress' | 'Scheduled';
  remark: string;
}

export interface ComputedCourseReport {
  conductedSessions: SessionRow[];
  rows: ComputedStudentReportRow[];
  coInternal: CoReportRow[];
  coEndsem: CoReportRow[];
  coOverall: CoReportRow[];
  overallAttainment: CoAttainmentResult;
  poRows: PoAttainmentRow[];
  internalMean: number;
  internalSd: number;
  below40Count: number;
  above80Count: number;
  slowLearners: ClassifiedLearner[];
  fastLearners: ClassifiedLearner[];
  manualSlow: CourseFlagRow[];
  manualFast: CourseFlagRow[];
  gaps: string[];
  insights: string[];
  courseFileSections: CourseFileSectionRow[];
  actualLogRows: ActualLogRow[];
  hasEndsem: boolean;
}

export async function loadCourseData(courseId: string): Promise<CourseReportDataset> {
  const { data: course, error: coErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .single<Course>();
  if (coErr || !course) {
    throw new Error(coErr?.message ?? 'not_found');
  }

  const [
    instRes,
    outcomes,
    coPoMap,
    batches,
    enrollments,
    sessions,
    questions,
    submissions,
    notesRes,
    flags,
    approvals,
  ] = await Promise.all([
    supabase
      .from('institutions')
      .select(
        'name, min_attendance_pct, attainment_threshold_pct, level_1_pct, level_2_pct, level_3_pct, internal_weight, endsem_weight',
      )
      .eq('id', course.institution_id)
      .single<CourseReportDataset['institution']>(),
    fetchAll<CourseOutcome>((from, to) =>
      supabase.from('course_outcomes').select('*').eq('course_id', courseId).order('code').range(from, to),
    ),
    fetchAll<CoPoMapRow>((from, to) =>
      supabase.from('co_po_map').select('*').eq('course_id', courseId).range(from, to),
    ),
    fetchAll<Batch>((from, to) =>
      supabase.from('batches').select('*').eq('course_id', courseId).order('name').range(from, to),
    ),
    fetchAll<Enrollment>((from, to) =>
      supabase.from('enrollments').select('*').eq('course_id', courseId).range(from, to),
    ),
    fetchAll<SessionRow>((from, to) =>
      supabase.from('sessions').select('*').eq('course_id', courseId).order('n').range(from, to),
    ),
    fetchAll<QuestionRow>((from, to) =>
      supabase.from('questions').select('*').eq('course_id', courseId).order('created_at').range(from, to),
    ),
    fetchAll<SubmissionRow>((from, to) =>
      supabase
        .from('submissions')
        .select('*')
        .eq('course_id', courseId)
        .eq('context', 'lab')
        .order('created_at', { ascending: false })
        .range(from, to),
    ),
    supabase.from('course_notes').select('*').eq('course_id', courseId).maybeSingle<CourseNotesRow>(),
    fetchAll<CourseFlagRow>((from, to) =>
      supabase.from('course_flags').select('*').eq('course_id', courseId).range(from, to),
    ),
    fetchAll<ApprovalRecord>((from, to) =>
      supabase
        .from('approvals')
        .select('*')
        .eq('object_id', courseId)
        .order('at', { ascending: false })
        .range(from, to),
    ),
  ]);

  const studentIds = Array.from(new Set(enrollments.map((e) => e.student_id)));
  const sessionIds = sessions.map((s) => s.id);

  const [students, sessionRuns, attempts, sessionQuestions, vivas] = await Promise.all([
    studentIds.length > 0
      ? fetchAll<Profile>((from, to) =>
          supabase.from('profiles').select('*').in('id', studentIds).range(from, to),
        )
      : Promise.resolve<Profile[]>([]),
    sessionIds.length > 0
      ? fetchAll<SessionRunRow>((from, to) =>
          supabase.from('session_runs').select('*').in('session_id', sessionIds).range(from, to),
        )
      : Promise.resolve<SessionRunRow[]>([]),
    sessionIds.length > 0
      ? fetchAll<TestAttemptRow>((from, to) =>
          supabase.from('test_attempts').select('*').in('session_id', sessionIds).range(from, to),
        )
      : Promise.resolve<TestAttemptRow[]>([]),
    sessionIds.length > 0
      ? fetchAll<SessionQuestionRow>((from, to) =>
          supabase.from('session_questions').select('*').in('session_id', sessionIds).order('slot').range(from, to),
        )
      : Promise.resolve<SessionQuestionRow[]>([]),
    sessionIds.length > 0
      ? fetchAll<VivaRow>((from, to) =>
          supabase.from('viva').select('*').in('session_id', sessionIds).range(from, to),
        )
      : Promise.resolve<VivaRow[]>([]),
  ]);

  const runIds = sessionRuns.map((r) => r.id);
  const attendance =
    runIds.length > 0
      ? await fetchAll<AttendanceRow>((from, to) =>
          supabase.from('attendance').select('*').in('session_run_id', runIds).range(from, to),
        )
      : [];

  return {
    course,
    institution: instRes.data ?? {
      name: 'Institution',
      min_attendance_pct: 75,
      attainment_threshold_pct: 60,
      level_1_pct: 60,
      level_2_pct: 70,
      level_3_pct: 80,
      internal_weight: 0.4,
      endsem_weight: 0.6,
    },
    outcomes,
    coPoMap,
    batches,
    enrollments,
    students,
    sessions,
    sessionRuns,
    attendance,
    attempts,
    sessionQuestions,
    questions,
    submissions,
    vivas,
    notes: notesRes.data ?? null,
    flags,
    approvals,
  };
}

export function computeReport(data: CourseReportDataset): ComputedCourseReport {
  const { course, institution, outcomes, coPoMap, batches, enrollments } = data;

  const batchMap = new Map(batches.map((b) => [b.id, b]));
  const enrollmentByStudent = new Map(enrollments.map((e) => [e.student_id, e]));
  const questionMap = new Map(data.questions.map((q) => [q.id, q]));

  const runsBySession = new Map<string, SessionRunRow[]>();
  for (const r of data.sessionRuns) {
    const arr = runsBySession.get(r.session_id) ?? [];
    arr.push(r);
    runsBySession.set(r.session_id, arr);
  }

  const conductedSessions = data.sessions.filter(
    (s) => s.status === 'conducted' || (runsBySession.get(s.id) ?? []).some((r) => r.attendance_done),
  );
  const conductedSet = new Set(conductedSessions.map((s) => s.id));

  const attByRunStudent = new Map<string, AttendanceRow>();
  for (const a of data.attendance) {
    if (a.session_run_id) {
      attByRunStudent.set(`${a.session_run_id}:${a.student_id}`, a);
    }
  }

  const attemptsByKey = new Map<string, TestAttemptRow>();
  for (const ta of data.attempts) {
    attemptsByKey.set(`${ta.session_id}:${ta.student_id}:${ta.bank}`, ta);
  }

  const vivaByKey = new Map<string, VivaRow>();
  for (const v of data.vivas) {
    if (v.session_id) {
      vivaByKey.set(`${v.session_id}:${v.student_id}`, v);
    }
  }

  const sqBySession = new Map<string, SessionQuestionRow[]>();
  for (const sq of data.sessionQuestions) {
    const list = sqBySession.get(sq.session_id) ?? [];
    list.push(sq);
    sqBySession.set(sq.session_id, list);
  }

  const subsByStudentQ = new Map<string, SubmissionRow[]>();
  for (const sub of data.submissions) {
    const k = `${sub.student_id}:${sub.question_id}`;
    const list = subsByStudentQ.get(k) ?? [];
    list.push(sub);
    subsByStudentQ.set(k, list);
  }

  const sortedStudents = [...data.students].sort((a, b) =>
    (a.roll_no ?? '').localeCompare(b.roll_no ?? '') || a.full_name.localeCompare(b.full_name),
  );

  const hasEndsem = Boolean(data.endsemPctByStudent && data.endsemPctByStudent.size > 0);
  const wInt = Number(institution.internal_weight || 0.4);
  const wEnd = Number(institution.endsem_weight || 0.6);

  const rows: ComputedStudentReportRow[] = sortedStudents.map((stu) => {
    const enr = enrollmentByStudent.get(stu.id);
    const batch = enr ? (batchMap.get(enr.batch_id) ?? null) : null;

    const programs: StudentProgramRecord[] = [];
    const sessDetails: StudentSessionDetail[] = data.sessions.map((sess) => {
      const sRuns = runsBySession.get(sess.id) ?? [];
      const myRun = (batch ? sRuns.find((r) => r.batch_id === batch.id) : undefined) ?? sRuns[0];
      const attRow = myRun ? attByRunStudent.get(`${myRun.id}:${stu.id}`) : undefined;
      const attState: AttendanceState | null = attRow?.state ?? null;
      const isConducted = conductedSet.has(sess.id);

      const preAtt = attemptsByKey.get(`${sess.id}:${stu.id}:pre`);
      const postAtt = attemptsByKey.get(`${sess.id}:${stu.id}:post`);
      const preScore = preAtt?.submitted_at ? (preAtt.score ?? 0) : null;
      const postScore = postAtt?.submitted_at ? (postAtt.score ?? 0) : null;

      const sQs = [...(sqBySession.get(sess.id) ?? [])].sort((a, b) => a.slot - b.slot);
      let visPassed = 0;
      let visTotal = 0;
      let hidPassed = 0;
      let hidTotal = 0;
      let lastSessSub: string | null = null;

      const qInputs = sQs.map((sq) => {
        const mySubs = subsByStudentQ.get(`${stu.id}:${sq.question_id}`) ?? [];
        const sortedByRecent = [...mySubs].sort((a, b) => b.created_at.localeCompare(a.created_at));
        const bestSubmit =
          sortedByRecent.find((x) => x.mode === 'submit' && x.hidden_total > 0 && x.hidden_passed >= x.hidden_total) ??
          sortedByRecent.find((x) => x.mode === 'submit') ??
          sortedByRecent[0] ??
          null;

        const qTitle = questionMap.get(sq.question_id)?.title ?? `Question ${sq.slot}`;
        if (isConducted || bestSubmit) {
          programs.push({
            sessionId: sess.id,
            sessionNumber: sess.n,
            sessionTopic: sess.topic,
            questionId: sq.question_id,
            questionTitle: qTitle,
            submission: bestSubmit,
          });
        }
        if (bestSubmit && (!lastSessSub || bestSubmit.created_at > lastSessSub)) {
          lastSessSub = bestSubmit.created_at;
        }

        const vp = Math.max(0, ...mySubs.map((x) => x.visible_passed));
        const vt = Math.max(2, ...mySubs.map((x) => x.visible_total));
        const hp = Math.max(0, ...mySubs.map((x) => x.hidden_passed));
        const ht = Math.max(3, ...mySubs.map((x) => x.hidden_total));
        visPassed += vp;
        visTotal += vt;
        hidPassed += hp;
        hidTotal += ht;
        return { visPassed: vp, visTotal: vt, hidPassed: hp, hidTotal: ht };
      });

      const vivaRow = vivaByKey.get(`${sess.id}:${stu.id}`);
      const vivaMarks = Number(vivaRow?.marks ?? 0);

      const breakdown = sessionMarks(
        {
          attendance: attState,
          preCorrect: preScore ?? 0,
          postCorrect: postScore ?? 0,
          questions: qInputs,
          viva: vivaMarks,
        },
        course.rubric,
      );

      return {
        session: sess,
        batchId: myRun?.batch_id ?? batch?.id ?? null,
        conducted: isConducted,
        attendance: attState,
        preScore,
        postScore,
        visPassed,
        visTotal,
        hidPassed,
        hidTotal,
        viva: breakdown.viva,
        lastSubmittedAt: lastSessSub,
        breakdown,
      };
    });

    const conductedDetails = sessDetails.filter((d) => d.conducted);
    const countedAttStates = conductedDetails
      .map((d) => d.attendance)
      .filter((st): st is AttendanceState => st !== null);

    const sumPart = (pick: (b: SessionMarksBreakdown) => number) =>
      Math.round(conductedDetails.reduce((acc, d) => acc + pick(d.breakdown), 0) * 100) / 100;

    const rubricTotals: SessionMarksBreakdown = {
      att: sumPart((b) => b.att),
      pre: sumPart((b) => b.pre),
      post: sumPart((b) => b.post),
      vis: sumPart((b) => b.vis),
      hid: sumPart((b) => b.hid),
      viva: sumPart((b) => b.viva),
      total: sumPart((b) => b.total),
      outOf: conductedDetails.reduce((acc, d) => acc + d.breakdown.outOf, 0),
    };

    const internalPct = internalOutOf100(conductedDetails.map((d) => d.breakdown.total));
    const endsemRaw = data.endsemPctByStudent?.get(stu.id);
    const endsemPct = endsemRaw === undefined ? null : Math.round(endsemRaw * 10) / 10;
    const overallPct =
      endsemPct !== null ? overall(internalPct, endsemPct, wInt, wEnd) : internalPct;

    const coInternal = new Map<string, number>();
    const coOverall = new Map<string, number>();
    for (const co of outcomes) {
      const coSess = conductedDetails.filter((d) => d.session.co_id === co.id);
      const coIntScore =
        coSess.length > 0
          ? internalOutOf100(coSess.map((d) => d.breakdown.total))
          : internalPct;
      coInternal.set(co.id, coIntScore);

      const endCoRaw = data.endsemCoPctByStudent?.get(stu.id)?.get(co.id);
      const coOver =
        endCoRaw !== undefined ? overall(coIntScore, endCoRaw, wInt, wEnd) : coIntScore;
      coOverall.set(co.id, coOver);
    }

    const lastSub = programs
      .map((p) => p.submission?.created_at ?? null)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null;

    return {
      student: stu,
      batch,
      sessions: sessDetails,
      programs,
      rubricTotals,
      internalPct,
      endsemPct,
      overallPct,
      attendancePct: attendancePct(countedAttStates),
      lastSubmittedAt: lastSub,
      coInternal,
      coOverall,
    };
  });

  const thr = institution.attainment_threshold_pct;
  const l1 = institution.level_1_pct;
  const l2 = institution.level_2_pct;
  const l3 = institution.level_3_pct;

  const buildCoSummary = (useOverallMap: boolean): CoReportRow[] =>
    outcomes.map((co) => {
      const vals = rows.map((r) => (useOverallMap ? r.coOverall.get(co.id) : r.coInternal.get(co.id)) ?? 0);
      const att = coAttainment(vals, thr, l1, l2, l3);
      return {
        co,
        internal: att,
        endsem: null,
        overall: att,
        meanPct: Math.round(mean(vals) * 10) / 10,
        slowCount: vals.filter((v) => v < 40).length,
        fastCount: vals.filter((v) => v >= 80).length,
        attained: att.level > 0,
      };
    });

  const coInternal = buildCoSummary(false);
  const coOverall = buildCoSummary(true);
  const coEndsem: CoReportRow[] = hasEndsem
    ? outcomes.map((co) => {
        const vals = rows
          .map((r) => data.endsemCoPctByStudent?.get(r.student.id)?.get(co.id))
          .filter((v): v is number => v !== undefined);
        const att = coAttainment(vals, thr, l1, l2, l3);
        return {
          co,
          internal: att,
          endsem: att,
          overall: att,
          meanPct: Math.round(mean(vals) * 10) / 10,
          slowCount: vals.filter((v) => v < 40).length,
          fastCount: vals.filter((v) => v >= 80).length,
          attained: att.level > 0,
        };
      })
    : [];

  const overallScores = rows.map((r) => r.overallPct);
  const overallAttainment = coAttainment(overallScores, thr, l1, l2, l3);
  const poRows = poAttainment(
    coOverall.map((c) => ({ coId: c.co.id, level: c.overall.level as AttainmentLevel })),
    coPoMap,
  );

  const internalScores = rows.map((r) => r.internalPct);
  const internalMean = Math.round(mean(internalScores) * 10) / 10;
  const internalSd = Math.round(sd(internalScores) * 10) / 10;
  const below40Count = overallScores.filter((v) => v < 40).length;
  const above80Count = overallScores.filter((v) => v >= 80).length;

  const classified = learners(
    rows.map((r) => ({
      studentId: r.student.id,
      rollNo: r.student.roll_no ?? '',
      fullName: r.student.full_name,
      overallPct: r.overallPct,
    })),
  );

  const manualSlow = data.flags.filter((f) => f.kind === 'slow');
  const manualFast = data.flags.filter((f) => f.kind === 'fast');

  const gaps: string[] = [];
  for (const row of coInternal) {
    if (!row.attained) {
      gaps.push(
        `${row.co.code}: ${row.internal.pct}% attained (below ${l1}% rule); ${row.slowCount} below 40%.`,
      );
    }
  }
  if (gaps.length === 0) {
    gaps.push('No CO falls below the institution attainment rule.');
  }

  const insights: string[] = [];
  if (coInternal.length > 0 && rows.length > 0) {
    const sortedCos = [...coInternal].sort((a, b) => b.meanPct - a.meanPct);
    const strongest = sortedCos[0]!;
    const weakest = sortedCos[sortedCos.length - 1]!;
    insights.push(`Strongest ${strongest.co.code} (mean ${strongest.meanPct}%); weakest ${weakest.co.code} (mean ${weakest.meanPct}%).`);
  }
  if (below40Count > 0) {
    insights.push(`${below40Count} student(s) currently below 40% need guided remedial lab practice.`);
  }
  if (above80Count > 0) {
    insights.push(`${above80Count} student(s) scoring 80% and above can be assigned open-ended extension exercises.`);
  }
  if (insights.length === 0) {
    insights.push('Conducted sessions will populate automated cohort insights here.');
  }

  const toDateTag =
    conductedSessions.length > 0 ? `To date (S1–S${conductedSessions.length})` : 'Pending runs';
  const planApproved = course.plan_status === 'approved';
  const activeCount = data.sessions.filter((s) => s.status === 'active' || s.status === 'conducted').length;

  const courseFileSections: CourseFileSectionRow[] = [
    { n: 1, title: 'Course details', status: 'Ready', ready: true },
    { n: 2, title: 'CO–PO/PSO mapping', status: coPoMap.length > 0 ? 'Ready' : 'Add text', ready: coPoMap.length > 0 },
    { n: 3, title: 'Session plan', status: data.sessions.length > 0 ? 'Ready' : 'Add dates', ready: data.sessions.length > 0 },
    { n: 4, title: 'Actual log: planned vs. conducted, with remarks', status: conductedSessions.length > 0 ? toDateTag : 'Pending', ready: conductedSessions.length > 0 },
    { n: 5, title: 'Marking rubric', status: planApproved ? 'HOD-approved' : 'Pending HOD', ready: planApproved },
    { n: 6, title: 'Lab questions', status: activeCount > 0 ? `${activeCount} session(s) ready` : 'Pending', ready: activeCount > 0 },
    { n: 7, title: 'Mark list per rubric', status: conductedSessions.length > 0 ? toDateTag : 'Pending', ready: conductedSessions.length > 0 },
    { n: 8, title: 'Internal CO attainment', status: conductedSessions.length > 0 ? toDateTag : 'Pending', ready: conductedSessions.length > 0 },
    { n: 9, title: 'Internal summary', status: data.notes?.internal_summary ? 'Ready' : 'Add text', ready: Boolean(data.notes?.internal_summary) },
    { n: 10, title: 'BoS suggestions', status: data.notes?.bos_suggestions ? 'Ready' : 'Add text', ready: Boolean(data.notes?.bos_suggestions) },
    { n: 11, title: 'End-sem questions', status: hasEndsem ? 'Ready' : 'After end-sem', ready: hasEndsem },
    { n: 12, title: 'End-sem mark sheet', status: hasEndsem ? 'Ready' : 'After end-sem', ready: hasEndsem },
    { n: 13, title: 'Overall attainment (internal + end-sem)', status: hasEndsem ? 'Ready' : 'After end-sem', ready: hasEndsem },
    { n: 14, title: 'Overall summary', status: data.notes?.overall_summary ? 'Ready' : 'After end-sem', ready: Boolean(data.notes?.overall_summary) },
  ];

  const actualLogRows: ActualLogRow[] = data.sessions.map((s) => {
    const sRuns = runsBySession.get(s.id) ?? [];
    const doneRuns = sRuns.filter((r) => r.ended_at);
    const attRuns = sRuns.filter((r) => r.attendance_done);
    const remarks = sRuns.map((r) => r.remark.trim()).filter(Boolean).join('; ');
    const status: ActualLogRow['status'] =
      doneRuns.length > 0 && doneRuns.length >= Math.max(1, batches.length)
        ? 'As planned'
        : doneRuns.length > 0
          ? 'Partial'
          : attRuns.length > 0
            ? 'In progress'
            : 'Scheduled';
    return {
      sessionNumber: s.n,
      topic: s.topic,
      plannedDate: s.scheduled_date ? formatDateIst(s.scheduled_date) : null,
      batchesRun: doneRuns.length || attRuns.length,
      status,
      remark: remarks || '—',
    };
  });

  return {
    conductedSessions,
    rows,
    coInternal,
    coEndsem,
    coOverall,
    overallAttainment,
    poRows,
    internalMean,
    internalSd,
    below40Count,
    above80Count,
    slowLearners: classified.slow,
    fastLearners: classified.fast,
    manualSlow,
    manualFast,
    gaps,
    insights,
    courseFileSections,
    actualLogRows,
    hasEndsem,
  };
}
