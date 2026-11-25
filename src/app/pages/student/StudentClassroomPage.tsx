import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Card, Chip, Empty, ErrorNote, Loading } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, formatTimeIst } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import { weekOf } from '../../../lib/logic/flows';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  Batch,
  ClassItemKind,
  ClassItemRow,
  ClassResponseRow,
  Course,
  Enrollment,
  Profile,
  SessionRow,
  TestAttemptRow,
} from '../../../lib/types';
import { StudentShell } from './StudentShell';

const KIND_GLYPH: Record<ClassItemKind, { glyph: string; bg: string; fg: string }> = {
  announcement: { glyph: 'A', bg: '#EAEFF7', fg: '#23436E' },
  resource: { glyph: 'R', bg: '#F1EFE9', fg: '#6B6A63' },
  task: { glyph: 'T', bg: '#FFF4EC', fg: '#9A3412' },
};

export function StudentClassroomPage() {
  const { profile } = useSession();
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [draftAnswers, setDraftAnswers] = useState<Map<string, string>>(() => new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const { data, loading, error, reload } = useLoad(async () => {
    const uid = profile?.id ?? '';
    const enrollments = await fetchAll<Enrollment>((from, to) =>
      supabase.from('enrollments').select('*').eq('student_id', uid).range(from, to),
    );
    const courseIds = Array.from(new Set(enrollments.map((e) => e.course_id)));
    const batchIds = Array.from(new Set(enrollments.map((e) => e.batch_id)));

    if (courseIds.length === 0) {
      return {
        enrollments,
        courses: [] as Course[],
        batches: [] as Batch[],
        facultyProfiles: [] as Array<Pick<Profile, 'id' | 'full_name' | 'email'>>,
        sessions: [] as SessionRow[],
        attempts: [] as TestAttemptRow[],
        classItems: [] as ClassItemRow[],
        responses: [] as ClassResponseRow[],
      };
    }

    const [courses, batches, sessions, attempts, classItems, responses] = await Promise.all([
      fetchAll<Course>((from, to) =>
        supabase.from('courses').select('*').in('id', courseIds).range(from, to),
      ),
      fetchAll<Batch>((from, to) =>
        supabase.from('batches').select('*').in('id', batchIds).range(from, to),
      ),
      fetchAll<SessionRow>((from, to) =>
        supabase.from('sessions').select('*').in('course_id', courseIds).order('n').range(from, to),
      ),
      fetchAll<TestAttemptRow>((from, to) =>
        supabase.from('test_attempts').select('*').eq('student_id', uid).range(from, to),
      ),
      fetchAll<ClassItemRow>((from, to) =>
        supabase
          .from('class_items')
          .select('*')
          .in('course_id', courseIds)
          .order('week')
          .order('created_at')
          .range(from, to),
      ),
      fetchAll<ClassResponseRow>((from, to) =>
        supabase.from('class_responses').select('*').eq('student_id', uid).range(from, to),
      ),
    ]);

    const facultyIds = Array.from(new Set(courses.map((c) => c.faculty_id)));
    const facultyProfiles =
      facultyIds.length > 0
        ? await fetchAll<Pick<Profile, 'id' | 'full_name' | 'email'>>((from, to) =>
            supabase.from('profiles').select('id, full_name, email').in('id', facultyIds).range(from, to),
          )
        : [];

    return {
      enrollments,
      courses,
      batches,
      facultyProfiles,
      sessions,
      attempts,
      classItems,
      responses,
    };
  }, [profile?.id]);

  const activeCourse =
    (data?.courses ?? []).find((c) => c.id === selectedCourseId) ?? data?.courses[0] ?? null;

  const activeEnrollment = activeCourse
    ? (data?.enrollments ?? []).find((e) => e.course_id === activeCourse.id)
    : undefined;
  const activeBatch = activeEnrollment
    ? (data?.batches ?? []).find((b) => b.id === activeEnrollment.batch_id) ?? null
    : null;
  const activeFaculty = activeCourse
    ? (data?.facultyProfiles ?? []).find((p) => p.id === activeCourse.faculty_id) ?? null
    : null;

  const courseSessions = activeCourse
    ? (data?.sessions ?? []).filter((s) => s.course_id === activeCourse.id).sort((a, b) => a.n - b.n)
    : [];
  const todaySession =
    courseSessions.find((s) => s.status === 'active' || s.status === 'conducted') ?? null;

  async function submitTask(item: ClassItemRow) {
    const val = (draftAnswers.get(item.id) ?? '').trim();
    if (!val) return;
    setBusyId(item.id);
    setNotice(null);
    try {
      const score = await rpc<number>('submit_class_response', {
        p_item_id: item.id,
        p_answer: { value: val },
      });
      setNotice({
        text: item.task_type === 'poll' ? 'Response recorded.' : `Submitted. Score: ${score}`,
        ok: true,
      });
      reload();
    } catch (err) {
      setNotice({ text: errorMessage(err), ok: false });
    } finally {
      setBusyId(null);
    }
  }

  async function openPrivateResource(filePath: string) {
    setBusyId(filePath);
    try {
      const { data: signed, error: signErr } = await supabase.storage
        .from('class-files')
        .createSignedUrl(filePath, 300);
      if (signErr || !signed?.signedUrl) {
        throw new Error(signErr?.message ?? 'not_found');
      }
      window.open(signed.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setNotice({ text: errorMessage(err), ok: false });
    } finally {
      setBusyId(null);
    }
  }

  const weekBuckets = (() => {
    const groups = new Map<string, SessionRow[]>();
    for (let i = 0; i < courseSessions.length; i++) {
      const s = courseSessions[i]!;
      const k = s.scheduled_date ? weekOf(s.scheduled_date) : `week-${Math.floor(i / 2) + 1}`;
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    if (groups.size === 0) groups.set('week-1', []);
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const todayWeek = weekOf(todayIso);
    return Array.from(groups.entries()).map(([key, sessList], idx) => {
      const firstDate = sessList.find((s) => s.scheduled_date)?.scheduled_date ?? null;
      const isNow =
        key === todayWeek ||
        (sessList.some((s) => s.status === 'active') && !sessList.every((s) => s.status === 'conducted'));
      const allDone = sessList.length > 0 && sessList.every((s) => s.status === 'conducted');
      return {
        weekNum: idx + 1,
        key,
        dateLabel: firstDate ? formatDateIst(firstDate) : `Week ${idx + 1}`,
        tag: isNow ? 'This week' : allDone ? 'Done' : 'Upcoming',
        isNow,
        sessions: sessList,
      };
    });
  })();

  const responseMap = new Map((data?.responses ?? []).map((r) => [r.item_id, r]));
  const itemsByWeek = new Map<number, ClassItemRow[]>();
  for (const item of data?.classItems ?? []) {
    if (!activeCourse || item.course_id !== activeCourse.id) continue;
    const arr = itemsByWeek.get(item.week) ?? [];
    arr.push(item);
    itemsByWeek.set(item.week, arr);
  }

  return (
    <StudentShell
      activeTab="classroom"
      hasTodayLab={Boolean(todaySession)}
      todaySessionId={todaySession?.id ?? null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && !data ? <Loading label="Loading classroom…" /> : null}
        {error ? <ErrorNote message={error} /> : null}
        {notice ? <Banner tone={notice.ok ? 'ok' : 'err'}>{notice.text}</Banner> : null}

        {data && !activeCourse ? (
          <Empty title="No courses joined yet" body="Join a course using your batch class code on Home." />
        ) : null}

        {activeCourse ? (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                gap: 12,
              }}
            >
              <div>
                <div className="page-kicker">CLASSROOM TIMELINE</div>
                <h1 className="page-title">
                  {activeCourse.code} · {activeCourse.title}
                </h1>
              </div>

              {(data?.courses.length ?? 0) > 1 ? (
                <label className="field-label">
                  Course
                  <select
                    className="field field-sm"
                    value={activeCourse.id}
                    onChange={(e) => setSelectedCourseId(e.target.value)}
                  >
                    {(data?.courses ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} · {c.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            <Card>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
                <div>
                  <strong>{activeBatch?.name ?? 'Batch'}</strong> · {activeFaculty?.full_name ?? 'Faculty'} ·{' '}
                  <span className="mono">{activeBatch?.slot || 'Lab slot'}</span> · {activeBatch?.room || 'Lab'}
                </div>
                {todaySession ? (
                  <Link className="btn btn-teal field-sm" to={`/student/lab/${todaySession.id}`}>
                    Open today&apos;s lab
                  </Link>
                ) : null}
              </div>
            </Card>

            <Card title="Scheduled labs" flush>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Date</th>
                      <th>Topic</th>
                      <th>Pre-test</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {courseSessions
                      .filter((s) => s.status === 'active' || s.status === 'conducted')
                      .map((s) => {
                        const pre = (data?.attempts ?? []).find(
                          (a) => a.session_id === s.id && a.bank === 'pre',
                        );
                        return (
                          <tr key={s.id}>
                            <td className="mono">S{s.n}</td>
                            <td className="mono" style={{ fontSize: 12 }}>
                              {s.scheduled_date ? formatDateIst(s.scheduled_date) : '—'}
                            </td>
                            <td>{s.topic}</td>
                            <td className="mono">
                              {pre?.submitted_at ? (
                                `Done ${pre.score ?? 0}/5`
                              ) : s.status === 'active' ? (
                                <Link className="btn field-sm" to={`/student/test/${s.id}/pre`}>
                                  Take pre-test
                                </Link>
                              ) : (
                                'Closed'
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <Link className="btn field-sm" to={`/student/lab/${s.id}`}>
                                Open lab
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    {courseSessions.filter((s) => s.status === 'active' || s.status === 'conducted').length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--muted)', textAlign: 'center', padding: 14 }}>
                          No active labs scheduled yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {weekBuckets.map((wk) => {
                const wkItems = itemsByWeek.get(wk.weekNum) ?? [];
                const topicsSummary =
                  wk.sessions.map((s) => `S${s.n} ${s.topic}`).join(' · ') || `${activeCourse.code}`;
                return (
                  <div
                    key={wk.key}
                    className="timeline-row"
                  >
                    <div className="timeline-date">
                      <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                        {wk.dateLabel}
                      </div>
                      <div style={{ fontSize: 11, color: wk.isNow ? 'var(--assist)' : 'var(--muted)' }}>
                        {wk.tag}
                      </div>
                    </div>

                    <div
                      style={{
                        background: 'var(--surface)',
                        border: `1px solid ${wk.isNow ? 'var(--ink)' : 'var(--border)'}`,
                        borderRadius: 6,
                        padding: '12px 16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
                        <strong>Week {wk.weekNum}</strong>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{topicsSummary}</span>
                      </div>

                      {wkItems.length === 0 && wk.sessions.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing posted yet for this week.</div>
                      ) : null}

                      {wkItems.map((item) => {
                        const g = KIND_GLYPH[item.kind];
                        const resp = responseMap.get(item.id);
                        const curVal = draftAnswers.get(item.id) ?? resp?.answer.value ?? '';

                        return (
                          <div
                            key={item.id}
                            style={{
                              borderTop: '1px solid var(--border-soft)',
                              paddingTop: 10,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <div className="timeline-item-head">
                              <span
                                className="mono"
                                style={{
                                  width: 26,
                                  height: 26,
                                  flexShrink: 0,
                                  borderRadius: 5,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: 12,
                                  fontWeight: 600,
                                  background: g.bg,
                                  color: g.fg,
                                }}
                              >
                                {g.glyph}
                              </span>
                              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
                                {item.body ? (
                                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{item.body}</div>
                                ) : null}
                                {item.kind === 'announcement' ? (
                                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                                    {formatTimeIst(item.created_at)}
                                  </div>
                                ) : null}
                              </div>

                              <div style={{ marginLeft: 'auto' }}>
                                {item.kind === 'task' ? (
                                  resp ? (
                                    <Chip tone="good">
                                      {item.task_type === 'poll' ? 'Done' : `Done · ${resp.score ?? 0}/1`}
                                    </Chip>
                                  ) : (
                                    <Chip tone="warn">Open</Chip>
                                  )
                                ) : item.kind === 'resource' ? (
                                  item.file_path ? (
                                    <button
                                      type="button"
                                      className="btn field-sm"
                                      disabled={busyId === item.file_path}
                                      onClick={() => void openPrivateResource(item.file_path!)}
                                    >
                                      {busyId === item.file_path ? 'Opening…' : 'Open file'}
                                    </button>
                                  ) : item.url ? (
                                    <a
                                      className="btn field-sm"
                                      href={item.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      Open link
                                    </a>
                                  ) : (
                                    <Chip tone="neutral">Resource</Chip>
                                  )
                                ) : (
                                  <Chip tone="neutral">Announcement</Chip>
                                )}
                              </div>
                            </div>

                            {item.kind === 'task' ? (
                              <div className="timeline-task-body">
                                {item.payload.code ? (
                                  <pre
                                    className="mono"
                                    style={{
                                      margin: 0,
                                      padding: 10,
                                      background: '#F6F5F1',
                                      border: '1px solid var(--border-soft)',
                                      borderRadius: 5,
                                      fontSize: 12,
                                      overflowX: 'auto',
                                    }}
                                  >
                                    {item.payload.code}
                                  </pre>
                                ) : null}

                                {(item.task_type === 'quiz' || item.task_type === 'poll') &&
                                Array.isArray(item.payload.options) &&
                                item.payload.options.length > 0 ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                    {item.payload.options.map((opt, idx) => {
                                      const optVal = String(idx);
                                      return (
                                        <label
                                          key={`${item.id}-opt-${idx}`}
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            padding: '6px 10px',
                                            borderRadius: 5,
                                            border: `1px solid ${curVal === optVal ? 'var(--ink)' : 'var(--border-soft)'}`,
                                            fontSize: 12,
                                            cursor: 'pointer',
                                          }}
                                        >
                                          <input
                                            type="radio"
                                            name={`task-${item.id}`}
                                            checked={curVal === optVal}
                                            onChange={() =>
                                              setDraftAnswers((prev) => new Map(prev).set(item.id, optVal))
                                            }
                                          />
                                          <span>{opt}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <input
                                    className="field field-sm mono"
                                    aria-label={`Answer for ${item.title}`}
                                    placeholder="Write your answer…"
                                    value={curVal}
                                    onChange={(e) =>
                                      setDraftAnswers((prev) => new Map(prev).set(item.id, e.target.value))
                                    }
                                    style={{ maxWidth: 420 }}
                                  />
                                )}

                                <div>
                                  <button
                                    type="button"
                                    className="btn btn-teal field-sm"
                                    disabled={busyId === item.id || !curVal.trim()}
                                    onClick={() => void submitTask(item)}
                                  >
                                    {busyId === item.id ? 'Submitting…' : resp ? 'Update answer' : 'Submit answer'}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </StudentShell>
  );
}
