import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarLinkCard } from '../../../components/CalendarLinkCard';
import { HierarchyMeetingsCard } from '../../components/HierarchyMeetingsCard';
import { InteractiveAcademicCalendar, type CalendarOverlayEvent } from '../../components/InteractiveAcademicCalendar';
import { Banner, Card, Chip, Empty, ErrorNote, Loading, Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, formatDateTimeIst, todayIso } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import { attendancePct, internalOutOf100, sessionMarks } from '../../../lib/logic/rubric';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  AttendanceRow,
  Batch,
  Course,
  Enrollment,
  SessionQuestionRow,
  SessionRow,
  SessionRunRow,
  SubmissionRow,
  TestAttemptRow,
  VivaRow,
} from '../../../lib/types';
import { StudentShell } from './StudentShell';

export function StudentHomePage() {
  const { profile } = useSession();
  const navigate = useNavigate();
  const [classCode, setClassCode] = useState('');
  const [liveTestCode, setLiveTestCode] = useState('');
  const [joinMsg, setJoinMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyJoin, setBusyJoin] = useState(false);
  const [busyLiveTestJoin, setBusyLiveTestJoin] = useState(false);
  const [launchingTestId, setLaunchingTestId] = useState<string | null>(null);
  const [requestMeetingOpen, setRequestMeetingOpen] = useState(false);
  const [facultyContacts, setFacultyContacts] = useState<
    Array<{ id: string; full_name: string; email: string; role: string; relation: string }>
  >([]);
  const [selectedFacultyId, setSelectedFacultyId] = useState('');

  async function openRequestMeetingModal() {
    setRequestMeetingOpen(true);
    let list: Array<{ id: string; full_name: string; email: string; role: string; relation: string }>;
    try {
      const rows = await rpc<
        Array<{ id: string; full_name: string; email: string; role: string; relation: string }>
      >('list_hierarchy_contacts', {});
      list = (rows ?? []).filter((c) => c.relation === 'superior' || c.role === 'faculty');
    } catch {
      list = [];
    }
    if (list.length === 0) {
      try {
        const fallback = await rpc<
          Array<{ id: string; full_name: string; email: string; role: string; relation: string }>
        >('student_list_course_faculty', {});
        list = fallback ?? [];
      } catch {
        list = [];
      }
    }
    setFacultyContacts(list);
    if (list.length > 0 && !list.some((c) => c.id === selectedFacultyId)) {
      setSelectedFacultyId(list[0]!.id);
    }
  }

  const { data, loading, error, reload } = useLoad(async () => {
    const uid = profile?.id ?? '';
    const enrollments = await fetchAll<Enrollment>((from, to) =>
      supabase.from('enrollments').select('*').eq('student_id', uid).range(from, to),
    );
    const courseIds = Array.from(new Set(enrollments.map((e) => e.course_id)));
    const batchIds = Array.from(new Set(enrollments.map((e) => e.batch_id)));

    const [
      [courses, batches, sessions, submissions, attempts, attendance, vivas, classTasks],
      instantTests,
      classJoinRequests,
    ] = await Promise.all([
      courseIds.length > 0
        ? Promise.all([
            fetchAll<Course>((from, to) =>
              supabase.from('courses').select('*').in('id', courseIds).range(from, to),
            ),
            fetchAll<Batch>((from, to) =>
              supabase.from('batches').select('*').in('id', batchIds).range(from, to),
            ),
            fetchAll<SessionRow>((from, to) =>
              supabase.from('sessions').select('*').in('course_id', courseIds).order('n').range(from, to),
            ),
            fetchAll<SubmissionRow>((from, to) =>
              supabase.from('submissions').select('*').eq('student_id', uid).range(from, to),
            ),
            fetchAll<TestAttemptRow>((from, to) =>
              supabase.from('test_attempts').select('*').eq('student_id', uid).range(from, to),
            ),
            fetchAll<AttendanceRow>((from, to) =>
              supabase.from('attendance').select('*').eq('student_id', uid).range(from, to),
            ),
            fetchAll<VivaRow>((from, to) =>
              supabase.from('viva').select('*').eq('student_id', uid).range(from, to),
            ),
            fetchAll<{ id: string; course_id: string; title: string; due_at: string | null; kind: string }>((from, to) =>
              supabase
                .from('class_items')
                .select('id, course_id, title, due_at, kind')
                .in('course_id', courseIds)
                .not('due_at', 'is', null)
                .order('due_at')
                .range(from, to),
            ).catch(() => []),
          ])
        : Promise.resolve([[], [], [], [], [], [], [], []] as [
            Course[],
            Batch[],
            SessionRow[],
            SubmissionRow[],
            TestAttemptRow[],
            AttendanceRow[],
            VivaRow[],
            Array<{ id: string; course_id: string; title: string; due_at: string | null; kind: string }>,
          ]),
      rpc<
        Array<{
          test_id: string;
          course_id: string;
          course_code: string;
          course_title: string;
          test_code: string;
          topic: string;
          total_marks: number;
          pretest_count: number;
          viva_marks: number;
          status: string;
          active: boolean;
          scheduled_at: string | null;
          attendance_status: string;
          approval_status?: 'pending' | 'approved' | 'rejected';
          attempt_id: string | null;
          submitted_at: string | null;
          final_score: number | null;
          marks_approved: boolean;
        }>
      >('student_list_instant_tests').catch(() => []),
      rpc<
        Array<{
          id: string;
          course_id: string;
          course_code: string;
          course_title: string;
          batch_name: string;
          class_code: string;
          status: 'pending' | 'approved' | 'rejected';
          requested_at: string;
        }>
      >('student_list_class_join_requests').catch(() => []),
    ]);

    const sessionIds = sessions.map((s) => s.id);
    const [sessionQuestions, sessionRuns] =
      sessionIds.length > 0
        ? await Promise.all([
            fetchAll<SessionQuestionRow>((from, to) =>
              supabase.from('session_questions').select('*').in('session_id', sessionIds).range(from, to),
            ),
            fetchAll<SessionRunRow>((from, to) =>
              supabase.from('session_runs').select('*').in('session_id', sessionIds).range(from, to),
            ),
          ])
        : [[], []];

    return {
      enrollments,
      courses,
      batches,
      sessions,
      submissions,
      attempts,
      attendance,
      vivas,
      classTasks,
      instantTests,
      classJoinRequests,
      sessionQuestions,
      sessionRuns,
    };
  }, [profile?.id]);

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    setJoinMsg(null);
    setBusyJoin(true);
    try {
      const res = await rpc<{ status: string; batch_name?: string; course_code?: string }>('student_request_join_class', {
        p_code: classCode.trim(),
      });
      setClassCode('');
      setJoinMsg({
        text:
          res.status === 'already_enrolled'
            ? 'You are already enrolled in this course.'
            : `Join request sent for ${res.course_code ?? 'course'} (${res.batch_name ?? 'batch'}). Waiting for faculty approval.`,
        ok: true,
      });
      reload();
    } catch (err) {
      setJoinMsg({ text: errorMessage(err), ok: false });
    } finally {
      setBusyJoin(false);
    }
  }

  async function handleJoinLiveTest(e: FormEvent) {
    e.preventDefault();
    if (!liveTestCode.trim()) return;
    setJoinMsg(null);
    setBusyLiveTestJoin(true);
    try {
      const res = await rpc<{ status: string; attempt_id?: string; topic?: string }>(
        'student_request_join_instant_test',
        {
          p_code: liveTestCode.trim().toUpperCase(),
        },
      );
      setLiveTestCode('');
      if (res.status === 'approved' && res.attempt_id) {
        navigate(`/student/instant-test/${res.attempt_id}`);
        return;
      }
      setJoinMsg({
        text:
          res.status === 'approved_waiting_start'
            ? `You are approved for "${res.topic ?? 'test'}". Waiting for faculty to activate the test.`
            : `Join request sent for "${res.topic ?? 'live test'}". Faculty must approve before you can enter and appear in reports.`,
        ok: true,
      });
      reload();
    } catch (err) {
      setJoinMsg({ text: errorMessage(err), ok: false });
    } finally {
      setBusyLiveTestJoin(false);
    }
  }

  const today = todayIso();
  const activeSessions = (data?.sessions ?? []).filter(
    (s) => s.status === 'active' || s.status === 'conducted',
  );
  const todaySession =
    activeSessions.find((s) => s.scheduled_date === today) ?? activeSessions[0] ?? null;

  const todayCourse = todaySession
    ? (data?.courses ?? []).find((c) => c.id === todaySession.course_id) ?? null
    : null;
  const todayEnrollment = todayCourse
    ? (data?.enrollments ?? []).find((e) => e.course_id === todayCourse.id)
    : undefined;
  const todayBatch = todayEnrollment
    ? (data?.batches ?? []).find((b) => b.id === todayEnrollment.batch_id) ?? null
    : null;

  const todayPre = todaySession
    ? (data?.attempts ?? []).find((a) => a.session_id === todaySession.id && a.bank === 'pre')
    : undefined;
  const todayPost = todaySession
    ? (data?.attempts ?? []).find((a) => a.session_id === todaySession.id && a.bank === 'post')
    : undefined;
  const todayRun =
    todaySession && todayBatch
      ? (data?.sessionRuns ?? []).find(
          (r) => r.session_id === todaySession.id && r.batch_id === todayBatch.id,
        )
      : undefined;

  const todayPickedQs = todaySession
    ? (data?.sessionQuestions ?? []).filter((sq) => sq.session_id === todaySession.id)
    : [];
  const todayAllHiddenPassed =
    todayPickedQs.length >= 2 &&
    todayPickedQs.every((sq) =>
      (data?.submissions ?? []).some(
        (sub) =>
          sub.question_id === sq.question_id &&
          sub.mode === 'submit' &&
          sub.hidden_total > 0 &&
          sub.hidden_passed >= sub.hidden_total,
      ),
    );

  // Build simple current/anchor month grid
  const anchorIso = todaySession?.scheduled_date ?? today;
  const anchorDate = new Date(`${anchorIso}T00:00:00Z`);
  const monthLabel = new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(anchorDate);

  const courseById = new Map((data?.courses ?? []).map((c) => [c.id, c]));
  const labCalendarEvents: CalendarOverlayEvent[] = (data?.sessions ?? [])
    .filter((s) => Boolean(s.scheduled_date))
    .map((s) => {
      const co = courseById.get(s.course_id);
      return {
        day: s.scheduled_date!,
        kind: 'academic_event',
        event_type: 'Lab',
        label: `${co?.code ?? 'Lab'} S${s.n}: ${s.topic}`,
      };
    });

  return (
    <StudentShell
      activeTab="home"
      hasTodayLab={Boolean(todaySession)}
      todaySessionId={todaySession?.id ?? null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div className="page-kicker">STUDENT WORKSPACE</div>
            <h1 className="page-title">Home · {monthLabel}</h1>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <button
              type="button"
              className="btn"
              onClick={() => void openRequestMeetingModal()}
            >
              Request meeting with faculty
            </button>
            <form onSubmit={handleJoin} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
              <label className="field-label">
                Join class using code
                <input
                  className="field mono"
                  required
                  value={classCode}
                  onChange={(e) => setClassCode(e.target.value)}
                  placeholder="e.g. CS7Q4K"
                  style={{ width: 150 }}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busyJoin}>
                {busyJoin ? 'Sending…' : 'Request join'}
              </button>
            </form>
            <form onSubmit={handleJoinLiveTest} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
              <label className="field-label">
                Join live test using code
                <input
                  className="field mono"
                  required
                  value={liveTestCode}
                  onChange={(e) => setLiveTestCode(e.target.value.toUpperCase())}
                  placeholder="e.g. K7P9M2"
                  style={{ width: 150 }}
                />
              </label>
              <button type="submit" className="btn btn-teal" disabled={busyLiveTestJoin}>
                {busyLiveTestJoin ? 'Sending…' : 'Request test'}
              </button>
            </form>
          </div>
        </div>

        {joinMsg ? <Banner tone={joinMsg.ok ? 'ok' : 'err'}>{joinMsg.text}</Banner> : null}
        {data && data.classJoinRequests.some((r) => r.status === 'pending') ? (
          <Card title="Pending class join requests">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.classJoinRequests
                .filter((r) => r.status === 'pending')
                .map((r) => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                    <span>
                      <strong>{r.course_code}</strong> · {r.course_title} ({r.batch_name}, code <span className="mono">{r.class_code}</span>)
                    </span>
                    <Chip tone="warn">Pending faculty approval</Chip>
                  </div>
                ))}
            </div>
          </Card>
        ) : null}
        {error ? <ErrorNote message={error} /> : null}
        {loading && !data ? <Loading label="Loading student courses…" /> : null}

        {data ? (() => {
          const liveInstantTests = data.instantTests.filter(
            (t) => (t.status === 'active' && t.active) || t.status === 'scheduled' || t.approval_status === 'pending',
          );
          if (liveInstantTests.length === 0 && activeSessions.length === 0 && data.classTasks.length === 0) return null;
          return (
          <Card title="Assessment & submission notifications">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {liveInstantTests.map((t) => {
                const isLive = t.status === 'active' && t.active;
                const approval = t.approval_status ?? 'approved';
                const attendancePresent = t.attendance_status === 'present';
                const canEnter = approval === 'approved' && isLive && attendancePresent;
                return (
                  <button
                    key={t.test_id}
                    type="button"
                    disabled={launchingTestId === t.test_id || approval === 'pending' || approval === 'rejected'}
                    onClick={async () => {
                      if (approval !== 'approved') return;
                      if (!attendancePresent) {
                        setJoinMsg({
                          text:
                            t.attendance_status === 'absent'
                              ? 'You are marked absent for this test. Contact your faculty to proceed.'
                              : 'Mark your attendance to attend this test. Contact your faculty to proceed.',
                          ok: false,
                        });
                        return;
                      }
                      if (t.attempt_id) {
                        navigate(`/student/instant-test/${t.attempt_id}`);
                        return;
                      }
                      if (!isLive) {
                        setJoinMsg({ text: `Test "${t.topic}" is not active yet.`, ok: false });
                        return;
                      }
                      setLaunchingTestId(t.test_id);
                      try {
                        const res = await rpc<{ attempt_id: string }>('student_start_course_instant_test', {
                          p_test_id: t.test_id,
                        });
                        navigate(`/student/instant-test/${res.attempt_id}`);
                      } catch (err) {
                        setJoinMsg({ text: errorMessage(err), ok: false });
                      } finally {
                        setLaunchingTestId(null);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: canEnter ? '1.5px solid #16A34A' : '1px solid var(--border)',
                      background: canEnter ? 'rgba(22, 163, 74, 0.08)' : 'var(--surface)',
                      cursor: 'pointer',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {t.course_code} · Coding test: {t.topic}
                      </div>
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                        Code {t.test_code} · {t.total_marks} marks
                        {t.scheduled_at ? ` · ${formatDateTimeIst(t.scheduled_at)}` : ''}
                        {t.marks_approved && t.final_score !== null ? ` · Final: ${t.final_score}/${t.total_marks}` : ''}
                      </div>
                      {isLive && !attendancePresent ? (
                        <div style={{ fontSize: 12, color: '#991B1B', fontWeight: 500, marginTop: 4 }}>
                          Mark your attendance to attend this test. Contact your faculty to proceed.
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {approval === 'pending' ? (
                        <Chip tone="warn">Pending faculty approval</Chip>
                      ) : approval === 'rejected' ? (
                        <Chip tone="bad">Declined</Chip>
                      ) : isLive && !attendancePresent ? (
                        <Chip tone={t.attendance_status === 'absent' ? 'bad' : 'warn'}>
                          {t.attendance_status === 'absent' ? 'Absent' : 'Attendance not marked'}
                        </Chip>
                      ) : (
                        <Chip tone={canEnter ? 'good' : t.status === 'scheduled' ? 'warn' : 'neutral'}>
                          {canEnter ? 'Live · Open portal' : t.status}
                        </Chip>
                      )}
                    </div>
                  </button>
                );
              })}

              {activeSessions
                .filter((s) => s.status === 'active')
                .map((s) => {
                  const co = courseById.get(s.course_id);
                  return (
                    <Link
                      key={s.id}
                      to={`/student/lab/${s.id}`}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--surface-alt)',
                        color: 'inherit',
                        textDecoration: 'none',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {co?.code ?? 'Lab'} · S{s.n}: {s.topic}
                        </div>
                        <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          {s.scheduled_date ? formatDateIst(s.scheduled_date) : 'Active lab session'}
                        </div>
                      </div>
                      <Chip tone="good">Active lab · Open</Chip>
                    </Link>
                  );
                })}

              {data.classTasks.map((task) => {
                const co = courseById.get(task.course_id);
                return (
                  <Link
                    key={task.id}
                    to={`/student/c/${task.course_id}/classroom`}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      color: 'inherit',
                      textDecoration: 'none',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {co?.code ?? 'Course'} · {task.title}
                      </div>
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                        Due: {task.due_at ? formatDateTimeIst(task.due_at) : '—'}
                      </div>
                    </div>
                    <Chip tone="warn">Submission due</Chip>
                  </Link>
                );
              })}
            </div>
          </Card>
          );
        })() : null}

        {data && data.courses.length === 0 ? (
          <Empty
            title="No courses enrolled yet"
            body="Enter the 6-character class code from your faculty invite above."
          />
        ) : null}

        {data && data.courses.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            {data.courses.map((c) => {
              const cSessions = data.sessions.filter(
                (s) => s.course_id === c.id && (s.status === 'active' || s.status === 'conducted'),
              );
              const totals = cSessions.map((sess) => {
                const sRun = data.sessionRuns.find((r) => r.session_id === sess.id);
                const att = sRun
                  ? data.attendance.find((a) => a.session_run_id === sRun.id)?.state ?? null
                  : null;
                const pre = data.attempts.find((a) => a.session_id === sess.id && a.bank === 'pre');
                const post = data.attempts.find((a) => a.session_id === sess.id && a.bank === 'post');
                const viva = data.vivas.find((v) => v.session_id === sess.id);
                const sQs = data.sessionQuestions.filter((sq) => sq.session_id === sess.id);
                const qInputs = sQs.map((sq) => {
                  const mySubs = data.submissions.filter((sub) => sub.question_id === sq.question_id);
                  return {
                    visPassed: Math.max(0, ...mySubs.map((x) => x.visible_passed)),
                    visTotal: Math.max(2, ...mySubs.map((x) => x.visible_total)),
                    hidPassed: Math.max(0, ...mySubs.map((x) => x.hidden_passed)),
                    hidTotal: Math.max(3, ...mySubs.map((x) => x.hidden_total)),
                  };
                });
                return sessionMarks(
                  {
                    attendance: att,
                    preCorrect: pre?.score ?? 0,
                    postCorrect: post?.score ?? 0,
                    questions: qInputs,
                    viva: Number(viva?.marks ?? 0),
                  },
                  c.rubric,
                ).total;
              });

              const attStates = data.attendance
                .filter((a) => data.sessionRuns.some((r) => r.id === a.session_run_id && cSessions.some((s) => s.id === r.session_id)))
                .map((a) => a.state);
              const internalScore = internalOutOf100(totals);
              const attScore = attendancePct(attStates);
              const nextSess = cSessions.find((s) => s.scheduled_date === today) ?? cSessions[0] ?? null;

              return (
                <Card
                  key={c.id}
                  title={`${c.code} · ${c.title}`}
                  actions={<Chip tone="good">{internalScore}/100</Chip>}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      Attendance {attScore}% · {cSessions.length} active sessions
                    </div>
                    {nextSess ? (
                      <div>
                        <Link className="btn btn-teal field-sm" to={`/student/lab/${nextSess.id}`}>
                          Open today&apos;s lab
                        </Link>
                      </div>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: '2 1 520px' }}>
            <InteractiveAcademicCalendar
              title="Calendar, lab schedule & meetings"
              extraEvents={labCalendarEvents}
            />
          </div>

          <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card title="Today">
              {todaySession && todayCourse ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>
                    {todayCourse.code} · S{todaySession.n} {todaySession.topic}
                  </div>
                  {todayBatch ? (
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {todayBatch.slot} · {todayBatch.room}
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>Pre-test</span>
                    {todayPre?.submitted_at ? (
                      <Chip tone="good">Scored {todayPre.score ?? 0}/5</Chip>
                    ) : todayRun?.attendance_done ? (
                      <Chip tone="neutral">Closed at lab start</Chip>
                    ) : (
                      <Link className="btn field-sm" to={`/student/test/${todaySession.id}/pre`}>
                        Take it now
                      </Link>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>Post-test</span>
                    {todayPost?.submitted_at ? (
                      <Chip tone="good">Scored {todayPost.score ?? 0}/5</Chip>
                    ) : todayAllHiddenPassed ? (
                      <Link className="btn btn-teal field-sm" to={`/student/test/${todaySession.id}/post`}>
                        Start post-test
                      </Link>
                    ) : (
                      <Chip tone="neutral">Locked until hidden pass</Chip>
                    )}
                  </div>

                  <Link className="btn btn-teal" to={`/student/lab/${todaySession.id}`}>
                    Open today&apos;s lab
                  </Link>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  No active lab sessions scheduled right now.
                </div>
              )}
            </Card>

            <Card title="Coming up">
              {activeSessions.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No upcoming active sessions.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  {activeSessions.slice(0, 4).map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        paddingTop: 6,
                        borderTop: '1px solid var(--border-soft)',
                      }}
                    >
                      <span>
                        <strong className="mono">S{s.n}</strong> {s.topic}
                      </span>
                      <span className="mono" style={{ color: 'var(--muted)' }}>
                        {s.scheduled_date ? formatDateIst(s.scheduled_date) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Previous tests">
              {(() => {
                const prevTests = (data?.instantTests ?? []).filter(
                  (t) => !(t.status === 'active' && t.active) && t.status !== 'scheduled' && t.approval_status !== 'pending',
                );
                if (prevTests.length === 0) {
                  return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No previous tests yet.</div>;
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {prevTests.map((t) => (
                      <div
                        key={t.test_id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          paddingTop: 6,
                          borderTop: '1px solid var(--border-soft)',
                          fontSize: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>{t.course_code} · {t.topic}</div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                            Code {t.test_code} · {t.marks_approved && t.final_score !== null ? `${t.final_score}/${t.total_marks}` : `${t.total_marks} marks`}
                          </div>
                        </div>
                        <Chip tone={t.approval_status === 'rejected' ? 'bad' : 'neutral'}>
                          {t.approval_status === 'rejected' ? 'Declined' : t.status}
                        </Chip>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Card>

            <Card title="Previous semesters">
              {(data?.courses ?? []).some((c) => c.final_status === 'coe_accepted') ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(data?.courses ?? [])
                    .filter((c) => c.final_status === 'coe_accepted')
                    .map((c) => (
                      <div
                        key={c.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          paddingTop: 6,
                          borderTop: '1px solid var(--border-soft)',
                        }}
                      >
                        <span>
                          <strong className="mono">{c.code}</strong> · {c.title}
                        </span>
                        <Link className="btn field-sm" to={`/student/lab-file?course=${c.id}`}>
                          Lab file
                        </Link>
                      </div>
                    ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Completed courses accepted by the CoE appear here with verified lab files.
                </div>
              )}
            </Card>
          </div>
        </div>

        <CalendarLinkCard />
        <HierarchyMeetingsCard
          title="My meeting requests"
          allowNotify={false}
          allowRequest
        />

        <Modal
          open={requestMeetingOpen}
          title="Request meeting with faculty"
          onClose={() => setRequestMeetingOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '76vh', overflowY: 'auto' }}>
            {facultyContacts.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                No course faculty found yet. Join a course with a class code first.
              </div>
            ) : (
              <>
                <label className="field-label">
                  Select course faculty
                  <select
                    className="field"
                    value={selectedFacultyId}
                    onChange={(e) => setSelectedFacultyId(e.target.value)}
                  >
                    {facultyContacts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.full_name} ({f.email})
                      </option>
                    ))}
                  </select>
                </label>
                {(() => {
                  const activeFac = facultyContacts.find((f) => f.id === selectedFacultyId) ?? facultyContacts[0]!;
                  return (
                    <InteractiveAcademicCalendar
                      key={activeFac.id}
                      title={`${activeFac.full_name}'s calendar (labs, busy days & meetings)`}
                      viewUserId={activeFac.id}
                      viewUserLabel={activeFac.full_name}
                      defaultRecipientId={activeFac.id}
                    />
                  );
                })()}
              </>
            )}
          </div>
        </Modal>
      </div>
    </StudentShell>
  );
}
