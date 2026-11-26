import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarLinkCard } from '../../../components/CalendarLinkCard';
import { HierarchyMeetingsCard } from '../../components/HierarchyMeetingsCard';
import { InteractiveAcademicCalendar, type CalendarOverlayEvent } from '../../components/InteractiveAcademicCalendar';
import { Banner, Card, Chip, Empty, ErrorNote, Loading } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, todayIso } from '../../../lib/format';
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
  const [classCode, setClassCode] = useState('');
  const [joinMsg, setJoinMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyJoin, setBusyJoin] = useState(false);

  const { data, loading, error, reload } = useLoad(async () => {
    const uid = profile?.id ?? '';
    const enrollments = await fetchAll<Enrollment>((from, to) =>
      supabase.from('enrollments').select('*').eq('student_id', uid).range(from, to),
    );
    const courseIds = Array.from(new Set(enrollments.map((e) => e.course_id)));
    const batchIds = Array.from(new Set(enrollments.map((e) => e.batch_id)));

    const [courses, batches, sessions, submissions, attempts, attendance, vivas] =
      courseIds.length > 0
        ? await Promise.all([
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
          ])
        : [[], [], [], [], [], [], []];

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
      sessionQuestions,
      sessionRuns,
    };
  }, [profile?.id]);

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    setJoinMsg(null);
    setBusyJoin(true);
    try {
      await rpc('join_with_code', { p_class_code: classCode.trim() });
      setClassCode('');
      setJoinMsg({ text: 'Joined course successfully.', ok: true });
      reload();
    } catch (err) {
      setJoinMsg({ text: errorMessage(err), ok: false });
    } finally {
      setBusyJoin(false);
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

          <form onSubmit={handleJoin} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field-label">
              Class code from your invite
              <input
                className="field mono"
                required
                value={classCode}
                onChange={(e) => setClassCode(e.target.value)}
                placeholder="e.g. CS7Q4K"
                style={{ width: 170 }}
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busyJoin}>
              {busyJoin ? 'Joining…' : 'Join'}
            </button>
          </form>
        </div>

        {joinMsg ? <Banner tone={joinMsg.ok ? 'ok' : 'err'}>{joinMsg.text}</Banner> : null}
        {error ? <ErrorNote message={error} /> : null}
        {loading && !data ? <Loading label="Loading student courses…" /> : null}

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
          title="Request meeting with faculty"
          allowNotify={false}
          allowRequest
        />
      </div>
    </StudentShell>
  );
}
