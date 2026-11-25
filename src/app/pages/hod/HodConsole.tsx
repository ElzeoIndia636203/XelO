import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { errorMessage } from '../../../lib/errors';
import { useSession } from '../../../lib/session';
import { ConsoleShell, type NavItem } from '../../components/ConsoleShell';

// ── types ──────────────────────────────────────────────────────────────────

interface Course {
  id: string;
  code: string;
  title: string;
  batch_name: string;
  faculty_name: string;
  department_name: string;
  final_status: string | null;
  plan_status: string | null;
  endsem_status: string | null;
  // from course_stats RPC
  students: number;
  sessions_total: number;
  sessions_conducted: number;
  attendance_pct: number;
  completion_pct: number;
  at_risk: number;
  live_now: boolean;
}

interface ApprovalItem {
  id: string;
  kind: string;
  course_code: string;
  course_title: string;
  what: string;
  age_hours: number;
  entity_id: string;
}

interface AtRiskStudent {
  student_id: string;
  roll: string;
  name: string;
  course: string;
  code: string;
  reason: string;
  attendance_pct: number;
}

interface LiveLabRow {
  course_code: string;
  batch_name: string;
  room: string;
  slot: string;
  session_n: number;
  topic: string;
  started_at: string;
  ended_at: string | null;
  enrolled: number;
  present: number;
  pre_done: number;
  passed: number;
  struggling: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

const STAGES = ['draft', 'submitted', 'hod_approved', 'sent', 'coe_accepted'] as const;
const STAGE_LABELS: Record<string, string> = {
  draft: 'Faculty draft',
  submitted: 'Submitted',
  hod_approved: 'HOD approved',
  sent: 'Sent to CoE',
  coe_accepted: 'Accepted by CoE',
};

function PipelineDots({ status }: { status: string | null }) {
  const idx = status ? STAGES.indexOf(status as typeof STAGES[number]) : -1;
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {STAGES.map((s, i) => (
        <span
          key={s}
          title={STAGE_LABELS[s]}
          style={{
            width: 10, height: 10, borderRadius: '50%',
            background: i <= idx ? 'var(--accent)' : 'var(--border)',
            display: 'inline-block',
          }}
        />
      ))}
      <span style={{ fontSize: '0.78rem', color: 'var(--muted)', marginLeft: 4 }}>
        {status ? STAGE_LABELS[status] ?? status : 'No marks yet'}
      </span>
    </span>
  );
}

function StatusChip({ status, kind }: { status: string | null; kind?: string }) {
  const map: Record<string, string> = {
    draft: 'var(--muted)', pending: '#d97706', approved: '#16a34a',
    rejected: '#dc2626', active: 'var(--accent)', completed: '#16a34a',
    submitted: '#d97706', hod_approved: 'var(--accent)',
    sent: '#7c3aed', coe_accepted: '#16a34a',
  };
  const s = status ?? 'draft';
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px',
      borderRadius: 4, background: (map[s] ?? 'var(--muted)') + '22',
      color: map[s] ?? 'var(--muted)', textTransform: 'capitalize',
    }}>
      {kind ? `${kind}: ` : ''}{s.replace(/_/g, ' ')}
    </span>
  );
}

function AgeLabel({ hours }: { hours: number }) {
  if (hours < 24) return <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{Math.round(hours)}h ago</span>;
  const days = Math.floor(hours / 24);
  const color = days >= 3 ? '#dc2626' : days >= 2 ? '#d97706' : 'var(--muted)';
  return <span style={{ color, fontSize: '0.8rem', fontWeight: days >= 2 ? 600 : 400 }}>{days}d ago</span>;
}

function AssistPanel({ courses }: { courses: Course[] }) {
  const suggestions: string[] = [];
  const lowAtt = courses.filter(c => c.attendance_pct < 75 && c.sessions_conducted >= 2);
  const lowComp = courses.filter(c => c.completion_pct < 50 && c.sessions_conducted >= 2);
  if (lowAtt.length > 0)
    suggestions.push(`${lowAtt.length} course${lowAtt.length > 1 ? 's have' : ' has'} attendance below 75%.`);
  if (lowComp.length > 0)
    suggestions.push(`${lowComp.length} course${lowComp.length > 1 ? 's have' : ' has'} completion below 50%.`);
  if (courses.some(c => c.at_risk > 5))
    suggestions.push('Some courses have more than 5 students at risk. Review before the exam.');
  if (suggestions.length === 0)
    suggestions.push('All courses are on track.');
  return (
    <div style={{
      background: 'var(--assist-bg, #fff7ed)', border: '1px solid var(--assist, #f97316)',
      borderRadius: 8, padding: '12px 16px', marginBottom: 20,
    }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--assist, #f97316)', fontWeight: 700, marginBottom: 6 }}>
        Assist suggests
      </div>
      {suggestions.map((s, i) => (
        <div key={i} style={{ fontSize: '0.88rem', color: 'var(--text)', marginBottom: 4 }}>• {s}</div>
      ))}
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────

interface RawHodCourse {
  id: string;
  code: string;
  title: string;
  final_status: string | null;
  plan_status: string | null;
  endsem_status: string | null;
  batches: { name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string } | null;
}

interface CourseStatRow {
  course_id: string;
  students: number;
  sessions_total: number;
  sessions_conducted: number;
  attendance_pct: number;
  completion_pct: number;
  at_risk: number;
  live_now: boolean;
}

interface RawHodNotification {
  id: string;
  kind: string;
  entity_id: string;
  created_at: string;
  payload: { course_code?: string; course_title?: string } | null;
}

export default function HodConsole() {
  const { profile, signOut } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const validTabs = ['overview', 'approvals', 'courses', 'live', 'final'] as const;
  const tab: (typeof validTabs)[number] =
    validTabs.includes(initialTab as (typeof validTabs)[number])
      ? (initialTab as (typeof validTabs)[number])
      : 'overview';
  const setTab = (next: (typeof validTabs)[number]) => {
    setSearchParams(next === 'overview' ? {} : { tab: next });
  };
  const [courses, setCourses] = useState<Course[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [atRisk, setAtRisk] = useState<AtRiskStudent[]>([]);
  const [liveLabs, setLiveLabs] = useState<LiveLabRow[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [remarkFor, setRemarkFor] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [planRemark, setPlanRemark] = useState<Record<string, string>>({});
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr('');
    // load courses this HOD oversees
    const { data: rawCourses, error: ce } = await supabase
      .from('courses')
      .select(`
        id, code, title, final_status, plan_status, endsem_status,
        batches(name),
        profiles!courses_faculty_id_fkey(full_name),
        departments(name)
      `)
      .eq('institution_id', (await supabase.rpc('my_institution')).data);
    if (ce) { setErr(errorMessage(ce.message)); setLoading(false); return; }

    const typedCourses = (rawCourses ?? []) as unknown as RawHodCourse[];
    const courseIds = typedCourses.map((c) => c.id);

    let stats: CourseStatRow[] = [];
    if (courseIds.length > 0) {
      const { data: s, error: se } = await supabase.rpc('course_stats', { p_course_ids: courseIds });
      if (se) { setErr(errorMessage(se.message)); setLoading(false); return; }
      stats = (s ?? []) as CourseStatRow[];
    }

    const merged: Course[] = typedCourses.map((c) => {
      const st = stats.find((s) => s.course_id === c.id);
      return {
        id: c.id,
        code: c.code,
        title: c.title,
        batch_name: c.batches?.name ?? '',
        faculty_name: c.profiles?.full_name ?? '',
        department_name: c.departments?.name ?? '',
        final_status: c.final_status,
        plan_status: c.plan_status,
        endsem_status: c.endsem_status,
        students: st?.students ?? 0,
        sessions_total: st?.sessions_total ?? 0,
        sessions_conducted: st?.sessions_conducted ?? 0,
        attendance_pct: st?.attendance_pct ?? 0,
        completion_pct: st?.completion_pct ?? 0,
        at_risk: st?.at_risk ?? 0,
        live_now: st?.live_now ?? false,
      };
    });
    setCourses(merged);

    // load approvals (notifications of kind plan/final_marks pending action)
    const { data: notifs, error: ne } = await supabase
      .from('notifications')
      .select('id, kind, entity_id, created_at, payload')
      .eq('recipient_id', (await supabase.auth.getUser()).data.user?.id)
      .in('kind', ['plan_pending', 'final_marks_pending'])
      .order('created_at', { ascending: false });
    if (ne) { setErr(errorMessage(ne.message)); setLoading(false); return; }

    const now = Date.now();
    const typedNotifs = (notifs ?? []) as unknown as RawHodNotification[];
    const notifItems: ApprovalItem[] = typedNotifs.map((n) => ({
      id: n.id,
      kind: n.kind === 'plan_pending' ? 'Course plan' : 'Final marks',
      course_code: n.payload?.course_code ?? '',
      course_title: n.payload?.course_title ?? '',
      what: n.kind === 'plan_pending' ? 'Awaiting HOD approval' : 'Awaiting HOD approval & CoE submission',
      age_hours: (now - new Date(n.created_at).getTime()) / 3_600_000,
      entity_id: n.entity_id,
    }));

    // Also include courses/assessments directly in pending state
    const seen = new Set(notifItems.map((i) => `${i.kind}:${i.entity_id}`));
    const directItems: ApprovalItem[] = [];
    for (const c of merged) {
      if (c.plan_status === 'sent' && !seen.has(`Course plan:${c.id}`)) {
        directItems.push({
          id: `plan-${c.id}`,
          kind: 'Course plan',
          course_code: c.code,
          course_title: c.title,
          what: 'Awaiting HOD approval',
          age_hours: 1,
          entity_id: c.id,
        });
      }
      if (c.final_status === 'sent' && !seen.has(`Final marks:${c.id}`)) {
        directItems.push({
          id: `final-${c.id}`,
          kind: 'Final marks',
          course_code: c.code,
          course_title: c.title,
          what: 'Awaiting HOD approval & CoE submission',
          age_hours: 1,
          entity_id: c.id,
        });
      }
    }
    if (courseIds.length > 0) {
      const { data: pendingAssess } = await supabase
        .from('assessments')
        .select('id, course_id')
        .in('course_id', courseIds)
        .eq('hod_status', 'sent');
      for (const a of (pendingAssess ?? []) as { id: string; course_id: string }[]) {
        const c = merged.find((x) => x.id === a.course_id);
        if (c && !seen.has(`End-sem set:${a.id}`)) {
          directItems.push({
            id: `endsem-${a.id}`,
            kind: 'End-sem set',
            course_code: c.code,
            course_title: c.title,
            what: '30-question end-sem set awaiting HOD approval',
            age_hours: 1,
            entity_id: a.id,
          });
        }
      }
    }
    setApprovals([...directItems, ...notifItems]);

    // at-risk students
    if (courseIds.length > 0) {
      const { data: ar, error: are } = await supabase.rpc('at_risk_students', { p_course_ids: courseIds });
      if (!are) setAtRisk((ar ?? []) as AtRiskStudent[]);
    }
    setLoading(false);
  }, []);

  const loadLive = useCallback(async () => {
    const courseIds = courses.map(c => c.id);
    if (courseIds.length === 0) return;
    const { data, error } = await supabase.rpc('live_lab_stats', { p_course_ids: courseIds });
    if (!error) setLiveLabs((data ?? []) as LiveLabRow[]);
  }, [courses]);

  useEffect(() => {
    const id = setTimeout(() => { void loadAll(); }, 0);
    return () => clearTimeout(id);
  }, [loadAll]);

  useEffect(() => {
    if (tab === 'live') {
      const id = setTimeout(() => { void loadLive(); }, 0);
      liveTimer.current = setInterval(() => { void loadLive(); }, 30_000);
      return () => {
        clearTimeout(id);
        if (liveTimer.current) clearInterval(liveTimer.current);
      };
    }
    return () => { if (liveTimer.current) clearInterval(liveTimer.current); };
  }, [tab, loadLive]);

  const liveCount = courses.filter(c => c.live_now).length;
  const pendingCount = approvals.length;

  // overview KPIs
  const kpis = [
    { label: 'Lab courses', value: courses.length },
    { label: 'Students', value: courses.reduce((a, c) => a + c.students, 0) },
    { label: 'Avg attendance', value: courses.length ? (courses.reduce((a, c) => a + c.attendance_pct, 0) / courses.length).toFixed(1) + '%' : '—' },
    { label: 'Avg completion', value: courses.length ? (courses.reduce((a, c) => a + c.completion_pct, 0) / courses.length).toFixed(1) + '%' : '—' },
    { label: 'At risk', value: courses.reduce((a, c) => a + c.at_risk, 0) },
  ];

  async function decidePlan(courseId: string, code: string, approve: boolean) {
    setApprovingId(courseId);
    setErr('');
    setNotice('');
    const rm = (planRemark[courseId] ?? '').trim();
    const { error } = await supabase.rpc('decide_course_plan', {
      p_course_id: courseId,
      p_approve: approve,
      p_remark: rm || null,
    });
    setApprovingId(null);
    if (error) {
      setErr(errorMessage(error.message));
    } else {
      setNotice(`${code} course plan ${approve ? 'approved' : 'declined'}.`);
      loadAll();
    }
  }

  async function decideEndsem(assessmentId: string, code: string, approve: boolean) {
    setApprovingId(assessmentId);
    setErr('');
    setNotice('');
    const rm = (planRemark[assessmentId] ?? '').trim();
    const { error } = await supabase.rpc('decide_assessment', {
      p_assessment_id: assessmentId,
      p_approve: approve,
      p_remark: rm || null,
    });
    setApprovingId(null);
    if (error) {
      setErr(errorMessage(error.message));
    } else {
      setNotice(`${code} end-sem set ${approve ? 'approved' : 'returned'}.`);
      loadAll();
    }
  }

  async function approveFinalMarks(courseId: string) {
    setApprovingId(courseId);
    setErr('');
    const { error } = await supabase.rpc('decide_final_marks', { p_course_id: courseId, p_approve: true, p_remark: '' });
    setApprovingId(null);
    if (error) setErr(errorMessage(error.message));
    else loadAll();
  }

  async function returnFinalMarks(courseId: string) {
    if (!remark.trim()) { setErr('A remark is required to return.'); return; }
    setApprovingId(courseId);
    setErr('');
    const { error } = await supabase.rpc('decide_final_marks', { p_course_id: courseId, p_approve: false, p_remark: remark });
    setApprovingId(null);
    setRemarkFor(null);
    setRemark('');
    if (error) setErr(errorMessage(error.message));
    else loadAll();
  }

  const navItems: NavItem[] = [
    { id: 'overview', label: 'Overview', badge: pendingCount > 0 ? pendingCount : undefined },
    { id: 'approvals', label: 'Approvals', badge: pendingCount > 0 ? pendingCount : undefined },
    { id: 'courses',   label: 'Courses' },
    { id: 'live',      label: 'Live', badge: liveCount > 0 ? liveCount : undefined },
    { id: 'final',     label: 'Final marks' },
  ];

  return (
    <ConsoleShell
      roleTitle="HOD"
      scopeText={courses[0]?.department_name || 'Department'}
      navItems={navItems}
      activeTab={tab}
      onTabChange={(k) => setTab(k as typeof tab)}
      userEmail={profile?.email ?? ''}
      onSignOut={signOut}
    >
      {loading && <div style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
      {err && <div style={{ padding: '12px 24px', color: '#dc2626', fontSize: '0.88rem' }}>{err}</div>}
      {notice && <div style={{ padding: '12px 24px', color: '#16a34a', fontSize: '0.88rem' }}>{notice}</div>}

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div style={{ padding: 24 }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 16 }}>Department overview</h1>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
            {kpis.map(k => (
              <div key={k.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px' }}>
                <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text)' }}>{k.value}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <AssistPanel courses={courses} />

          {approvals.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>Waiting for you</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Type', 'Course', 'What', 'Age'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {approvals.map(a => (
                    <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px' }}><StatusChip status={null} kind={a.kind} /></td>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)' }}>{a.course_code}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{a.what}</td>
                      <td style={{ padding: '8px 12px' }}><AgeLabel hours={a.age_hours} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {atRisk.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>Students at risk</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Roll', 'Name', 'Course', 'Reason', 'Attendance'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {atRisk.map(s => (
                    <tr key={s.student_id + s.code} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)' }}>{s.roll}</td>
                      <td style={{ padding: '8px 12px' }}>{s.name}</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)' }}>{s.code}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{s.reason}</td>
                      <td style={{ padding: '8px 12px' }}>{s.attendance_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Approvals ── */}
      {tab === 'approvals' && (
        <div style={{ padding: 24 }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 16 }}>Approvals</h1>
          {approvals.length === 0 && <div style={{ color: 'var(--muted)' }}>Nothing waiting. All clear.</div>}
          {approvals.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Type', 'Course', 'Detail', 'Age', 'Actions'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {approvals.map(a => {
                  const isFinal = a.kind === 'Final marks';
                  return (
                    <React.Fragment key={a.id}>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px' }}><StatusChip status={null} kind={a.kind} /></td>
                        <td style={{ padding: '8px 12px' }}>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{a.course_code} · {a.course_title}</div>
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{a.what}</td>
                        <td style={{ padding: '8px 12px' }}><AgeLabel hours={a.age_hours} /></td>
                        <td style={{ padding: '8px 12px' }}>
                          {!isFinal && a.kind === 'End-sem set' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <input
                                type="text"
                                placeholder="Remark (required to return)"
                                value={planRemark[a.entity_id] ?? ''}
                                onChange={(e) => setPlanRemark((prev) => ({ ...prev, [a.entity_id]: e.target.value }))}
                                style={{ borderRadius: 4, border: '1px solid var(--border)', padding: '4px 8px', fontSize: '0.8rem' }}
                              />
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => decideEndsem(a.entity_id, a.course_code, true)}
                                  disabled={approvingId === a.entity_id}
                                  className="btn-primary"
                                  style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                                >
                                  Approve end-sem set
                                </button>
                                <button
                                  onClick={() => decideEndsem(a.entity_id, a.course_code, false)}
                                  disabled={approvingId === a.entity_id}
                                  className="btn-outline"
                                  style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                                >
                                  Return end-sem set
                                </button>
                              </div>
                            </div>
                          )}
                          {!isFinal && a.kind !== 'End-sem set' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <input
                                type="text"
                                placeholder="Remark (required to decline)"
                                value={planRemark[a.entity_id] ?? ''}
                                onChange={(e) => setPlanRemark((prev) => ({ ...prev, [a.entity_id]: e.target.value }))}
                                style={{ borderRadius: 4, border: '1px solid var(--border)', padding: '4px 8px', fontSize: '0.8rem' }}
                              />
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => decidePlan(a.entity_id, a.course_code, true)}
                                  disabled={approvingId === a.entity_id}
                                  className="btn-primary"
                                  style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                                >
                                  {approvingId === a.entity_id ? 'Approving…' : 'Approve course plan'}
                                </button>
                                <button
                                  onClick={() => decidePlan(a.entity_id, a.course_code, false)}
                                  disabled={approvingId === a.entity_id}
                                  className="btn-outline"
                                  style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                                >
                                  Decline with remarks
                                </button>
                              </div>
                            </div>
                          )}
                          {isFinal && (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                onClick={() => approveFinalMarks(a.entity_id)}
                                disabled={approvingId === a.entity_id}
                                className="btn-primary"
                                style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                              >
                                Approve & send to CoE
                              </button>
                              <button
                                onClick={() => setRemarkFor(remarkFor === a.entity_id ? null : a.entity_id)}
                                className="btn-outline"
                                style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                              >
                                Return
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      {isFinal && remarkFor === a.entity_id && (
                        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                          <td colSpan={5} style={{ padding: '12px 24px' }}>
                            <div style={{ fontWeight: 500, marginBottom: 6, fontSize: '0.88rem' }}>Remark (required to return)</div>
                            <textarea
                              value={remark}
                              onChange={e => setRemark(e.target.value)}
                              rows={2}
                              style={{ width: '100%', maxWidth: 480, borderRadius: 6, border: '1px solid var(--border)', padding: '6px 10px', fontFamily: 'inherit', fontSize: '0.88rem', resize: 'vertical' }}
                              placeholder="Explain what needs to be corrected…"
                            />
                            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                              <button
                                onClick={() => returnFinalMarks(a.entity_id)}
                                disabled={!remark.trim() || approvingId === a.entity_id}
                                className="btn-outline"
                                style={{ fontSize: '0.8rem', padding: '4px 12px', color: '#dc2626', borderColor: '#dc2626' }}
                              >
                                Confirm return
                              </button>
                              <button onClick={() => { setRemarkFor(null); setRemark(''); }} className="btn-ghost" style={{ fontSize: '0.8rem' }}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Courses ── */}
      {tab === 'courses' && (
        <div style={{ padding: 24, overflowX: 'auto' }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 16 }}>Courses</h1>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Code / Title', 'Batch · Faculty', 'Students', 'Sessions', 'Attendance', 'Completion', 'At risk', 'Plan', 'Final marks'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courses.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{c.code}</div>
                    <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{c.title}</div>
                  </td>
                  <td style={{ padding: '8px 10px', color: 'var(--muted)', fontSize: '0.8rem' }}>
                    {c.batch_name}<br />{c.faculty_name}
                  </td>
                  <td style={{ padding: '8px 10px' }}>{c.students}</td>
                  <td style={{ padding: '8px 10px' }}>{c.sessions_conducted}/{c.sessions_total}</td>
                  <td style={{ padding: '8px 10px' }}>{c.attendance_pct}%</td>
                  <td style={{ padding: '8px 10px' }}>{c.completion_pct}%</td>
                  <td style={{ padding: '8px 10px', color: c.at_risk > 0 ? '#dc2626' : 'inherit' }}>{c.at_risk}</td>
                  <td style={{ padding: '8px 10px' }}><StatusChip status={c.plan_status} /></td>
                  <td style={{ padding: '8px 10px' }}><PipelineDots status={c.final_status} /></td>
                </tr>
              ))}
              {courses.length === 0 && (
                <tr><td colSpan={9} style={{ padding: '24px 10px', color: 'var(--muted)', textAlign: 'center' }}>No courses.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Live ── */}
      {tab === 'live' && (
        <div style={{ padding: 24 }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 8 }}>Live labs</h1>
          <div style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 12 }}>Auto-refreshes every 30 s</div>
          {liveLabs.length === 0 && <div style={{ color: 'var(--muted)' }}>No labs running right now.</div>}
          {liveLabs.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 32 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 800 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Time', 'Course · Batch', 'Room', 'Session', 'Status', 'Present', 'Pre-test done', 'Passed', 'Struggling'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {liveLabs.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
                        {r.started_at ? new Date(r.started_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{r.course_code}</span>
                        <span style={{ color: 'var(--muted)' }}> · {r.batch_name}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{r.room || '—'}</td>
                      <td style={{ padding: '8px 10px' }}>#{r.session_n} {r.topic}</td>
                      <td style={{ padding: '8px 10px' }}><StatusChip status="active" /></td>
                      <td style={{ padding: '8px 10px' }}>{r.present}/{r.enrolled}</td>
                      <td style={{ padding: '8px 10px' }}>{r.pre_done}</td>
                      <td style={{ padding: '8px 10px', color: '#16a34a' }}>{r.passed}</td>
                      <td style={{ padding: '8px 10px', color: r.struggling > 0 ? '#d97706' : 'inherit' }}>{r.struggling}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {atRisk.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>Students at risk</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Roll', 'Name', 'Course', 'Reason', 'Attendance'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {atRisk.map(s => (
                    <tr key={s.student_id + s.code} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)' }}>{s.roll}</td>
                      <td style={{ padding: '8px 10px' }}>{s.name}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)' }}>{s.code}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{s.reason}</td>
                      <td style={{ padding: '8px 10px' }}>{s.attendance_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Final marks ── */}
      {tab === 'final' && (
        <div style={{ padding: 24 }}>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 16 }}>Final marks</h1>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Code', 'Title', 'Pipeline'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courses.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontWeight: 600 }}>{c.code}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{c.title}</td>
                  <td style={{ padding: '10px 12px' }}><PipelineDots status={c.final_status} /></td>
                </tr>
              ))}
              {courses.length === 0 && (
                <tr><td colSpan={3} style={{ padding: '24px 12px', color: 'var(--muted)', textAlign: 'center' }}>No courses.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
