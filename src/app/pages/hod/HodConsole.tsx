import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fn, supabase } from '../../../lib/supabase';
import { Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { useSession } from '../../../lib/session';
import { ConsoleShell, type NavItem } from '../../components/ConsoleShell';
import { HierarchyMeetingsCard } from '../../components/HierarchyMeetingsCard';
import { InteractiveAcademicCalendar } from '../../components/InteractiveAcademicCalendar';
import { RolePortalToggle } from '../../components/RolePortalToggle';
import { FeedbackLoopTab } from './FeedbackLoopTab';

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

interface DeptOutcomeRow {
  id: string;
  kind: 'PO' | 'PSO';
  code: string;
  statement: string;
}

type CalendarEventKind =
  | 'internal_exam'
  | 'regional_holiday'
  | 'other_holiday'
  | 'leave'
  | 'academic_event';
type SaturdayRule = 'all' | 'odd' | 'even' | 'none';

interface CalendarEventRow {
  id: string;
  day: string;
  kind: CalendarEventKind;
  event_type?: string | null;
  label: string;
  no_attendance?: boolean;
}

interface FacultyCourseStatRow {
  faculty_id: string;
  faculty_name: string;
  faculty_email: string;
  course_id: string;
  course_code: string;
  course_title: string;
  sessions_total: number;
  sessions_conducted: number;
  missed_classes: number;
  streak: number;
  attendance_pct: number;
  avg_score_pct: number;
}

const CAL_EVENT_LABELS: Record<CalendarEventKind, string> = {
  internal_exam: 'Internal exam (no classes)',
  regional_holiday: 'Regional / local holiday',
  other_holiday: 'Other holiday',
  leave: 'Leave',
  academic_event: 'Academic event (Hackathon / Symposium / Workshop...)',
};

const ACADEMIC_EVENT_PRESETS = [
  'Hackathon',
  'Symposium',
  'Expo',
  'Seminar',
  'Workshop',
  'Culturals',
  'Other',
] as const;

const STANDARD_NBA_POS: ReadonlyArray<{ code: string; statement: string }> = [
  {
    code: 'PO1',
    statement:
      'Engineering Knowledge: Apply the knowledge of mathematics, science, engineering fundamentals, and an engineering specialization to the solution of complex engineering problems.',
  },
  {
    code: 'PO2',
    statement:
      'Problem Analysis: Identify, formulate, review research literature, and analyze complex engineering problems reaching substantiated conclusions using first principles of mathematics, natural sciences, and engineering sciences.',
  },
  {
    code: 'PO3',
    statement:
      'Design/Development of Solutions: Design solutions for complex engineering problems and design system components or processes that meet the specified needs with appropriate consideration for public health and safety, and cultural, societal, and environmental considerations.',
  },
  {
    code: 'PO4',
    statement:
      'Conduct Investigations of Complex Problems: Use research-based knowledge and research methods including design of experiments, analysis and interpretation of data, and synthesis of the information to provide valid conclusions.',
  },
  {
    code: 'PO5',
    statement:
      'Engineering Tool Usage: Create, select, and apply appropriate techniques, resources, and modern engineering and IT tools including prediction and modeling to complex engineering activities with an understanding of the limitations.',
  },
  {
    code: 'PO6',
    statement:
      'The Engineer and the World: Analyze and evaluate societal, health, safety, legal, cultural, and environmental aspects while solving complex engineering problems for their impact on sustainable development.',
  },
  {
    code: 'PO7',
    statement:
      'Ethics: Apply ethical principles and commit to professional ethics and responsibilities and norms of the engineering practice.',
  },
  {
    code: 'PO8',
    statement:
      'Individual and Collaborative Team Work: Function effectively as an individual, and as a member or leader in diverse teams, and in multidisciplinary settings.',
  },
  {
    code: 'PO9',
    statement:
      'Communication: Communicate effectively on complex engineering activities with the engineering community and with society at large, such as being able to comprehend and write effective reports and design documentation, make effective presentations, and give and receive clear instructions.',
  },
  {
    code: 'PO10',
    statement:
      'Project Management and Finance: Demonstrate knowledge and understanding of engineering and management principles and apply these to one’s own work, as a member and leader in a team, to manage projects and in multidisciplinary environments.',
  },
  {
    code: 'PO11',
    statement:
      'Life-Long Learning: Recognize the need for, and have the preparation and ability to engage in independent and life-long learning in the broadest context of technological change.',
  },
];

export default function HodConsole() {
  const { profile, signOut } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const validTabs = ['overview', 'approvals', 'courses', 'faculties', 'outcomes', 'calendar', 'feedback', 'live', 'final'] as const;
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
  const [deptOutcomes, setDeptOutcomes] = useState<DeptOutcomeRow[]>([]);
  const [outcomesDirty, setOutcomesDirty] = useState(false);
  const [editingOutcomeId, setEditingOutcomeId] = useState<string | null>(null);
  const [editOutcomeCode, setEditOutcomeCode] = useState('');
  const [editOutcomeStmt, setEditOutcomeStmt] = useState('');
  const [poCode, setPoCode] = useState('');
  const [poStmt, setPoStmt] = useState('');
  const [psoCode, setPsoCode] = useState('');
  const [psoStmt, setPsoStmt] = useState('');
  const [poBusy, setPoBusy] = useState(false);

  // Academic calendar state
  const [calId, setCalId] = useState<string | null>(null);
  const [calFirstDay, setCalFirstDay] = useState('2027-01-06');
  const [calLastDay, setCalLastDay] = useState('2027-04-28');
  const [calEndsemDate, setCalEndsemDate] = useState('2027-05-05');
  const [calSatRule, setCalSatRule] = useState<SaturdayRule>('all');
  const [calApproved, setCalApproved] = useState(false);
  const [calEvents, setCalEvents] = useState<CalendarEventRow[]>([]);
  const [calEvDay, setCalEvDay] = useState('');
  const [calEvEndDay, setCalEvEndDay] = useState('');
  const [calEvKind, setCalEvKind] = useState<CalendarEventKind>('internal_exam');
  const [calEvTypePreset, setCalEvTypePreset] = useState<string>('Hackathon');
  const [calEvCustomType, setCalEvCustomType] = useState('');
  const [calEvNoAttendance, setCalEvNoAttendance] = useState(false);
  const [calEvLabel, setCalEvLabel] = useState('');
  const [editingEvId, setEditingEvId] = useState<string | null>(null);
  const [editEvDay, setEditEvDay] = useState('');
  const [editEvKind, setEditEvKind] = useState<CalendarEventKind>('internal_exam');
  const [editEvLabel, setEditEvLabel] = useState('');
  const [calBusy, setCalBusy] = useState(false);
  const [calLoadedUpdatedAt, setCalLoadedUpdatedAt] = useState<string | null>(null);
  const calEventFormRef = useRef<HTMLFormElement | null>(null);
  const [facultyStats, setFacultyStats] = useState<FacultyCourseStatRow[]>([]);
  const [selectedCalFacultyId, setSelectedCalFacultyId] = useState<string | null>(null);
  const [meetingTarget, setMeetingTarget] = useState<FacultyCourseStatRow | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('10:30');
  const [meetingNote, setMeetingNote] = useState('');
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [remarkFor, setRemarkFor] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [planRemark, setPlanRemark] = useState<Record<string, string>>({});
  const [previewCourseId, setPreviewCourseId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    course: {
      id: string;
      code: string;
      title: string;
      ltpc: string;
      programme: string;
      semester: string;
      section: string;
      academic_year: string;
      allowed_langs: string[];
      rubric: Record<string, number>;
      plan_status: string;
      plan_remark: string | null;
      department_name: string;
      faculty_name: string;
      faculty_email: string;
    };
    outcomes: Array<{ id: string; code: string; statement: string; unit: number; btl: number }>;
    co_po_map: Array<{ co_id: string; po_code: string; level: number }>;
    sessions_count: number;
  } | null>(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [aiReview, setAiReview] = useState<{
    verdict: 'approve' | 'revise';
    summary: string;
    strengths: string[];
    gaps: string[];
    suggested_remark: string;
  } | null>(null);
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState(false);

  const hodDeptId = profile?.hod_department_id ?? profile?.department_id ?? null;

  const loadDeptConfig = useCallback(async () => {
    const facRes = await supabase.rpc('hod_faculty_summary', { p_department_id: hodDeptId });
    if (!facRes.error && facRes.data) {
      setFacultyStats((facRes.data as FacultyCourseStatRow[]) ?? []);
    }

    if (!hodDeptId) return;
    const [poRes, calRes] = await Promise.all([
      supabase
        .from('department_outcomes')
        .select('id, kind, code, statement')
        .eq('department_id', hodDeptId)
        .order('kind', { ascending: true })
        .order('code', { ascending: true }),
      supabase
        .from('academic_calendars')
        .select('id, first_working_day, last_working_day, expected_endsem_date, saturday_rule, approved, updated_at')
        .eq('department_id', hodDeptId)
        .maybeSingle(),
    ]);

    if (poRes.error) {
      setErr(errorMessage(poRes.error.message));
    } else if (poRes.data) {
      const sorted = (poRes.data as DeptOutcomeRow[]).sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'PO' ? -1 : 1;
        return a.code.localeCompare(b.code, undefined, { numeric: true });
      });
      setDeptOutcomes(sorted);
      setOutcomesDirty(false);
    }

    if (!calRes.error && calRes.data) {
      const typedCal = calRes.data as {
        id: string;
        first_working_day: string;
        last_working_day: string;
        expected_endsem_date: string | null;
        saturday_rule: SaturdayRule;
        approved: boolean;
        updated_at?: string;
      };
      setCalId(typedCal.id);
      setCalLoadedUpdatedAt(typedCal.updated_at ?? null);
      setCalFirstDay(typedCal.first_working_day);
      setCalLastDay(typedCal.last_working_day);
      setCalEndsemDate(typedCal.expected_endsem_date ?? '');
      setCalSatRule(typedCal.saturday_rule);
      setCalApproved(typedCal.approved);
      const { data: evRows } = await supabase
        .from('academic_calendar_events')
        .select('id, day, kind, event_type, label, no_attendance')
        .eq('calendar_id', typedCal.id)
        .order('day');
      setCalEvents(((evRows ?? []) as CalendarEventRow[]));
    }
  }, [hodDeptId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr('');
    void loadDeptConfig();
    // load pending approvals via SECURITY DEFINER RPC first so they never get blocked by secondary queries
    const { data: rpcApprovals, error: appErr } = await supabase.rpc('hod_pending_approvals');

    // load courses this HOD oversees (plain columns to avoid PostgREST embed failures)
    const instId = profile?.institution_id ?? (await supabase.rpc('my_institution')).data;
    let coursesQuery = supabase
      .from('courses')
      .select('id, code, title, department_id, faculty_id, final_status, plan_status, endsem_status, approval_hod_ids')
      .eq('institution_id', instId);
    if (hodDeptId && profile?.id) {
      coursesQuery = coursesQuery.or(`department_id.eq.${hodDeptId},approval_hod_ids.cs.{${profile.id}}`);
    } else if (hodDeptId) {
      coursesQuery = coursesQuery.eq('department_id', hodDeptId);
    }
    const { data: rawCourses, error: ce } = await coursesQuery;
    if (ce) {
      if (!appErr && Array.isArray(rpcApprovals)) {
        setApprovals(rpcApprovals as ApprovalItem[]);
      }
      setErr(errorMessage(ce.message));
      setLoading(false);
      return;
    }

    const typedCourses = (rawCourses ?? []) as unknown as Array<{
      id: string;
      code: string;
      title: string;
      department_id: string;
      faculty_id: string;
      final_status: string;
      plan_status: string;
      endsem_status: string;
    }>;
    const courseIds = typedCourses.map((c) => c.id);

    let stats: CourseStatRow[] = [];
    if (courseIds.length > 0) {
      const { data: s } = await supabase.rpc('course_stats', { p_course_ids: courseIds });
      stats = (s ?? []) as CourseStatRow[];
    }

    const deptIds = Array.from(new Set(typedCourses.map((c) => c.department_id).filter(Boolean)));
    const deptNameMap = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: dRows } = await supabase.from('departments').select('id, name').in('id', deptIds);
      for (const d of (dRows ?? []) as Array<{ id: string; name: string }>) {
        deptNameMap.set(d.id, d.name);
      }
    }

    const merged: Course[] = typedCourses.map((c) => {
      const st = stats.find((s) => s.course_id === c.id);
      return {
        id: c.id,
        code: c.code,
        title: c.title,
        batch_name: '',
        faculty_name: '',
        department_name: deptNameMap.get(c.department_id) ?? '',
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

    if (!appErr && Array.isArray(rpcApprovals)) {
      setApprovals(rpcApprovals as ApprovalItem[]);
    } else {
      const directItems: ApprovalItem[] = [];
      for (const c of merged) {
        if (c.plan_status === 'sent') {
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
        if (c.final_status === 'sent') {
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
      setApprovals(directItems);
    }

    // at-risk students
    if (courseIds.length > 0) {
      const { data: ar, error: are } = await supabase.rpc('at_risk_students', { p_course_ids: courseIds });
      if (!are) setAtRisk((ar ?? []) as AtRiskStudent[]);
    }
    setLoading(false);
  }, [hodDeptId, loadDeptConfig, profile]);

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

  async function openPlanPreview(courseId: string) {
    setPreviewCourseId(courseId);
    setPreviewData(null);
    setAiReview(null);
    setPreviewLoading(true);
    const { data, error } = await supabase.rpc('hod_course_plan_preview', { p_course_id: courseId });
    setPreviewLoading(false);
    if (error || !data) {
      setErr(errorMessage(error?.message ?? 'not_found'));
      setPreviewCourseId(null);
      return;
    }
    setPreviewData(data as typeof previewData);
  }

  async function runAiPlanReview(courseId: string) {
    setAiReviewLoading(true);
    setErr('');
    try {
      const res = await fn<{
        review: {
          verdict: 'approve' | 'revise';
          summary: string;
          strengths: string[];
          gaps: string[];
          suggested_remark: string;
        };
      }>('ai-generate', { kind: 'course_plan_review', course_id: courseId });
      setAiReview(res.review);
    } catch (e) {
      setErr(errorMessage(e instanceof Error ? e.message : 'ai_failed'));
    } finally {
      setAiReviewLoading(false);
    }
  }

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
      setPreviewCourseId(null);
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

  function addDeptOutcome(e: React.FormEvent, kind: 'PO' | 'PSO') {
    e.preventDefault();
    const rawCode = kind === 'PO' ? poCode : psoCode;
    const rawStmt = kind === 'PO' ? poStmt : psoStmt;
    const cleanCode = rawCode.trim().toUpperCase();
    const cleanStmt = rawStmt.trim();
    if (!cleanCode) {
      setErr(`Enter a ${kind} code (e.g. ${kind === 'PO' ? 'PO1' : 'PSO1'}).`);
      return;
    }
    if (deptOutcomes.some((o) => o.code.toUpperCase() === cleanCode)) {
      setErr(`${cleanCode} is already in the list.`);
      return;
    }
    setErr('');
    setDeptOutcomes((prev) => [
      ...prev,
      { id: `draft-${Date.now()}-${cleanCode}`, kind, code: cleanCode, statement: cleanStmt },
    ]);
    setOutcomesDirty(true);
    if (kind === 'PO') {
      setPoCode('');
      setPoStmt('');
    } else {
      setPsoCode('');
      setPsoStmt('');
    }
  }

  function seedStandardPos() {
    setErr('');
    const existing = new Set(deptOutcomes.map((o) => o.code.toUpperCase()));
    const missing = STANDARD_NBA_POS.filter((p) => !existing.has(p.code)).map((p) => ({
      id: `draft-${Date.now()}-${p.code}`,
      kind: 'PO' as const,
      code: p.code,
      statement: p.statement,
    }));
    if (missing.length === 0) {
      setNotice('All 11 standard NBA POs are already listed.');
      return;
    }
    setDeptOutcomes((prev) => [...missing, ...prev]);
    setOutcomesDirty(true);
    setNotice(`Loaded ${missing.length} standard NBA POs. Click Save and approve below to publish.`);
  }

  function startEditOutcome(o: DeptOutcomeRow) {
    setEditingOutcomeId(o.id);
    setEditOutcomeCode(o.code);
    setEditOutcomeStmt(o.statement);
  }

  function saveOutcomeEdit(id: string) {
    const cleanCode = editOutcomeCode.trim().toUpperCase();
    if (!cleanCode) {
      setErr('Code cannot be empty.');
      return;
    }
    setErr('');
    setDeptOutcomes((prev) =>
      prev.map((o) =>
        o.id === id ? { ...o, code: cleanCode, statement: editOutcomeStmt.trim() } : o,
      ),
    );
    setEditingOutcomeId(null);
    setOutcomesDirty(true);
  }

  function deleteDeptOutcome(id: string) {
    setDeptOutcomes((prev) => prev.filter((o) => o.id !== id));
    if (editingOutcomeId === id) setEditingOutcomeId(null);
    setOutcomesDirty(true);
  }

  async function saveAndApproveOutcomes() {
    if (!hodDeptId || !profile?.institution_id) {
      setErr('Your HOD profile is missing a department assignment.');
      return;
    }
    setPoBusy(true);
    setErr('');
    setNotice('');
    const { error: delErr } = await supabase
      .from('department_outcomes')
      .delete()
      .eq('department_id', hodDeptId);
    if (delErr) {
      setPoBusy(false);
      setErr(errorMessage(delErr.message));
      return;
    }
    if (deptOutcomes.length > 0) {
      const rows = deptOutcomes.map((o) => ({
        institution_id: profile.institution_id,
        department_id: hodDeptId,
        kind: o.kind,
        code: o.code.trim().toUpperCase(),
        statement: o.statement.trim(),
        created_by: profile.id,
      }));
      const { error: insErr } = await supabase.from('department_outcomes').insert(rows);
      if (insErr) {
        setPoBusy(false);
        setErr(errorMessage(insErr.message));
        return;
      }
    }
    setPoBusy(false);
    setOutcomesDirty(false);
    setNotice('POs & PSOs saved and approved for your department.');
    void loadAll();
  }

  function resolvedEventType(): string | null {
    if (calEvKind !== 'academic_event') return null;
    if (calEvTypePreset === 'Other') {
      return calEvCustomType.trim() || 'Academic Event';
    }
    return calEvTypePreset;
  }

  function addCalendarEvent(e: React.FormEvent) {
    e.preventDefault();
    const evType = resolvedEventType();
    if (!calEvDay || (!calEvLabel.trim() && !evType)) {
      setErr('Enter a From date and description for the event/holiday.');
      return;
    }
    const endIso = calEvEndDay || calEvDay;
    if (endIso < calEvDay) {
      setErr('To date must be on or after From date.');
      return;
    }

    const startD = new Date(`${calEvDay}T00:00:00Z`);
    const endD = new Date(`${endIso}T00:00:00Z`);
    const days: string[] = [];
    const cur = new Date(startD.getTime());
    while (cur <= endD && days.length < 60) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const labelText = calEvLabel.trim() || evType || 'Event';
    const existingDays = new Set(calEvents.map((ev) => ev.day));
    const additions: CalendarEventRow[] = days
      .filter((d) => !existingDays.has(d))
      .map((d) => ({
        id: `draft-${Date.now()}-${d}`,
        day: d,
        kind: calEvKind,
        event_type: evType,
        label: labelText,
        no_attendance: calEvNoAttendance || calEvKind !== 'academic_event',
      }));

    if (additions.length === 0) {
      setErr(`All dates in ${calEvDay}..${endIso} are already listed.`);
      return;
    }

    setErr('');
    setCalEvents((prev) => [...prev, ...additions].sort((a, b) => a.day.localeCompare(b.day)));
    setCalEvDay('');
    setCalEvEndDay('');
    setCalEvLabel('');
    setCalEvNoAttendance(false);
  }

  async function declareEventLive() {
    const evType = resolvedEventType();
    if (!calEvDay || (!calEvLabel.trim() && !evType)) {
      setErr('Enter a From date and event name/description.');
      return;
    }
    const endIso = calEvEndDay || calEvDay;
    if (endIso < calEvDay) {
      setErr('To date must be on or after From date.');
      return;
    }
    setCalBusy(true);
    setErr('');
    setNotice('');
    const { data, error } = await supabase.rpc('hod_declare_calendar_event', {
      p_from_day: calEvDay,
      p_to_day: endIso,
      p_kind: calEvKind,
      p_event_type: evType,
      p_label: calEvLabel.trim() || evType || 'Event',
      p_no_attendance: calEvNoAttendance,
    });
    setCalBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    const res = (data ?? {}) as {
      days_saved?: number;
      sessions_overridden?: number;
      notified_users?: number;
      override_text?: string | null;
    };
    setCalEvDay('');
    setCalEvEndDay('');
    setCalEvLabel('');
    setCalEvNoAttendance(false);
    setNotice(
      res.override_text
        ? `Declared ${res.days_saved ?? 1} No-attendance day(s): ${res.override_text}. ${res.sessions_overridden ?? 0} scheduled session(s) overridden and ${res.notified_users ?? 0} notifications sent to class, faculty, students, Dean, CoE, and VC.`
        : `Added event for ${res.days_saved ?? 1} day(s) on the academic calendar.`,
    );
    void loadDeptConfig();
  }

  function startEditCalEvent(ev: CalendarEventRow) {
    setEditingEvId(ev.id);
    setEditEvDay(ev.day);
    setEditEvKind(ev.kind);
    setEditEvLabel(ev.label);
  }

  function saveCalEventEdit(id: string) {
    if (!editEvDay || !editEvLabel.trim()) {
      setErr('Date and label are required.');
      return;
    }
    setErr('');
    setCalEvents((prev) =>
      prev
        .map((ev) =>
          ev.id === id
            ? { ...ev, day: editEvDay, kind: editEvKind, label: editEvLabel.trim() }
            : ev,
        )
        .sort((a, b) => a.day.localeCompare(b.day)),
    );
    setEditingEvId(null);
  }

  function deleteCalEvent(id: string) {
    setCalEvents((prev) => prev.filter((ev) => ev.id !== id));
    if (editingEvId === id) setEditingEvId(null);
  }

  async function saveAcademicCalendar(approve: boolean) {
    if (!hodDeptId || !profile?.institution_id) {
      setErr('Your HOD profile is missing a department assignment.');
      return;
    }
    if (!calFirstDay || !calLastDay || calFirstDay > calLastDay) {
      setErr('First working day must be on or before Last working day.');
      return;
    }
    setCalBusy(true);
    setErr('');
    setNotice('');

    if (calId && calLoadedUpdatedAt) {
      const { data: latestCal } = await supabase
        .from('academic_calendars')
        .select('updated_at')
        .eq('id', calId)
        .maybeSingle();
      const latestAt = (latestCal as { updated_at?: string } | null)?.updated_at ?? null;
      if (latestAt && latestAt !== calLoadedUpdatedAt) {
        setCalBusy(false);
        setErr('This calendar was updated in another tab. Reloading the latest calendar before saving.');
        void loadDeptConfig();
        return;
      }
    }

    const nextUpdatedAt = new Date().toISOString();
    const payload = {
      institution_id: profile.institution_id,
      department_id: hodDeptId,
      first_working_day: calFirstDay,
      last_working_day: calLastDay,
      expected_endsem_date: calEndsemDate || null,
      saturday_rule: calSatRule,
      approved: approve,
      approved_by: approve ? profile.id : null,
      approved_at: approve ? nextUpdatedAt : null,
      created_by: profile.id,
      updated_at: nextUpdatedAt,
    };

    const { data: savedCal, error: calErr } = await supabase
      .from('academic_calendars')
      .upsert(payload, { onConflict: 'department_id' })
      .select('id')
      .single();

    if (calErr || !savedCal) {
      setCalBusy(false);
      setErr(errorMessage(calErr?.message ?? 'invalid_input'));
      return;
    }

    const activeCalId = (savedCal as { id: string }).id;
    setCalId(activeCalId);

    const { error: delEvErr } = await supabase
      .from('academic_calendar_events')
      .delete()
      .eq('calendar_id', activeCalId);
    if (delEvErr) {
      setCalBusy(false);
      setErr(errorMessage(delEvErr.message));
      return;
    }

    if (calEvents.length > 0) {
      const evPayload = calEvents.map((ev) => ({
        calendar_id: activeCalId,
        institution_id: profile.institution_id,
        department_id: hodDeptId,
        day: ev.day,
        kind: ev.kind,
        event_type: ev.event_type ?? null,
        label: ev.label.trim(),
        no_attendance: Boolean(ev.no_attendance),
      }));
      const { error: insEvErr } = await supabase
        .from('academic_calendar_events')
        .insert(evPayload);
      if (insEvErr) {
        setCalBusy(false);
        setErr(errorMessage(insEvErr.message));
        return;
      }
    }

    setCalBusy(false);
    setCalApproved(approve);
    setNotice(
      approve
        ? 'Academic calendar saved and approved. Faculty can now use it in Session plan.'
        : 'Academic calendar draft saved.',
    );
    void loadAll();
  }

  async function scheduleFacultyMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!meetingTarget || !meetingTitle.trim()) return;
    setCalBusy(true);
    setErr('');
    const scheduledIso = meetingDate
      ? new Date(`${meetingDate}T${meetingTime || '10:30'}:00+05:30`).toISOString()
      : null;
    const { error } = await supabase.rpc('send_hierarchy_message', {
      p_recipient_id: meetingTarget.faculty_id,
      p_kind: 'meeting_scheduled',
      p_title: meetingTitle.trim(),
      p_scheduled_at: scheduledIso,
      p_note: meetingNote.trim(),
      p_course_id: meetingTarget.course_id,
    });
    setCalBusy(false);
    if (error) {
      setErr(errorMessage(error.message));
      return;
    }
    setNotice(`Meeting scheduled with ${meetingTarget.faculty_name} (${meetingTarget.course_code}).`);
    setMeetingTarget(null);
    setMeetingTitle('');
    setMeetingDate('');
    setMeetingTime('10:30');
    setMeetingNote('');
  }

  const navItems: NavItem[] = [
    { id: 'overview', label: 'Overview', badge: pendingCount > 0 ? pendingCount : undefined },
    { id: 'approvals', label: 'Approvals', badge: pendingCount > 0 ? pendingCount : undefined },
    { id: 'courses',   label: 'Courses' },
    { id: 'faculties', label: 'Faculties' },
    { id: 'outcomes',  label: 'POs & PSOs' },
    { id: 'calendar',  label: 'Academic calendar' },
    { id: 'feedback',  label: 'Feedback loop' },
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
      topbarExtra={<RolePortalToggle active="hod" />}
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

          {/* ── Department & Faculty Calendar (Landing view) ── */}
          {(() => {
            const deptFaculties = Array.from(
              new Map(
                facultyStats.map((f) => [
                  f.faculty_id,
                  { id: f.faculty_id, name: f.faculty_name, email: f.faculty_email },
                ]),
              ).values(),
            );
            const activeFac = deptFaculties.find((f) => f.id === selectedCalFacultyId) ?? null;
            return (
              <div style={{ marginTop: 20, marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--muted)', marginRight: 4 }}>
                    Calendar view:
                  </span>
                  <button
                    type="button"
                    className={!activeFac ? 'btn btn-primary field-sm' : 'btn field-sm'}
                    onClick={() => setSelectedCalFacultyId(null)}
                  >
                    Department / My HOD calendar
                  </button>
                  {deptFaculties.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={activeFac?.id === f.id ? 'btn btn-primary field-sm' : 'btn field-sm'}
                      onClick={() => setSelectedCalFacultyId(f.id)}
                      title={f.email}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                <InteractiveAcademicCalendar
                  key={activeFac?.id ?? 'dept'}
                  title={activeFac ? `${activeFac.name}'s calendar (labs, busy days & meetings)` : 'Department calendar & meetings'}
                  departmentId={hodDeptId}
                  viewUserId={activeFac?.id ?? null}
                  viewUserLabel={activeFac?.name}
                  defaultRecipientId={activeFac?.id}
                />
              </div>
            );
          })()}

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
                          {!isFinal && a.kind === 'Course plan' ? (
                            <button
                              type="button"
                              onClick={() => void openPlanPreview(a.entity_id)}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                padding: 0,
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontFamily: 'var(--mono)',
                                fontWeight: 600,
                                color: 'var(--teal)',
                                textDecoration: 'underline',
                              }}
                              title="Click to preview full course plan"
                            >
                              {a.course_code} · {a.course_title}
                            </button>
                          ) : (
                            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{a.course_code} · {a.course_title}</div>
                          )}
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
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  onClick={() => void openPlanPreview(a.entity_id)}
                                  className="btn-outline"
                                  style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                                >
                                  Preview & AI review
                                </button>
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

      {/* ── Faculties ── */}
      {tab === 'faculties' && (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h1 style={{ fontSize: '1.35rem', fontWeight: 700 }}>Department faculties</h1>
            <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginTop: 4 }}>
              Track conducted sessions, streak, missed classes, student performance, and schedule meetings with faculty.
            </p>
          </div>

          {meetingTarget ? (
            <form
              onSubmit={scheduleFacultyMeeting}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'flex-end',
                padding: 16,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              <div style={{ width: '100%', fontWeight: 600, fontSize: '0.9rem' }}>
                Schedule meeting with {meetingTarget.faculty_name} ({meetingTarget.course_code})
              </div>
              <label className="field-label" style={{ flex: '1 1 200px' }}>
                Subject
                <input
                  className="field"
                  required
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  placeholder="Course progress / missed session review"
                />
              </label>
              <label className="field-label">
                Date
                <input
                  className="field mono"
                  type="date"
                  value={meetingDate}
                  onChange={(e) => setMeetingDate(e.target.value)}
                />
              </label>
              <label className="field-label">
                Time (IST)
                <input
                  className="field mono"
                  type="time"
                  value={meetingTime}
                  onChange={(e) => setMeetingTime(e.target.value)}
                />
              </label>
              <label className="field-label" style={{ flex: '1 1 200px' }}>
                Note
                <input
                  className="field"
                  value={meetingNote}
                  onChange={(e) => setMeetingNote(e.target.value)}
                  placeholder="Cabin / meeting link"
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={calBusy}>
                {calBusy ? 'Sending…' : 'Send & notify'}
              </button>
              <button type="button" className="btn" onClick={() => setMeetingTarget(null)}>
                Cancel
              </button>
            </form>
          ) : null}

          {facultyStats.length === 0 ? (
            <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)' }}>
              No faculty courses found in your department yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Faculty', 'Course', 'Conducted', 'Streak', 'Missed', 'Attendance', 'Student perf.', ''].map((h, i) => (
                      <th key={h + i} style={{ textAlign: i === 7 ? 'right' : 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {facultyStats.map((f) => (
                    <tr key={f.course_id ?? f.faculty_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px' }}>
                        <div style={{ fontWeight: 600 }}>{f.faculty_name}</div>
                        <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                          {f.faculty_email}
                        </div>
                      </td>
                      <td style={{ padding: '10px' }}>
                        {f.course_id ? (
                          <>
                            <span className="mono" style={{ fontWeight: 600 }}>{f.course_code}</span> · {f.course_title}
                          </>
                        ) : (
                          <span style={{ color: 'var(--muted)' }}>No courses assigned yet</span>
                        )}
                      </td>
                      <td className="mono" style={{ padding: '10px' }}>
                        {f.course_id ? `${f.sessions_conducted}/${f.sessions_total}` : '—'}
                      </td>
                      <td className="mono" style={{ padding: '10px' }}>{f.course_id ? f.streak : '—'}</td>
                      <td className="mono" style={{ padding: '10px', color: f.missed_classes > 0 ? '#dc2626' : 'var(--muted)' }}>
                        {f.course_id ? f.missed_classes : '—'}
                      </td>
                      <td className="mono" style={{ padding: '10px' }}>{f.course_id ? `${f.attendance_pct}%` : '—'}</td>
                      <td className="mono" style={{ padding: '10px' }}>{f.course_id ? `${f.avg_score_pct}%` : '—'}</td>
                      <td style={{ padding: '10px', textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn field-sm"
                          onClick={() => {
                            setMeetingTarget(f);
                            setMeetingTitle(
                              f.course_id
                                ? `Review: ${f.course_code} (${f.course_title})`
                                : `Department check-in: ${f.faculty_name}`,
                            );
                          }}
                        >
                          Schedule meeting
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <InteractiveAcademicCalendar title="Calendar & approved meetings" />
          <HierarchyMeetingsCard
            title="Meetings & notifications (Faculty / Dean / CoE / VC)"
            allowNotify
            allowRequest
          />
        </div>
      )}

      {/* ── POs & PSOs ── */}
      {tab === 'outcomes' && (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div>
            <h1 style={{ fontSize: '1.35rem', fontWeight: 700 }}>PO & PSO registry</h1>
            <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginTop: 4 }}>
              Add or load POs and PSOs, review or edit them, then click Save and approve at the bottom.
            </p>
          </div>

          {/* Section 1: Programme Outcomes (POs) */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Programme Outcomes (PO1–PO11)</h2>
              <button
                type="button"
                className="btn"
                onClick={seedStandardPos}
                disabled={poBusy}
              >
                Load standard NBA POs (PO1–PO11)
              </button>
            </div>

            {deptOutcomes.filter((o) => o.kind === 'PO').length === 0 ? (
              <div style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: '0.86rem', marginBottom: 12 }}>
                No POs listed yet. Click Load standard NBA POs (PO1–PO11) or add one below.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem', marginBottom: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Code', 'Statement', 'Actions'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 2 ? 'right' : 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deptOutcomes
                    .filter((o) => o.kind === 'PO')
                    .map((o) =>
                      editingOutcomeId === o.id ? (
                        <tr key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px', width: 100 }}>
                            <input
                              className="field field-sm mono"
                              value={editOutcomeCode}
                              onChange={(e) => setEditOutcomeCode(e.target.value)}
                              style={{ width: 84 }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input
                              className="field field-sm"
                              value={editOutcomeStmt}
                              onChange={(e) => setEditOutcomeStmt(e.target.value)}
                              style={{ width: '100%' }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button type="button" className="btn btn-primary field-sm" onClick={() => saveOutcomeEdit(o.id)}>
                                Save
                              </button>
                              <button type="button" className="btn field-sm" onClick={() => setEditingOutcomeId(null)}>
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontWeight: 600, width: 100 }}>{o.code}</td>
                          <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{o.statement || '—'}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button type="button" className="btn field-sm" disabled={poBusy} onClick={() => startEditOutcome(o)}>
                                Edit
                              </button>
                              <button type="button" className="btn field-sm" disabled={poBusy} onClick={() => deleteDeptOutcome(o.id)}>
                                Del
                              </button>
                            </div>
                          </td>
                        </tr>
                      ),
                    )}
                </tbody>
              </table>
            )}

            <form
              onSubmit={(e) => addDeptOutcome(e, 'PO')}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'flex-end',
                padding: 16,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              <label className="field-label">
                Code
                <input
                  className="field mono"
                  value={poCode}
                  onChange={(e) => setPoCode(e.target.value)}
                  placeholder="PO1"
                  style={{ width: 100 }}
                />
              </label>
              <label className="field-label" style={{ flex: '1 1 260px' }}>
                Statement
                <input
                  className="field"
                  value={poStmt}
                  onChange={(e) => setPoStmt(e.target.value)}
                  placeholder="Engineering knowledge"
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={poBusy}>
                Add PO
              </button>
            </form>
          </section>

          {/* Section 2: Programme Specific Outcomes (PSOs) */}
          <section>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 12 }}>
              Programme Specific Outcomes (PSOs)
            </h2>

            {deptOutcomes.filter((o) => o.kind === 'PSO').length === 0 ? (
              <div style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: '0.86rem', marginBottom: 12 }}>
                No PSOs listed yet. Add your department&apos;s PSOs below (e.g. PSO1, PSO2).
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem', marginBottom: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Code', 'Statement', 'Actions'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 2 ? 'right' : 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deptOutcomes
                    .filter((o) => o.kind === 'PSO')
                    .map((o) =>
                      editingOutcomeId === o.id ? (
                        <tr key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px', width: 100 }}>
                            <input
                              className="field field-sm mono"
                              value={editOutcomeCode}
                              onChange={(e) => setEditOutcomeCode(e.target.value)}
                              style={{ width: 84 }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input
                              className="field field-sm"
                              value={editOutcomeStmt}
                              onChange={(e) => setEditOutcomeStmt(e.target.value)}
                              style={{ width: '100%' }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button type="button" className="btn btn-primary field-sm" onClick={() => saveOutcomeEdit(o.id)}>
                                Save
                              </button>
                              <button type="button" className="btn field-sm" onClick={() => setEditingOutcomeId(null)}>
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontWeight: 600, width: 100 }}>{o.code}</td>
                          <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{o.statement || '—'}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button type="button" className="btn field-sm" disabled={poBusy} onClick={() => startEditOutcome(o)}>
                                Edit
                              </button>
                              <button type="button" className="btn field-sm" disabled={poBusy} onClick={() => deleteDeptOutcome(o.id)}>
                                Del
                              </button>
                            </div>
                          </td>
                        </tr>
                      ),
                    )}
                </tbody>
              </table>
            )}

            <form
              onSubmit={(e) => addDeptOutcome(e, 'PSO')}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'flex-end',
                padding: 16,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              <label className="field-label">
                Code
                <input
                  className="field mono"
                  value={psoCode}
                  onChange={(e) => setPsoCode(e.target.value)}
                  placeholder="PSO1"
                  style={{ width: 100 }}
                />
              </label>
              <label className="field-label" style={{ flex: '1 1 260px' }}>
                Statement
                <input
                  className="field"
                  value={psoStmt}
                  onChange={(e) => setPsoStmt(e.target.value)}
                  placeholder="Programme specific outcome description"
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={poBusy}>
                Add PSO
              </button>
            </form>
          </section>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <span style={{ fontSize: '0.84rem', color: 'var(--muted)' }}>
              {outcomesDirty
                ? 'Unsaved changes. Click Save and approve to publish to faculty CO–PO matrices.'
                : `${deptOutcomes.length} outcomes registered.`}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={poBusy}
              onClick={() => void saveAndApproveOutcomes()}
            >
              {poBusy ? 'Saving…' : 'Save and approve'}
            </button>
          </div>
        </div>
      )}

      {/* ── Academic calendar ── */}
      {tab === 'calendar' && (
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ fontSize: '1.35rem', fontWeight: 700 }}>Academic calendar</h1>
              <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginTop: 4 }}>
                Define term dates, Saturday rules, internal exams, and holidays. Once approved, faculty session plans skip all non-instructional days automatically.
              </p>
            </div>
            <span
              className="mono"
              style={{
                fontSize: '0.8rem',
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: calApproved ? '#DCEBE6' : 'var(--surface)',
                color: calApproved ? '#0E5E52' : 'var(--muted)',
              }}
            >
              {calApproved ? 'Approved · Live for faculty' : calId ? 'Draft saved' : 'Not saved yet'}
            </span>
          </div>

          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 12,
              padding: 16,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
            }}
          >
            <label className="field-label">
              First working day
              <input
                className="field mono"
                type="date"
                value={calFirstDay}
                onChange={(e) => setCalFirstDay(e.target.value)}
              />
            </label>
            <label className="field-label">
              Last working day
              <input
                className="field mono"
                type="date"
                value={calLastDay}
                onChange={(e) => setCalLastDay(e.target.value)}
              />
            </label>
            <label className="field-label">
              Expected end-sem starting date
              <input
                className="field mono"
                type="date"
                value={calEndsemDate}
                onChange={(e) => setCalEndsemDate(e.target.value)}
              />
            </label>
            <label className="field-label">
              Saturday holiday marks
              <select
                className="field"
                value={calSatRule}
                onChange={(e) => setCalSatRule(e.target.value as SaturdayRule)}
              >
                <option value="all">All Saturdays holiday</option>
                <option value="odd">Odd Saturdays holiday (1st, 3rd, 5th)</option>
                <option value="even">Even Saturdays holiday (2nd, 4th)</option>
                <option value="none">All Saturdays working</option>
              </select>
            </label>
          </section>

          <section>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 12 }}>
              Internal exams, regional/local holidays & other non-class days
            </h2>

            {calEvents.length === 0 ? (
              <div style={{ padding: 16, border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: '0.86rem', marginBottom: 12 }}>
                No exam days or holidays added yet. Add dates below.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem', marginBottom: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Date', 'Category', 'Description', 'Actions'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 3 ? 'right' : 'left', padding: '6px 12px', color: 'var(--muted)', fontWeight: 500 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calEvents.map((ev) =>
                    editingEvId === ev.id ? (
                      <tr key={ev.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px' }}>
                          <input
                            className="field field-sm mono"
                            type="date"
                            value={editEvDay}
                            onChange={(e) => setEditEvDay(e.target.value)}
                          />
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <select
                            className="field field-sm"
                            value={editEvKind}
                            onChange={(e) => setEditEvKind(e.target.value as CalendarEventKind)}
                          >
                            {Object.entries(CAL_EVENT_LABELS).map(([k, lbl]) => (
                              <option key={k} value={k}>
                                {lbl}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <input
                            className="field field-sm"
                            value={editEvLabel}
                            onChange={(e) => setEditEvLabel(e.target.value)}
                            style={{ width: '100%' }}
                          />
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button type="button" className="btn btn-primary field-sm" onClick={() => saveCalEventEdit(ev.id)}>
                              Save
                            </button>
                            <button type="button" className="btn field-sm" onClick={() => setEditingEvId(null)}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={ev.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)' }}>{ev.day}</td>
                        <td style={{ padding: '10px 12px', fontSize: '0.82rem' }}>
                          {ev.event_type ? `${ev.event_type}` : CAL_EVENT_LABELS[ev.kind]}
                          {ev.no_attendance ? (
                            <span
                              className="mono"
                              style={{
                                marginLeft: 8,
                                fontSize: '0.7rem',
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: '#FCE8D5',
                                color: '#9A3412',
                              }}
                            >
                              No-attendance
                            </span>
                          ) : null}
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>{ev.label}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button type="button" className="btn field-sm" disabled={calBusy} onClick={() => startEditCalEvent(ev)}>
                              Edit
                            </button>
                            <button type="button" className="btn field-sm" disabled={calBusy} onClick={() => deleteCalEvent(ev.id)}>
                              Del
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}

            <form
              ref={calEventFormRef}
              onSubmit={addCalendarEvent}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 16,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                <label className="field-label">
                  From
                  <input
                    className="field mono"
                    type="date"
                    value={calEvDay}
                    onChange={(e) => setCalEvDay(e.target.value)}
                  />
                </label>
                <label className="field-label">
                  To (optional)
                  <input
                    className="field mono"
                    type="date"
                    min={calEvDay || undefined}
                    value={calEvEndDay}
                    onChange={(e) => setCalEvEndDay(e.target.value)}
                  />
                </label>
                <label className="field-label">
                  Category
                  <select
                    className="field"
                    value={calEvKind}
                    onChange={(e) => setCalEvKind(e.target.value as CalendarEventKind)}
                  >
                    {Object.entries(CAL_EVENT_LABELS).map(([k, lbl]) => (
                      <option key={k} value={k}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                </label>
                {calEvKind === 'academic_event' && (
                  <label className="field-label">
                    Event type
                    <select
                      className="field"
                      value={calEvTypePreset}
                      onChange={(e) => setCalEvTypePreset(e.target.value)}
                    >
                      {ACADEMIC_EVENT_PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p === 'Other' ? 'Other (type custom)' : p}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {calEvKind === 'academic_event' && calEvTypePreset === 'Other' && (
                  <label className="field-label">
                    Custom event type
                    <input
                      className="field"
                      value={calEvCustomType}
                      onChange={(e) => setCalEvCustomType(e.target.value)}
                      placeholder="e.g. Tech Fest"
                    />
                  </label>
                )}
                <label className="field-label" style={{ flex: '1 1 240px' }}>
                  Event name / Description
                  <input
                    className="field"
                    value={calEvLabel}
                    onChange={(e) => setCalEvLabel(e.target.value)}
                    placeholder="Smart India Hackathon / Mid-sem internal exam / Regional holiday"
                  />
                </label>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.86rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={calEvNoAttendance}
                    onChange={(e) => setCalEvNoAttendance(e.target.checked)}
                  />
                  <span>
                    Declare <strong>No-attendance day</strong> (overrides scheduled classes/labs &amp; notifies faculty, students, Dean, CoE, VC)
                  </span>
                </label>
                <div style={{ display: 'inline-flex', gap: 8 }}>
                  <button type="submit" className="btn" disabled={calBusy}>
                    Add to list
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={calBusy}
                    onClick={() => void declareEventLive()}
                  >
                    {calBusy ? 'Declaring…' : calEvNoAttendance ? 'Declare No-attendance & notify' : 'Add event live'}
                  </button>
                </div>
              </div>
            </form>
          </section>

          {/* Unified Academic & Meetings Calendar */}
          <InteractiveAcademicCalendar
            title={`Academic calendar & meetings ${calApproved ? '· Approved' : '· Preview'}`}
            events={calEvents}
            firstWorkingDay={calFirstDay}
            lastWorkingDay={calLastDay}
            expectedEndsemDate={calEndsemDate}
            saturdayRule={calSatRule}
            initialMonth={calFirstDay ? calFirstDay.slice(0, 7) : undefined}
            onSelectDateForEvent={(iso) => {
              setCalEvDay(iso);
              setCalEvEndDay(iso);
              setNotice(`Selected ${iso} in the event form above. Choose category/event type and click Add event live.`);
              calEventFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          />

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
            }}
          >
            <button
              type="button"
              className="btn"
              disabled={calBusy}
              onClick={() => void saveAcademicCalendar(false)}
            >
              {calBusy ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={calBusy}
              onClick={() => void saveAcademicCalendar(true)}
            >
              {calBusy ? 'Saving…' : 'Save and approve'}
            </button>
          </div>
        </div>
      )}

      {/* ── Feedback loop ── */}
      {tab === 'feedback' && <FeedbackLoopTab departmentId={hodDeptId} />}

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
      <Modal
        open={Boolean(previewCourseId)}
        title={previewData ? `Course plan preview · ${previewData.course.code} — ${previewData.course.title}` : 'Course plan preview'}
        onClose={() => setPreviewCourseId(null)}
      >
        {previewLoading ? (
          <div style={{ padding: 16, color: 'var(--muted)' }}>Loading course plan…</div>
        ) : previewData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, fontSize: 13, padding: 12, borderRadius: 6, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <div><span style={{ color: 'var(--muted)' }}>Faculty:</span> <strong>{previewData.course.faculty_name}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Department:</span> <strong>{previewData.course.department_name || '—'}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>L-T-P-C:</span> <strong className="mono">{previewData.course.ltpc}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Programme:</span> <strong>{previewData.course.programme} · Sem {previewData.course.semester} ({previewData.course.section})</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Academic year:</span> <strong className="mono">{previewData.course.academic_year}</strong></div>
              <div><span style={{ color: 'var(--muted)' }}>Languages:</span> <strong className="mono">{(previewData.course.allowed_langs ?? []).join(', ')}</strong></div>
            </div>

            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Course Outcomes ({previewData.outcomes.length})</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--muted)' }}>CO</th>
                    <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--muted)' }}>Unit</th>
                    <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--muted)' }}>BTL</th>
                    <th style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--muted)' }}>Statement</th>
                  </tr>
                </thead>
                <tbody>
                  {previewData.outcomes.map((o) => (
                    <tr key={o.id} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <td className="mono" style={{ padding: '6px 8px', fontWeight: 600 }}>{o.code}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>U{o.unit}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>L{o.btl}</td>
                      <td style={{ padding: '6px 8px' }}>{o.statement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(() => {
              const mappedPos = Array.from(new Set(previewData.co_po_map.map((m) => m.po_code))).sort((a, b) =>
                a.localeCompare(b, undefined, { numeric: true }),
              );
              const lookup = new Map(previewData.co_po_map.map((m) => [`${m.co_id}:${m.po_code}`, m.level]));
              return mappedPos.length > 0 ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>CO–PO / PSO Map</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--muted)' }}>CO</th>
                          {mappedPos.map((po) => (
                            <th key={po} className="mono" style={{ textAlign: 'center', padding: '4px 6px', color: 'var(--muted)' }}>{po}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.outcomes.map((o) => (
                          <tr key={o.id} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                            <td className="mono" style={{ padding: '4px 8px', fontWeight: 600 }}>{o.code}</td>
                            {mappedPos.map((po) => (
                              <td key={po} className="mono" style={{ textAlign: 'center', padding: '4px 6px' }}>
                                {lookup.get(`${o.id}:${po}`) ?? '·'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null;
            })()}

            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Marking rubric (50 raw, reported /100)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
                {[
                  ['Attendance', previewData.course.rubric.att ?? 0],
                  ['Pre-test', previewData.course.rubric.pre ?? 0],
                  ['Post-test', previewData.course.rubric.post ?? 0],
                  ['Visible tests', previewData.course.rubric.vis ?? 0],
                  ['Hidden tests', previewData.course.rubric.hid ?? 0],
                  ['Viva', previewData.course.rubric.viva ?? 0],
                ].map(([label, val]) => (
                  <span key={String(label)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    {label}: <strong className="mono">{val}</strong>
                  </span>
                ))}
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#92400e' }}>Assist review</div>
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={aiReviewLoading}
                  onClick={() => void runAiPlanReview(previewData.course.id)}
                >
                  {aiReviewLoading ? 'Reviewing with Assist…' : 'Review with Assist'}
                </button>
              </div>
              {aiReview ? (
                <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>
                    <strong>Verdict:</strong>{' '}
                    <span style={{ fontWeight: 600, color: aiReview.verdict === 'approve' ? '#15803d' : '#b45309' }}>
                      {aiReview.verdict === 'approve' ? 'Ready to approve' : 'Revisions suggested'}
                    </span>{' '}
                    — {aiReview.summary}
                  </div>
                  {aiReview.strengths.length > 0 ? (
                    <div><strong>Strengths:</strong> {aiReview.strengths.join(' · ')}</div>
                  ) : null}
                  {aiReview.gaps.length > 0 ? (
                    <div><strong>Gaps / suggestions:</strong> {aiReview.gaps.join(' · ')}</div>
                  ) : null}
                  {aiReview.suggested_remark ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span><strong>Suggested remark:</strong> {aiReview.suggested_remark}</span>
                      <button
                        type="button"
                        className="btn field-sm"
                        onClick={() =>
                          setPlanRemark((prev) => ({
                            ...prev,
                            [previewData.course.id]: aiReview.suggested_remark,
                          }))
                        }
                      >
                        Use as decline remark
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#92400e' }}>
                  Click &ldquo;Review with Assist&rdquo; to check CO clarity, Bloom level progression, CO–PO coverage, and rubric compliance.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <input
                type="text"
                className="field"
                placeholder="Remark (required to decline)"
                value={planRemark[previewData.course.id] ?? ''}
                onChange={(e) =>
                  setPlanRemark((prev) => ({ ...prev, [previewData.course.id]: e.target.value }))
                }
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setPreviewCourseId(null)}>
                  Close
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={approvingId === previewData.course.id}
                  onClick={() => void decidePlan(previewData.course.id, previewData.course.code, false)}
                >
                  Decline with remarks
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={approvingId === previewData.course.id}
                  onClick={() => void decidePlan(previewData.course.id, previewData.course.code, true)}
                >
                  {approvingId === previewData.course.id ? 'Approving…' : 'Approve course plan'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </ConsoleShell>
  );
}
