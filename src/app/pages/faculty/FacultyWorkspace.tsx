import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banner, ErrorNote, Loading } from '../../../components/ui';
import { Workbench } from '../../../components/Workbench';
import { useLoad } from '../../../lib/hooks';
import type { FacultyStepId } from '../../../lib/logic/ask';
import { rubricSum } from '../../../lib/logic/checks';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  AiUsageSummary,
  BankItemRow,
  Batch,
  CoPoMapRow,
  Course,
  CourseOutcome,
  Enrollment,
  HolidayRow,
  PendingEnrollment,
  Profile,
  QuestionRow,
  ReferenceSolutionRow,
  SessionQuestionRow,
  SessionRow,
  SessionRunRow,
  TestCaseRow,
} from '../../../lib/types';
import { BatchesStep } from './BatchesStep';
import { ClassroomStep } from './ClassroomStep';
import { CourseSetupStep } from './CourseSetupStep';
import { FacultyShell } from './FacultyShell';
import { LabQuestionsStep } from './LabQuestionsStep';
import { ReportsStep } from './ReportsStep';
import { AssessmentsStep } from './AssessmentsStep';
import { SessionPlanStep } from './SessionPlanStep';
import { SessionsStep } from './SessionsStep';
import { TestBanksStep } from './TestBanksStep';

const VALID_STEPS: readonly FacultyStepId[] = [
  'setup',
  'batches',
  'plan',
  'questions',
  'banks',
  'sessions',
  'classroom',
  'assessments',
  'reports',
];

export function FacultyWorkspace() {
  const { courseId, step: rawStep } = useParams<{ courseId: string; step?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { profile, institution, signOut } = useSession();
  const isPreviewRoute = rawStep === 'preview';
  const activeStep: FacultyStepId = VALID_STEPS.includes(rawStep as FacultyStepId)
    ? (rawStep as FacultyStepId)
    : 'setup';

  const initialSessionNum = searchParams.get('s') ? Number(searchParams.get('s')) : null;
  const initialInspectRoll = searchParams.get('roll');

  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const { data, loading, error, reload } = useLoad(async () => {
    if (!courseId) throw new Error('not_found');

    const [
      courseRes,
      outcomes,
      coPoMap,
      batches,
      enrollments,
      pendingEnrollments,
      sessions,
      holidays,
      studentProfiles,
      usageRows,
      questionsList,
    ] = await Promise.all([
      supabase.from('courses').select('*').eq('id', courseId).single<Course>(),
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
      fetchAll<PendingEnrollment>((from, to) =>
        supabase
          .from('pending_enrollments')
          .select('*')
          .eq('course_id', courseId)
          .order('roll_no')
          .range(from, to),
      ),
      fetchAll<SessionRow>((from, to) =>
        supabase.from('sessions').select('*').eq('course_id', courseId).order('n').range(from, to),
      ),
      fetchAll<HolidayRow>((from, to) =>
        supabase.from('holidays').select('*').order('day').range(from, to),
      ),
      fetchAll<Profile>((from, to) =>
        supabase.from('profiles').select('*').eq('role', 'student').range(from, to),
      ),
      rpc<AiUsageSummary[]>('ai_usage'),
      fetchAll<QuestionRow>((from, to) =>
        supabase.from('questions').select('*').eq('course_id', courseId).order('created_at').range(from, to),
      ),
    ]);

    if (courseRes.error || !courseRes.data) {
      throw new Error(courseRes.error?.message ?? 'not_found');
    }

    const qIds = (questionsList ?? []).map((q) => q.id);
    const sIds = (sessions ?? []).map((s) => s.id);

    const [testCases, references, sessionQuestions, bankItems, sessionRuns, deptCalRes] = await Promise.all([
      qIds.length > 0
        ? fetchAll<TestCaseRow>((from, to) =>
            supabase.from('test_cases').select('*').in('question_id', qIds).order('ord').range(from, to),
          )
        : Promise.resolve<TestCaseRow[]>([]),
      qIds.length > 0
        ? fetchAll<ReferenceSolutionRow>((from, to) =>
            supabase.from('reference_solutions').select('*').in('question_id', qIds).range(from, to),
          )
        : Promise.resolve<ReferenceSolutionRow[]>([]),
      sIds.length > 0
        ? fetchAll<SessionQuestionRow>((from, to) =>
            supabase.from('session_questions').select('*').in('session_id', sIds).range(from, to),
          )
        : Promise.resolve<SessionQuestionRow[]>([]),
      sIds.length > 0
        ? fetchAll<BankItemRow>((from, to) =>
            supabase.from('bank_items').select('*').in('session_id', sIds).order('created_at').range(from, to),
          )
        : Promise.resolve<BankItemRow[]>([]),
      sIds.length > 0
        ? fetchAll<SessionRunRow>((from, to) =>
            supabase.from('session_runs').select('*').in('session_id', sIds).range(from, to),
          )
        : Promise.resolve<SessionRunRow[]>([]),
      courseRes.data.department_id
        ? supabase
            .from('academic_calendars')
            .select('id, first_working_day, last_working_day, expected_endsem_date, saturday_rule, approved')
            .eq('department_id', courseRes.data.department_id)
            .eq('approved', true)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    let departmentCalendar: {
      first_working_day: string;
      last_working_day: string;
      expected_endsem_date: string | null;
      saturday_rule: 'all' | 'odd' | 'even' | 'none';
      events: Array<{ day: string; kind: string; label: string }>;
    } | null = null;
    if (!deptCalRes.error && deptCalRes.data) {
      const cal = deptCalRes.data as {
        id: string;
        first_working_day: string;
        last_working_day: string;
        expected_endsem_date: string | null;
        saturday_rule: 'all' | 'odd' | 'even' | 'none';
      };
      const { data: evRows } = await supabase
        .from('academic_calendar_events')
        .select('day, kind, event_type, label, no_attendance')
        .eq('calendar_id', cal.id)
        .order('day');
      departmentCalendar = {
        ...cal,
        events: ((evRows ?? []) as Array<{ day: string; kind: string; label: string }>),
      };
    }

    return {
      course: courseRes.data,
      outcomes,
      coPoMap,
      batches,
      enrollments,
      pendingEnrollments,
      sessions,
      holidays,
      studentProfiles,
      aiUsage: usageRows?.[0] ?? null,
      questions: questionsList,
      testCases,
      references,
      sessionQuestions,
      bankItems,
      sessionRuns,
      departmentCalendar,
    };
  }, [courseId]);

  if (loading && !data) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Loading course workspace…" />
      </main>
    );
  }

  if (error || !data) {
    return (
      <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
        <ErrorNote message={error ?? 'Course not found.'} />
      </main>
    );
  }

  const totalRubric = rubricSum(data.course.rubric);
  const hasConducted = data.sessions.some((s) => s.status === 'conducted');
  const pickedSessionsCount = data.sessions.filter(
    (s) => data.sessionQuestions.filter((sq) => sq.session_id === s.id).length === 2,
  ).length;
  const banksReadySessionsCount = data.sessions.filter((s) => {
    const items = data.bankItems.filter((b) => b.session_id === s.id);
    const has45 = (bank: 'pre' | 'post') => {
      const sub = items.filter((b) => b.bank === bank && b.approved);
      return (
        sub.length === 45 &&
        sub.filter((b) => b.level === 'easy').length === 15 &&
        sub.filter((b) => b.level === 'medium').length === 15 &&
        sub.filter((b) => b.level === 'hard').length === 15
      );
    };
    return has45('pre') && has45('post');
  }).length;

  if (isPreviewRoute) {
    const previewSession =
      data.sessions.find((s) => s.status === 'active' || s.status === 'conducted') ?? data.sessions[0];
    const pickedIds = previewSession
      ? data.sessionQuestions
          .filter((sq) => sq.session_id === previewSession.id)
          .sort((a, b) => a.slot - b.slot)
          .map((sq) => sq.question_id)
      : [];
    const workbenchQs = pickedIds
      .map((qid) => {
        const q = data.questions.find((x) => x.id === qid);
        if (!q) return null;
        const allTcs = data.testCases.filter((t) => t.question_id === q.id);
        return {
          question: q,
          visibleTests: allTcs.filter((t) => !t.hidden),
          hiddenCount: allTcs.filter((t) => t.hidden).length || 3,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return (
      <Workbench
        mode="preview"
        title={previewSession ? `Lab · S${previewSession.n} ${previewSession.topic}` : data.course.code}
        allowedLangs={data.course.allowed_langs}
        questions={workbenchQs}
        initialDrafts={new Map()}
        initialSubmissions={[]}
        onExit={() => navigate(`/faculty/c/${data.course.id}/sessions`)}
      />
    );
  }

  return (
    <FacultyShell
      course={data.course}
      activeStep={activeStep}
      coCount={data.outcomes.length}
      rubricTotal={totalRubric}
      batches={data.batches}
      sessions={data.sessions}
      pickedSessionsCount={pickedSessionsCount}
      banksReadySessionsCount={banksReadySessionsCount}
      aiUsage={data.aiUsage}
      facultyName={profile?.full_name ?? ''}
      isHod={profile?.role === 'hod'}
      onSignOut={() => void signOut()}
    >
      {notice ? <Banner tone={notice.ok ? 'ok' : 'err'}>{notice.text}</Banner> : null}

      {activeStep === 'setup' ? (
        <CourseSetupStep
          course={data.course}
          outcomes={data.outcomes}
          coPoMap={data.coPoMap}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'batches' ? (
        <BatchesStep
          course={data.course}
          institutionDomain={institution?.email_domain ?? 'sanjivani.edu.in'}
          batches={data.batches}
          enrollments={data.enrollments}
          pendingEnrollments={data.pendingEnrollments}
          studentProfiles={data.studentProfiles}
          hasConductedSession={hasConducted}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'plan' ? (
        <SessionPlanStep
          course={data.course}
          outcomes={data.outcomes}
          sessions={data.sessions}
          institutionHolidays={data.holidays}
          departmentCalendar={data.departmentCalendar}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'questions' ? (
        <LabQuestionsStep
          course={data.course}
          outcomes={data.outcomes}
          sessions={data.sessions}
          questions={data.questions}
          testCases={data.testCases}
          references={data.references}
          sessionQuestions={data.sessionQuestions}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'banks' ? (
        <TestBanksStep
          course={data.course}
          sessions={data.sessions}
          bankItems={data.bankItems}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'sessions' ? (
        <SessionsStep
          course={data.course}
          batches={data.batches}
          sessions={data.sessions}
          sessionRuns={data.sessionRuns}
          enrollments={data.enrollments}
          studentProfiles={data.studentProfiles}
          sessionQuestions={data.sessionQuestions}
          initialSessionNumber={initialSessionNum}
          initialInspectRoll={initialInspectRoll}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'classroom' ? (
        <ClassroomStep
          course={data.course}
          batches={data.batches}
          sessions={data.sessions}
          enrollments={data.enrollments}
          pendingEnrollments={data.pendingEnrollments}
          studentProfiles={data.studentProfiles}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'reports' ? (
        <ReportsStep
          course={data.course}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}

      {activeStep === 'assessments' ? (
        <AssessmentsStep
          course={data.course}
          outcomes={data.outcomes}
          batches={data.batches}
          enrollments={data.enrollments}
          studentProfiles={data.studentProfiles}
          onNotify={(text, ok) => setNotice({ text, ok })}
          onRefresh={reload}
        />
      ) : null}
    </FacultyShell>
  );
}

export default FacultyWorkspace;
