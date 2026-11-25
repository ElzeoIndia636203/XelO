import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { errorMessage } from '../../../lib/errors';
import { useSession } from '../../../lib/session';
import { HierarchyMeetingsCard } from '../../components/HierarchyMeetingsCard';
import { RolePortalToggle } from '../../components/RolePortalToggle';

// ── types ──────────────────────────────────────────────────────────────────

type OversightRole = 'vc' | 'coe' | 'dean';

interface DeptRow {
  department_id: string;
  department_name: string;
  school: string;
  lab_courses: number;
  students: number;
  labs_live_now: number;
  attendance_pct: number;
  completion_pct: number;
  co_attained: number;
  co_total: number;
  at_risk: number;
}

interface CourseRow {
  id: string;
  code: string;
  title: string;
  department_name: string;
  faculty_name: string;
  students: number;
  sessions_conducted: number;
  sessions_total: number;
  attendance_pct: number;
  plan_status: string | null;
  final_status: string | null;
  batch_name: string;
}

interface InternalRow {
  id: string;
  code: string;
  title: string;
  department_name: string;
  hod_name: string;
  hod_approved_at: string | null;
  students: number;
  mean_pct: number | null;
  below_40: number;
  final_status: string;
}

interface Holiday {
  id: string;
  day: string;
  label: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    draft: 'var(--muted)', pending: '#d97706', approved: '#16a34a',
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
      {s.replace(/_/g, ' ')}
    </span>
  );
}

const ROLE_TITLE: Record<OversightRole, string> = {
  vc: 'Vice-Chancellor',
  coe: 'Controller of Examinations',
  dean: 'Dean',
};

// ── main component ─────────────────────────────────────────────────────────

interface RawOversightCourse {
  id: string;
  code: string;
  title: string;
  final_status: string | null;
  plan_status: string | null;
  batches: { name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string } | null;
}

interface OversightStatRow {
  course_id: string;
  students: number;
  sessions_conducted: number;
  sessions_total: number;
  attendance_pct: number;
}

interface RawInternalCourse {
  id: string;
  code: string;
  title: string;
  final_status: string | null;
  departments: { name: string } | null;
  course_snapshots: { overall_pct: number | null }[] | null;
  approvals: {
    actor_id: string;
    created_at: string;
    profiles: { full_name: string } | null;
  }[] | null;
}

export default function OversightConsole() {
  const { profile, signOut } = useSession();
  const [role, setRole] = useState<OversightRole>(
    profile?.role === 'vc' || profile?.role === 'coe' || profile?.role === 'dean' ? profile.role : 'vc',
  );
  const [userEmail, setUserEmail] = useState(profile?.email ?? '');
  const [tab, setTab] = useState<'monitor' | 'courses' | 'internals' | 'eligibility'>('monitor');

  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [internals, setInternals] = useState<InternalRow[]>([]);
  const [deptFilter, setDeptFilter] = useState('');
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [minAtt, setMinAtt] = useState(75);
  const [newHolidayDay, setNewHolidayDay] = useState('');
  const [newHolidayLabel, setNewHolidayLabel] = useState('');
  const [savingMinAtt, setSavingMinAtt] = useState(false);
  const [fetchingInternals, setFetchingInternals] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [remarkFor, setRemarkFor] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [err, setErr] = useState('');

  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr('');
    const { data: { user } } = await supabase.auth.getUser();
    setUserEmail(user?.email ?? '');

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user?.id).single();
    if (profile?.role) setRole(profile.role as OversightRole);

    // load dept stats
    const { data: ds, error: de } = await supabase.rpc('dept_stats');
    if (de) { setErr(errorMessage(de.message)); setLoading(false); return; }
    setDepts(ds ?? []);

    // load courses with stats
    const { data: rawC, error: ce } = await supabase
      .from('courses')
      .select(`
        id, code, title, final_status, plan_status,
        batches(name),
        profiles!courses_faculty_id_fkey(full_name),
        departments(name)
      `);
    if (ce) { setErr(errorMessage(ce.message)); setLoading(false); return; }

    const typedC = (rawC ?? []) as unknown as RawOversightCourse[];
    const courseIds = typedC.map((c) => c.id);
    const statsMap: Record<string, OversightStatRow> = {};
    if (courseIds.length > 0) {
      const { data: stats } = await supabase.rpc('course_stats', { p_course_ids: courseIds });
      ((stats ?? []) as OversightStatRow[]).forEach((s) => { statsMap[s.course_id] = s; });
    }

    const merged: CourseRow[] = typedC.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      department_name: c.departments?.name ?? '',
      faculty_name: c.profiles?.full_name ?? '',
      students: statsMap[c.id]?.students ?? 0,
      sessions_conducted: statsMap[c.id]?.sessions_conducted ?? 0,
      sessions_total: statsMap[c.id]?.sessions_total ?? 0,
      attendance_pct: statsMap[c.id]?.attendance_pct ?? 0,
      plan_status: c.plan_status,
      final_status: c.final_status,
      batch_name: c.batches?.name ?? '',
    }));
    setCourses(merged);

    // load institution settings
    const { data: inst } = await supabase.from('institutions').select('min_attendance_pct').single();
    setMinAtt(inst?.min_attendance_pct ?? 75);

    // load holidays
    const { data: hols } = await supabase.from('holidays').select('id, day, label').order('day');
    setHolidays(hols ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => { void loadAll(); }, 0);
    return () => clearTimeout(id);
  }, [loadAll]);

  const fetchInternals = async () => {
    setFetchingInternals(true);
    setErr('');
    const { data, error } = await supabase
      .from('courses')
      .select(`
        id, code, title, final_status,
        departments(name),
        course_snapshots(overall_pct),
        approvals!approvals_entity_id_fkey(actor_id, created_at, profiles(full_name))
      `)
      .eq('final_status', 'hod_approved');
    setFetchingInternals(false);
    if (error) { setErr(errorMessage(error.message)); return; }

    // compute below-40 count per course from enrollments
    const typedData = (data ?? []) as unknown as RawInternalCourse[];
    const rows: InternalRow[] = await Promise.all(typedData.map(async (c) => {
      const { count } = await supabase
        .from('enrollments')
        .select('*', { count: 'exact', head: true })
        .eq('course_id', c.id)
        .eq('role', 'student');
      const approval = c.approvals?.[0];
      return {
        id: c.id,
        code: c.code,
        title: c.title,
        department_name: c.departments?.name ?? '',
        hod_name: approval?.profiles?.full_name ?? '—',
        hod_approved_at: approval?.created_at ?? null,
        students: count ?? 0,
        mean_pct: c.course_snapshots?.[0]?.overall_pct ?? null,
        below_40: 0, // computed server-side in production; mocked 0 for now
        final_status: c.final_status ?? 'hod_approved',
      };
    }));
    setInternals(rows);
  };

  async function acceptInternal(courseId: string) {
    setApprovingId(courseId);
    setErr('');
    const { error } = await supabase.rpc('decide_final_marks', {
      p_course_id: courseId, p_approve: true, p_remark: '',
    });
    setApprovingId(null);
    if (error) setErr(errorMessage(error.message));
    else { setInternals(prev => prev.filter(i => i.id !== courseId)); }
  }

  async function returnInternal(courseId: string) {
    if (!remark.trim()) { setErr('A remark is required to return.'); return; }
    setApprovingId(courseId);
    setErr('');
    const { error } = await supabase.rpc('decide_final_marks', {
      p_course_id: courseId, p_approve: false, p_remark: remark,
    });
    setApprovingId(null);
    setRemarkFor(null);
    setRemark('');
    if (error) setErr(errorMessage(error.message));
    else setInternals(prev => prev.filter(i => i.id !== courseId));
  }

  async function saveMinAtt() {
    setSavingMinAtt(true);
    setErr('');
    const { error } = await supabase.rpc('set_min_attendance', { p_pct: minAtt });
    setSavingMinAtt(false);
    if (error) setErr(errorMessage(error.message));
  }

  async function addHoliday() {
    if (!newHolidayDay || !newHolidayLabel.trim()) return;
    const { error } = await supabase.rpc('add_holiday', { p_day: newHolidayDay, p_label: newHolidayLabel });
    if (error) { setErr(errorMessage(error.message)); return; }
    setNewHolidayDay('');
    setNewHolidayLabel('');
    loadAll();
  }

  async function removeHoliday(id: string) {
    const { error } = await supabase.rpc('remove_holiday', { p_id: id });
    if (error) { setErr(errorMessage(error.message)); return; }
    setHolidays(prev => prev.filter(h => h.id !== id));
  }

  const filteredCourses = deptFilter
    ? courses.filter(c => c.department_name === deptFilter)
    : courses;

  const deptNames = Array.from(new Set(courses.map(c => c.department_name))).sort();

  const kpis = [
    { label: 'Departments', value: depts.length },
    { label: 'Lab courses', value: courses.length },
    { label: 'Students', value: depts.reduce((a, d) => a + d.students, 0) },
    { label: 'Labs live now', value: depts.reduce((a, d) => a + d.labs_live_now, 0) },
    { label: 'At risk', value: depts.reduce((a, d) => a + d.at_risk, 0) },
  ];

  const TABS: { key: string; label: string; roles?: OversightRole[] }[] = [
    { key: 'monitor', label: 'Monitor' },
    { key: 'courses', label: 'Courses' },
    { key: 'internals', label: 'Internals' },
    { key: 'eligibility', label: 'Eligibility', roles: ['coe', 'vc'] },
  ];

  const visibleTabs = TABS.filter(t => !t.roles || t.roles.includes(role));

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Dark topbar */}
      <header style={{
        background: '#1a1f2e', color: '#fff', padding: '0 24px',
        display: 'flex', alignItems: 'center', gap: 16, minHeight: 56,
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', marginRight: 'auto' }}>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', letterSpacing: '0.01em' }}>
            {ROLE_TITLE[role]}
          </span>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{userEmail}</span>
        </div>
        {/* Tab nav in topbar */}
        <nav style={{ display: 'flex', gap: 4 }}>
          {visibleTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as typeof tab)}
              style={{
                background: tab === t.key ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: tab === t.key ? '#fff' : '#94a3b8',
                border: 'none', borderRadius: 6, padding: '6px 14px',
                cursor: 'pointer', fontSize: '0.85rem', fontWeight: tab === t.key ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <RolePortalToggle active="oversight" dark />
        <button
          onClick={signOut}
          style={{
            background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
            borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: '0.8rem',
          }}
        >
          Sign out
        </button>
      </header>

      <main style={{ flex: 1, padding: 24, maxWidth: 1400, margin: '0 auto', width: '100%' }}>
        {loading && <div style={{ color: 'var(--muted)' }}>Loading…</div>}
        {err && <div style={{ color: '#dc2626', fontSize: '0.88rem', marginBottom: 12 }}>{err}</div>}

        {/* ── Monitor ── */}
        {tab === 'monitor' && (
          <>
            <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 16 }}>
              {role === 'vc' ? 'VC monitor' : role === 'coe' ? 'CoE monitor' : 'Dean monitor'}
            </h1>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
              {kpis.map(k => (
                <div key={k.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px' }}>
                  <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{k.value}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 4 }}>{k.label}</div>
                </div>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Department', 'School', 'Lab courses', 'Students', 'Live now', 'Attendance', 'Completion', 'CO attainment', 'At risk'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {depts.map(d => (
                    <tr key={d.department_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 500 }}>{d.department_name}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{d.school}</td>
                      <td style={{ padding: '8px 10px' }}>{d.lab_courses}</td>
                      <td style={{ padding: '8px 10px' }}>{d.students}</td>
                      <td style={{ padding: '8px 10px', color: d.labs_live_now > 0 ? '#16a34a' : 'inherit' }}>{d.labs_live_now}</td>
                      <td style={{ padding: '8px 10px' }}>{d.attendance_pct}%</td>
                      <td style={{ padding: '8px 10px' }}>{d.completion_pct}%</td>
                      <td style={{ padding: '8px 10px' }}>{d.co_total > 0 ? `${d.co_attained}/${d.co_total}` : '—'}</td>
                      <td style={{ padding: '8px 10px', color: d.at_risk > 0 ? '#dc2626' : 'inherit' }}>{d.at_risk}</td>
                    </tr>
                  ))}
                  {depts.length === 0 && (
                    <tr><td colSpan={9} style={{ padding: '24px 10px', color: 'var(--muted)', textAlign: 'center' }}>No data.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── Courses ── */}
        {tab === 'courses' && (
          <>
            <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
              <label style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>Department</label>
              <select
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                style={{ borderRadius: 6, border: '1px solid var(--border)', padding: '5px 10px', fontSize: '0.88rem' }}
              >
                <option value="">All departments</option>
                {deptNames.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 800 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Course', 'Department', 'Faculty', 'Students', 'Sessions', 'Attendance', 'Plan', 'Internals'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredCourses.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{c.code}</div>
                        <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{c.title}</div>
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{c.department_name}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{c.faculty_name}</td>
                      <td style={{ padding: '8px 10px' }}>{c.students}</td>
                      <td style={{ padding: '8px 10px' }}>{c.sessions_conducted}/{c.sessions_total}</td>
                      <td style={{ padding: '8px 10px' }}>{c.attendance_pct}%</td>
                      <td style={{ padding: '8px 10px' }}><StatusChip status={c.plan_status} /></td>
                      <td style={{ padding: '8px 10px' }}><StatusChip status={c.final_status} /></td>
                    </tr>
                  ))}
                  {filteredCourses.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: '24px 10px', color: 'var(--muted)', textAlign: 'center' }}>No courses.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── Internals ── */}
        {tab === 'internals' && (
          <>
            {role === 'coe' && (
              <div style={{ marginBottom: 16 }}>
                <button
                  onClick={fetchInternals}
                  disabled={fetchingInternals}
                  className="btn-primary"
                  style={{ fontSize: '0.88rem' }}
                >
                  {fetchingInternals ? 'Fetching…' : 'Fetch HOD-approved internals'}
                </button>
              </div>
            )}
            {internals.length === 0 && (
              <div style={{ color: 'var(--muted)' }}>
                {role === 'coe' ? 'Click "Fetch HOD-approved internals" to load.' : 'No HOD-approved internals visible.'}
              </div>
            )}
            {internals.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Course', 'Department', 'Approved by HOD', 'Students', 'Mean /100', 'Below 40', 'Status', role === 'coe' ? 'Actions' : ''].filter(Boolean).map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {internals.map(r => (
                      <React.Fragment key={r.id}>
                        <tr style={{ borderBottom: remarkFor === r.id ? 'none' : '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{r.code}</div>
                            <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{r.title}</div>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{r.department_name}</td>
                          <td style={{ padding: '8px 10px', fontSize: '0.8rem' }}>
                            {r.hod_name}<br />
                            {r.hod_approved_at
                              ? <span style={{ color: 'var(--muted)' }}>{new Date(r.hod_approved_at).toLocaleDateString('en-IN')}</span>
                              : '—'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>{r.students}</td>
                          <td style={{ padding: '8px 10px' }}>{r.mean_pct != null ? `${r.mean_pct}%` : '—'}</td>
                          <td style={{ padding: '8px 10px', color: r.below_40 > 0 ? '#dc2626' : 'inherit' }}>{r.below_40}</td>
                          <td style={{ padding: '8px 10px' }}><StatusChip status={r.final_status} /></td>
                          {role === 'coe' && (
                            <td style={{ padding: '8px 10px' }}>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => acceptInternal(r.id)}
                                  disabled={approvingId === r.id}
                                  className="btn-primary"
                                  style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                                >
                                  {approvingId === r.id ? '…' : 'Accept into results'}
                                </button>
                                <button
                                  onClick={() => setRemarkFor(remarkFor === r.id ? null : r.id)}
                                  className="btn-outline"
                                  style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                                >
                                  Return to HOD
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                        {role === 'coe' && remarkFor === r.id && (
                          <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                            <td colSpan={8} style={{ padding: '12px 24px' }}>
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
                                  onClick={() => returnInternal(r.id)}
                                  disabled={!remark.trim() || approvingId === r.id}
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Eligibility (CoE/VC only) ── */}
        {tab === 'eligibility' && (role === 'coe' || role === 'vc') && (
          <div style={{ maxWidth: 640 }}>
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Minimum attendance requirement</div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minAtt}
                  onChange={e => setMinAtt(Number(e.target.value))}
                  style={{ width: 80, borderRadius: 6, border: '1px solid var(--border)', padding: '6px 10px', fontSize: '0.95rem', textAlign: 'right' }}
                />
                <span style={{ color: 'var(--muted)' }}>%</span>
                <button
                  onClick={saveMinAtt}
                  disabled={savingMinAtt}
                  className="btn-primary"
                  style={{ fontSize: '0.88rem' }}
                >
                  {savingMinAtt ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Holidays</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem', marginBottom: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Date', 'Label', ''].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {holidays.map(h => (
                    <tr key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)' }}>{h.day}</td>
                      <td style={{ padding: '8px 10px' }}>{h.label}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <button
                          onClick={() => removeHoliday(h.id)}
                          className="btn-ghost"
                          style={{ color: '#dc2626', fontSize: '0.8rem' }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {holidays.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: '16px 10px', color: 'var(--muted)' }}>No holidays added.</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="date"
                  value={newHolidayDay}
                  onChange={e => setNewHolidayDay(e.target.value)}
                  style={{ borderRadius: 6, border: '1px solid var(--border)', padding: '6px 10px', fontSize: '0.88rem' }}
                />
                <input
                  type="text"
                  value={newHolidayLabel}
                  onChange={e => setNewHolidayLabel(e.target.value)}
                  placeholder="Label (e.g. Republic Day)"
                  style={{ flex: 1, borderRadius: 6, border: '1px solid var(--border)', padding: '6px 10px', fontSize: '0.88rem' }}
                />
                <button
                  onClick={addHoliday}
                  disabled={!newHolidayDay || !newHolidayLabel.trim()}
                  className="btn-primary"
                  style={{ fontSize: '0.88rem', whiteSpace: 'nowrap' }}
                >
                  Add holiday
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <HierarchyMeetingsCard
            title={
              role === 'vc'
                ? 'Notify & schedule meetings (CoE / Deans / HODs / Faculty)'
                : role === 'coe'
                  ? 'Notify & schedule meetings (Deans) & HOD requests'
                  : 'Notify & schedule meetings (HODs) & requests'
            }
            allowNotify
            allowRequest={false}
          />
        </div>
      </main>
    </div>
  );
}
