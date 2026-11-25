import type { Page } from '@playwright/test';
import {
  applyPostgrestFilters,
  createPhase4State,
  handlePhase4Edge,
  handlePhase4Rest,
  handlePhase4Rpc,
  istTodayIso,
} from './mockLabRun';
import {
  addDaysIso,
  augmentPhase4ForReports,
  createPhase5State,
  handlePhase5Edge,
  handlePhase5Rest,
  handlePhase5Rpc,
  handlePhase5Storage,
} from './mockClassroomReports';

export interface MockProfile {
  id: string;
  institution_id: string | null;
  email: string;
  full_name: string;
  role: 'super_admin' | 'vc' | 'coe' | 'dean' | 'hod' | 'faculty' | 'student';
  school_id: string | null;
  department_id: string | null;
  roll_no: string | null;
  active: boolean;
  plan_override: 'pro' | 'elite' | null;
  calendar_token: string;
  created_at: string;
}

export interface MockOptions {
  sessionProfile: MockProfile | null;
  preflightMap?: Record<string, string>;
  emptyAdmin?: boolean;
  emptyCourses?: boolean;
  coursePlanStatus?: 'draft' | 'sent' | 'approved' | 'declined';
  finalStatus?: 'none' | 'sent' | 'hod_approved' | 'coe_accepted' | 'returned';
  seedPrep?: boolean;
  seedRun?: boolean | 'pending_attendance' | 'live';
  seedClassroomReports?: boolean;
  aiFailAfter?: { calls: number; error: string };
}

export const SAMPLE_INST = {
  id: '10000000-0000-0000-0000-000000000001',
  name: 'Sanjivani University',
  email_domain: 'sanjivani.edu.in',
  plan: 'pro',
  plan_start: '2027-01-04',
  plan_end: '2027-07-03',
  min_attendance_pct: 75,
  attainment_threshold_pct: 60,
  level_1_pct: 60,
  level_2_pct: 70,
  level_3_pct: 80,
  internal_weight: 0.4,
  endsem_weight: 0.6,
  created_at: '2026-11-25T08:00:00Z',
};

export const SAMPLE_SCHOOLS = [
  {
    id: '20000000-0000-0000-0000-000000000001',
    institution_id: SAMPLE_INST.id,
    name: 'School of Engineering and Technology',
    dean_id: null,
  },
  {
    id: '20000000-0000-0000-0000-000000000002',
    institution_id: SAMPLE_INST.id,
    name: 'School of Commerce and Management',
    dean_id: null,
  },
];

export const SAMPLE_DEPTS = [
  {
    id: '30000000-0000-0000-0000-000000000001',
    institution_id: SAMPLE_INST.id,
    school_id: SAMPLE_SCHOOLS[0]!.id,
    code: 'CSE',
    name: 'Computer Science and Engineering',
    hod_id: null,
  },
  {
    id: '30000000-0000-0000-0000-000000000002',
    institution_id: SAMPLE_INST.id,
    school_id: SAMPLE_SCHOOLS[0]!.id,
    code: 'IT',
    name: 'Information Technology',
    hod_id: null,
  },
];

export const SAMPLE_COURSE_ID = '40000000-0000-0000-0000-000000000001';

export function makeProfile(
  role: MockProfile['role'],
  overrides: Partial<MockProfile> = {},
): MockProfile {
  return {
    id: `uid-${role}`,
    institution_id: role === 'super_admin' ? null : SAMPLE_INST.id,
    email: `${role}.demo@sanjivani.edu.in`,
    full_name: `Demo ${role.toUpperCase()}`,
    role,
    school_id: role === 'dean' || role === 'hod' || role === 'faculty' ? SAMPLE_SCHOOLS[0]!.id : null,
    department_id: role === 'hod' || role === 'faculty' ? SAMPLE_DEPTS[0]!.id : null,
    roll_no: role === 'student' ? '2301034' : null,
    active: true,
    plan_override: null,
    calendar_token: '44444444-4444-4444-4444-444444444444',
    created_at: '2026-11-25T08:00:00Z',
    ...overrides,
  };
}

export async function setupSupabaseMocks(page: Page, opts: MockOptions) {
  let currentSessionProfile = opts.sessionProfile;
  const isPhase5 = Boolean(opts.seedClassroomReports);
  const effectiveSeedPrep = Boolean(opts.seedPrep || isPhase5);
  const effectiveSeedRun = opts.seedRun ?? (isPhase5 ? 'live' : false);

  await page.addInitScript((prof) => {
    const keys = ['sb-127-auth-token', 'sb-e2e-auth-token'];
    if (!prof) {
      for (const k of keys) window.localStorage.removeItem(k);
      return;
    }
    const payload = JSON.stringify({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: {
        id: prof.id,
        email: prof.email,
        aud: 'authenticated',
        role: 'authenticated',
      },
    });
    for (const k of keys) window.localStorage.setItem(k, payload);
  }, opts.sessionProfile);

  await page.route('**/auth/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/logout')) {
      currentSessionProfile = null;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (url.includes('/otp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
      return;
    }
    if (url.includes('/user')) {
      if (!currentSessionProfile) {
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: currentSessionProfile.id,
          email: currentSessionProfile.email,
          aud: 'authenticated',
          role: 'authenticated',
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const adminProfiles: MockProfile[] = opts.emptyAdmin
    ? currentSessionProfile
      ? [currentSessionProfile]
      : []
    : [
        makeProfile('super_admin', { id: 'uid-super_admin', email: 'superadmin@sanjivani.edu.in', full_name: 'Super Admin' }),
        makeProfile('vc', { email: 'vc@sanjivani.edu.in', full_name: 'Vice-Chancellor' }),
        makeProfile('coe', { email: 'coe@sanjivani.edu.in', full_name: 'Controller of Examinations' }),
        makeProfile('dean', { email: 'dean.set@sanjivani.edu.in', full_name: 'Dean, SET' }),
        makeProfile('hod', { email: 'hod.cse@sanjivani.edu.in', full_name: 'HOD, CSE' }),
        makeProfile('faculty', { email: 'faculty.demo@sanjivani.edu.in', full_name: 'Demo Faculty' }),
        makeProfile('student', { id: 'uid-student-1', email: 's1@sanjivani.edu.in', full_name: 'Aarav Patil', roll_no: '2301001' }),
        ...(effectiveSeedRun
          ? [
              makeProfile('student', { id: 'uid-student-2', email: 's2@sanjivani.edu.in', full_name: 'Diya Kulkarni', roll_no: '2301002' }),
              makeProfile('student', { id: 'uid-student-3', email: 's3@sanjivani.edu.in', full_name: 'Rohan Deshmukh', roll_no: '2301003' }),
            ]
          : []),
      ];

  const invites = opts.emptyAdmin
    ? []
    : [
        {
          id: 'inv-1',
          email: 'faculty.h@sanjivani.edu.in',
          institution_id: SAMPLE_INST.id,
          role: 'faculty',
          full_name: 'Faculty H',
          school_id: SAMPLE_SCHOOLS[0]!.id,
          department_id: SAMPLE_DEPTS[0]!.id,
          roll_no: null,
          created_at: '2026-11-24T09:00:00Z',
          accepted_at: null,
        },
      ];

  const plans = [
    { tier: 'pro', total_cap: 125, daily_cap: 5 },
    { tier: 'elite', total_cap: 250, daily_cap: 7 },
  ];

  const requests = opts.emptyAdmin
    ? []
    : [
        {
          id: 'req-1',
          institution_id: SAMPLE_INST.id,
          requested_by: 'uid-hod',
          scope_label: 'CSE department · 8 faculty',
          plan: 'pro',
          start_date: '2027-01-04',
          months: 6,
          status: 'approved',
          decided_by: 'uid-super_admin',
          decided_at: '2026-11-24T10:00:00Z',
          created_at: '2026-11-24T09:00:00Z',
        },
        {
          id: 'req-2',
          institution_id: SAMPLE_INST.id,
          requested_by: 'uid-faculty',
          scope_label: 'IT department · 6 faculty',
          plan: 'elite',
          start_date: '2027-03-01',
          months: 12,
          status: 'sent',
          decided_by: null,
          decided_at: null,
          created_at: '2026-11-25T09:00:00Z',
        },
      ];

  const credits = opts.emptyAdmin
    ? []
    : [
        {
          user_id: 'uid-faculty',
          full_name: 'Demo Faculty',
          email: 'faculty.demo@sanjivani.edu.in',
          institution_id: SAMPLE_INST.id,
          institution_name: SAMPLE_INST.name,
          tier: 'pro',
          plan_end: '2027-07-03',
          total_cap: 125,
          daily_cap: 5,
          total_used: 38,
          today_used: 3,
          plan_active: true,
        },
        {
          user_id: 'uid-hod',
          full_name: 'HOD, CSE',
          email: 'hod.cse@sanjivani.edu.in',
          institution_id: SAMPLE_INST.id,
          institution_name: SAMPLE_INST.name,
          tier: 'pro',
          plan_end: '2027-07-03',
          total_cap: 125,
          daily_cap: 5,
          total_used: 112,
          today_used: 2,
          plan_active: true,
        },
        {
          user_id: 'uid-fac-b',
          full_name: 'Faculty B',
          email: 'faculty.b@sanjivani.edu.in',
          institution_id: SAMPLE_INST.id,
          institution_name: SAMPLE_INST.name,
          tier: 'pro',
          plan_end: '2027-07-03',
          total_cap: 125,
          daily_cap: 5,
          total_used: 80,
          today_used: 5,
          plan_active: true,
        },
      ];

  const audit = opts.emptyAdmin
    ? []
    : [
        {
          id: 'aud-1',
          at: '2026-11-25T09:15:00Z',
          action: 'approve_subscription',
          object_type: 'subscription_request',
          object_id: 'req-1',
          actor_name: 'Super Admin',
          actor_role: 'super_admin',
          actor_email: 'superadmin@sanjivani.edu.in',
          detail: { plan: 'pro', months: 6 },
        },
      ];

  const courses = opts.emptyCourses
    ? []
    : [
        {
          id: SAMPLE_COURSE_ID,
          institution_id: SAMPLE_INST.id,
          department_id: SAMPLE_DEPTS[0]!.id,
          faculty_id: 'uid-faculty',
          code: 'CSL-101',
          title: 'Programming in C Lab',
          ltpc: '0-0-2-1',
          programme: 'B.Tech',
          semester: 'IV',
          section: 'SY-B',
          academic_year: '2026-27',
          plan_status: opts.coursePlanStatus ?? 'draft',
          plan_remark: null,
          rubric: { att: 10, pre: 5, post: 5, vis: 10, hid: 10, viva: 10 },
          allowed_langs: ['c', 'cpp', 'java', 'python', 'rust', 'go'],
          attainment_target: 60,
          final_status: opts.finalStatus ?? 'none',
          created_at: '2026-11-25T08:30:00Z',
        },
      ];

  const outcomes = opts.emptyCourses
    ? []
    : [
        {
          id: 'co-1',
          course_id: SAMPLE_COURSE_ID,
          institution_id: SAMPLE_INST.id,
          code: 'CO1',
          statement: 'Write C programs using I/O, operators and decisions',
          btl: 3,
          unit: 1,
        },
        {
          id: 'co-2',
          course_id: SAMPLE_COURSE_ID,
          institution_id: SAMPLE_INST.id,
          code: 'CO2',
          statement: 'Design modular functions and pointer algorithms',
          btl: 4,
          unit: 4,
        },
      ];

  const coPoMap = opts.emptyCourses
    ? []
    : [
        { id: 'm-1', course_id: SAMPLE_COURSE_ID, institution_id: SAMPLE_INST.id, co_id: 'co-1', po_code: 'PO1', level: 3 },
        { id: 'm-2', course_id: SAMPLE_COURSE_ID, institution_id: SAMPLE_INST.id, co_id: 'co-2', po_code: 'PO2', level: 3 },
      ];

  const batches = opts.emptyCourses
    ? []
    : [
        {
          id: 'batch-a',
          course_id: SAMPLE_COURSE_ID,
          institution_id: SAMPLE_INST.id,
          name: 'Batch A',
          class_code: 'CS7Q4K',
          slot: 'Wed 10:00-12:00',
          room: 'Lab 3',
          staff: 'Demo Faculty + TA 1',
          created_at: '2026-11-25T08:35:00Z',
        },
        {
          id: 'batch-b',
          course_id: SAMPLE_COURSE_ID,
          institution_id: SAMPLE_INST.id,
          name: 'Batch B',
          class_code: 'CS8R5M',
          slot: 'Wed 14:00-16:00',
          room: 'Lab 4',
          staff: 'Demo Faculty + TA 2',
          created_at: '2026-11-25T08:35:00Z',
        },
      ];

  const enrollments = opts.emptyCourses
    ? []
    : [
        {
          id: 'enr-1',
          course_id: SAMPLE_COURSE_ID,
          batch_id: 'batch-a',
          institution_id: SAMPLE_INST.id,
          student_id: 'uid-student-1',
          created_at: '2026-11-25T08:40:00Z',
        },
        ...(effectiveSeedRun
          ? [
              {
                id: 'enr-2',
                course_id: SAMPLE_COURSE_ID,
                batch_id: 'batch-a',
                institution_id: SAMPLE_INST.id,
                student_id: 'uid-student-2',
                created_at: '2026-11-25T08:40:01Z',
              },
              {
                id: 'enr-3',
                course_id: SAMPLE_COURSE_ID,
                batch_id: 'batch-a',
                institution_id: SAMPLE_INST.id,
                student_id: 'uid-student-3',
                created_at: '2026-11-25T08:40:02Z',
              },
            ]
          : []),
      ];

  const pendingEnrollments = opts.emptyCourses
    ? []
    : [
        {
          id: 'pen-1',
          course_id: SAMPLE_COURSE_ID,
          batch_id: 'batch-b',
          institution_id: SAMPLE_INST.id,
          email: 's64@sanjivani.edu.in',
          roll_no: '2301064',
          full_name: 'Student 64',
          created_at: '2026-11-25T08:40:00Z',
        },
      ];

  const defaultTopics = [
    'Input and output',
    'Operators and expressions',
    'Type conversion',
    'if-else branching',
    'switch-case statements',
    'Nested conditions',
    'for loops',
    'while and do-while loops',
    'Nested loops',
    'Pattern programs',
    'break and continue',
    'Series sums',
    '1-D arrays',
    'Linear and binary search',
    'Bubble and selection sort',
    '2-D arrays and matrices',
    'String functions',
    'String manipulation',
    'Functions',
    'Recursion',
    'Pointer basics',
    'Pointer arithmetic',
    'Pass by reference',
    'Dynamic memory allocation',
    'Structures',
    'Array of structures',
    'Unions and enums',
    'File write operations',
    'File read operations',
    'Mini project integration',
  ];

  const todayStr = effectiveSeedRun ? istTodayIso() : '2027-01-06';

  const sessions = opts.emptyCourses
    ? []
    : defaultTopics.map((topic, i) => ({
        id: `sess-${i + 1}`,
        course_id: SAMPLE_COURSE_ID,
        institution_id: SAMPLE_INST.id,
        n: i + 1,
        topic,
        co_id: i < 15 ? 'co-1' : 'co-2',
        btl: i < 15 ? 3 : 4,
        scheduled_date: isPhase5
          ? i === 0
            ? addDaysIso(todayStr, -7)
            : i === 1
              ? todayStr
              : addDaysIso(todayStr, Math.floor(i / 2) * 7)
          : i === 0
            ? todayStr
            : '2027-01-06',
        status: isPhase5
          ? i === 0
            ? 'conducted'
            : i === 1
              ? 'active'
              : i === 2
                ? 'draft'
                : 'none'
          : effectiveSeedPrep && i === 0
            ? 'active'
            : effectiveSeedPrep && i === 1
              ? 'draft'
              : 'none',
        pre_open: null,
        pre_close: null,
        post_close: null,
        created_at: '2026-11-25T08:45:00Z',
      }));

  const holidays = [
    { id: 'hol-1', institution_id: SAMPLE_INST.id, day: '2027-01-26', label: 'Republic Day' },
  ];

  const build45MockItems = (sessionId: string, bank: 'pre' | 'post', approved: boolean, withOverlap = false) =>
    (['easy', 'medium', 'hard'] as const).flatMap((level) =>
      Array.from({ length: 15 }, (_, i) => ({
        id: `${sessionId}-${bank}-${level}-${i + 1}`,
        institution_id: SAMPLE_INST.id,
        session_id: sessionId,
        bank,
        level,
        stem:
          withOverlap && bank === 'post' && level === 'easy' && i === 0
            ? 'Precheck concept easy item 1 for session 2 readiness'
            : bank === 'pre'
              ? `Precheck concept ${level} item ${i + 1} for ${sessionId} readiness`
              : `Postverify runtime ${level} question ${i + 1} for ${sessionId} analysis`,
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        answer: 0,
        approved,
        created_at: '2026-11-25T08:50:00Z',
      })),
    );

  const questions: Array<{
    id: string;
    institution_id: string;
    course_id: string;
    kind: string;
    session_id: string;
    assessment_id: null;
    co_code: string;
    difficulty: string;
    title: string;
    statement: string;
    input_spec: string;
    output_spec: string;
    constraints: string;
    starter_code: Record<string, string>;
    status: string;
    source: string;
    valid: boolean | null;
    validation_note: string | null;
    created_by: string;
    created_at: string;
  }> =
    opts.emptyCourses || !effectiveSeedPrep
      ? []
      : [
          {
            id: 'q-s1-1',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-1',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'medium',
            title: 'Echo formatted integer pair',
            statement: 'Read two integers and print them separated by a colon.',
            input_spec: 'Two integers a b',
            output_spec: 'a:b',
            constraints: '-1000 <= a, b <= 1000',
            starter_code: {},
            status: 'approved',
            source: 'ai',
            valid: true,
            validation_note: 'Passed all 5 cases in c, cpp, java, python, rust, go',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:46:00Z',
          },
          {
            id: 'q-s1-2',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-1',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'hard',
            title: 'Right-aligned integer table',
            statement: 'Read N and print formatted values right-aligned.',
            input_spec: 'Integer N followed by N values',
            output_spec: 'Aligned rows',
            constraints: '1 <= N <= 20',
            starter_code: {},
            status: 'approved',
            source: 'ai',
            valid: true,
            validation_note: 'Passed all 5 cases in c, cpp, java, python, rust, go',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:46:01Z',
          },
          {
            id: 'q-s2-1',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-2',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'easy',
            title: 'Operators · Core exercise',
            statement: 'Compute integer quotient and remainder for a / b.',
            input_spec: 'Two positive integers a b',
            output_spec: 'q r',
            constraints: '1 <= b <= a <= 10000',
            starter_code: {},
            status: 'candidate',
            source: 'ai',
            valid: true,
            validation_note: 'Checks passed',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:47:00Z',
          },
          {
            id: 'q-s2-2',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-2',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'medium',
            title: 'Operators · Applied problem',
            statement: 'Evaluate polynomial a*x + b*y modulo m.',
            input_spec: 'Integers a b x y m',
            output_spec: 'Single integer',
            constraints: 'm >= 1',
            starter_code: {},
            status: 'candidate',
            source: 'ai',
            valid: true,
            validation_note: 'Checks passed',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:47:01Z',
          },
          {
            id: 'q-s2-3',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-2',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'hard',
            title: 'Operators · Edge-case challenge',
            statement: 'Check bitwise parity without using loops or division.',
            input_spec: 'Unsigned 32-bit integer',
            output_spec: 'even or odd',
            constraints: '0 <= n < 2^32',
            starter_code: {},
            status: 'candidate',
            source: 'ai',
            valid: true,
            validation_note: 'Checks passed',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:47:02Z',
          },
          {
            id: 'q-s2-4',
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: 'sess-2',
            assessment_id: null,
            co_code: 'CO1',
            difficulty: 'medium',
            title: 'Operators · Debug overflow case',
            statement: 'Sum 64-bit integers safely without overflow.',
            input_spec: 'Two 64-bit integers',
            output_spec: 'Sum',
            constraints: '-10^12 <= x, y <= 10^12',
            starter_code: {},
            status: 'candidate',
            source: 'ai',
            valid: false,
            validation_note: 'Fails hidden case 4 · wrong_answer',
            created_by: 'uid-faculty',
            created_at: '2026-11-25T08:47:03Z',
          },
        ];

  const testCases = questions.flatMap((q) => [
    { id: `${q.id}-tc1`, institution_id: SAMPLE_INST.id, question_id: q.id, ord: 1, input: '1 2', expected: '3', hidden: false, marks: 5 },
    { id: `${q.id}-tc2`, institution_id: SAMPLE_INST.id, question_id: q.id, ord: 2, input: '3 4', expected: '7', hidden: false, marks: 5 },
    { id: `${q.id}-tc3`, institution_id: SAMPLE_INST.id, question_id: q.id, ord: 3, input: '5 6', expected: '11', hidden: true, marks: 5 },
    { id: `${q.id}-tc4`, institution_id: SAMPLE_INST.id, question_id: q.id, ord: 4, input: '7 8', expected: '15', hidden: true, marks: 5 },
    { id: `${q.id}-tc5`, institution_id: SAMPLE_INST.id, question_id: q.id, ord: 5, input: '9 10', expected: '19', hidden: true, marks: 5 },
  ]);

  const references = questions.map((q) => ({
    id: `${q.id}-ref-c`,
    institution_id: SAMPLE_INST.id,
    question_id: q.id,
    lang: 'c',
    code: '#include <stdio.h>\nint main(){return 0;}',
  }));

  const sessionQuestions =
    opts.emptyCourses || !effectiveSeedPrep
      ? []
      : [
          { id: 'sq-1', institution_id: SAMPLE_INST.id, session_id: 'sess-1', slot: 1, question_id: 'q-s1-1' },
          { id: 'sq-2', institution_id: SAMPLE_INST.id, session_id: 'sess-1', slot: 2, question_id: 'q-s1-2' },
        ];

  const bankItems =
    opts.emptyCourses || !effectiveSeedPrep
      ? []
      : [
          ...build45MockItems('sess-1', 'pre', true, false),
          ...build45MockItems('sess-1', 'post', true, false),
          ...build45MockItems('sess-2', 'pre', false, false),
          ...build45MockItems('sess-2', 'post', false, true),
        ];

  const phase4State = createPhase4State(SAMPLE_INST.id, SAMPLE_COURSE_ID, effectiveSeedRun);
  if (isPhase5) {
    augmentPhase4ForReports(SAMPLE_INST.id, SAMPLE_COURSE_ID, phase4State);
  }
  const phase5State = createPhase5State(SAMPLE_INST.id, SAMPLE_COURSE_ID, isPhase5);
  let aiCallCount = 0;

  await page.route('**/storage/v1/**', async (route) => {
    const handled = await handlePhase5Storage(route);
    if (!handled) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
  });

  await page.route('**/functions/v1/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes('/functions/v1/calendar')) {
      const handledCal = await handlePhase5Edge(route, url, {}, aiCallCount);
      if (handledCal) return;
    }

    if (url.endsWith('/ai-generate')) {
      aiCallCount++;
      if (opts.aiFailAfter && aiCallCount > opts.aiFailAfter.calls) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: opts.aiFailAfter.error }),
        });
        return;
      }

      const body = req.postDataJSON() as { kind?: string; session_id?: string };
      if (await handlePhase5Edge(route, url, body as Record<string, unknown>, aiCallCount)) {
        return;
      }
      if (body.kind === 'lab_candidates' && body.session_id) {
        const sid = body.session_id;
        const newIds: string[] = [];
        ['easy', 'medium', 'hard', 'medium'].forEach((diff, idx) => {
          const qid = `q-${sid}-ai-${idx + 1}`;
          newIds.push(qid);
          questions.push({
            id: qid,
            institution_id: SAMPLE_INST.id,
            course_id: SAMPLE_COURSE_ID,
            kind: 'lab',
            session_id: sid,
            assessment_id: null,
            co_code: 'CO1',
            difficulty: diff,
            title: `Assist draft ${idx + 1} (${diff})`,
            statement: `Generated task ${idx + 1} for ${sid}.`,
            input_spec: 'Standard input',
            output_spec: 'Standard output',
            constraints: '1 <= n <= 1000',
            starter_code: {},
            status: 'candidate',
            source: 'ai',
            valid: true,
            validation_note: 'Passed all 5 cases',
            created_by: 'uid-faculty',
            created_at: new Date().toISOString(),
          });
          testCases.push(
            { id: `${qid}-tc1`, institution_id: SAMPLE_INST.id, question_id: qid, ord: 1, input: '1', expected: '1', hidden: false, marks: 5 },
            { id: `${qid}-tc2`, institution_id: SAMPLE_INST.id, question_id: qid, ord: 2, input: '2', expected: '2', hidden: false, marks: 5 },
            { id: `${qid}-tc3`, institution_id: SAMPLE_INST.id, question_id: qid, ord: 3, input: '3', expected: '3', hidden: true, marks: 5 },
            { id: `${qid}-tc4`, institution_id: SAMPLE_INST.id, question_id: qid, ord: 4, input: '4', expected: '4', hidden: true, marks: 5 },
            { id: `${qid}-tc5`, institution_id: SAMPLE_INST.id, question_id: qid, ord: 5, input: '5', expected: '5', hidden: true, marks: 5 },
          );
          references.push({
            id: `${qid}-ref-c`,
            institution_id: SAMPLE_INST.id,
            question_id: qid,
            lang: 'c',
            code: 'int main(){return 0;}',
          });
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ question_ids: newIds, run_id: `run-${aiCallCount}` }),
        });
        return;
      }

      if (body.kind === 'bank' && body.session_id) {
        const sid = body.session_id;
        for (let i = bankItems.length - 1; i >= 0; i--) {
          if (bankItems[i]!.session_id === sid) bankItems.splice(i, 1);
        }
        bankItems.push(
          ...build45MockItems(sid, 'pre', false, false),
          ...build45MockItems(sid, 'post', false, false),
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 90, run_id: `run-${aiCallCount}` }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'run-1',
          draft: {
            outcomes: [
              { code: 'CO1', statement: 'Apply C fundamentals to solve numeric problems', btl: 3, unit: 1 },
              { code: 'CO2', statement: 'Analyse arrays and pointer programs', btl: 4, unit: 3 },
            ],
            map: [
              { co: 'CO1', po: 'PO1', level: 3 },
              { co: 'CO2', po: 'PO2', level: 2 },
            ],
          },
        }),
      });
      return;
    }

    if (url.endsWith('/validate-question')) {
      const body = req.postDataJSON() as { question_id?: string };
      const target = questions.find((q) => q.id === body.question_id);
      if (target) {
        target.valid = true;
        target.validation_note = 'Passed all 5 cases';
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, validation_note: 'Passed all 5 cases' }),
      });
      return;
    }

    const handledEdge = await handlePhase4Edge(
      route,
      url,
      (req.postDataJSON() ?? {}) as Record<string, unknown>,
      {
        instId: SAMPLE_INST.id,
        courseId: SAMPLE_COURSE_ID,
        actorId: currentSessionProfile?.id ?? 'uid-student-1',
        state: phase4State,
        testCases,
      },
    );
    if (handledEdge) return;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const accept = req.headers()['accept'] ?? '';
    const isSingle = accept.includes('vnd.pgrst.object+json');

    if (path.endsWith('/rpc/preflight_sign_in')) {
      const body = req.postDataJSON() as { p_email?: string };
      const email = (body.p_email ?? '').trim().toLowerCase();
      const mapped = opts.preflightMap?.[email] ?? 'ok';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mapped),
      });
      return;
    }

    if (path.endsWith('/rpc/ai_usage')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            tier: 'pro',
            plan_start: '2027-01-04',
            plan_end: '2027-07-03',
            total_cap: 125,
            daily_cap: 5,
            total_used: 38,
            today_used: 3,
            plan_active: true,
          },
        ]),
      });
      return;
    }

    if (path.endsWith('/rpc/ai_usage_report')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(credits) });
      return;
    }

    if (path.endsWith('/rpc/admin_audit_feed')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(audit) });
      return;
    }

    if (path.endsWith('/rpc/create_course')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_COURSE_ID) });
      return;
    }

    if (path.endsWith('/rpc/submit_course_plan')) {
      if (courses[0]) courses[0].plan_status = 'sent';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
      return;
    }

    if (path.endsWith('/rpc/decide_course_plan')) {
      const body = req.postDataJSON() as { p_approve?: boolean; p_remark?: string | null };
      if (!body.p_approve && !(body.p_remark ?? '').trim()) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'remark_required' }),
        });
        return;
      }
      if (courses[0]) {
        courses[0].plan_status = body.p_approve ? 'approved' : 'declined';
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
      return;
    }

    if (path.endsWith('/rpc/import_roster')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { batch_id: 'batch-a', batch_name: 'Batch A', class_code: 'CS7Q4K', student_count: 63 },
          { batch_id: 'batch-b', batch_name: 'Batch B', class_code: 'CS8R5M', student_count: 63 },
        ]),
      });
      return;
    }

    if (path.endsWith('/rpc/pick_session_questions')) {
      const body = req.postDataJSON() as { p_session_id: string; p_q1: string; p_q2: string };
      for (let i = sessionQuestions.length - 1; i >= 0; i--) {
        if (sessionQuestions[i]!.session_id === body.p_session_id) sessionQuestions.splice(i, 1);
      }
      sessionQuestions.push(
        { id: `sq-${body.p_q1}`, institution_id: SAMPLE_INST.id, session_id: body.p_session_id, slot: 1, question_id: body.p_q1 },
        { id: `sq-${body.p_q2}`, institution_id: SAMPLE_INST.id, session_id: body.p_session_id, slot: 2, question_id: body.p_q2 },
      );
      const q1 = questions.find((q) => q.id === body.p_q1);
      const q2 = questions.find((q) => q.id === body.p_q2);
      if (q1) q1.status = 'approved';
      if (q2) q2.status = 'approved';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('draft') });
      return;
    }

    if (path.endsWith('/rpc/save_own_question')) {
      const body = req.postDataJSON() as {
        p_session_id: string;
        p_question: { title: string; statement: string; difficulty: string; co_code: string };
      };
      const qid = `q-own-${questions.length + 1}`;
      questions.push({
        id: qid,
        institution_id: SAMPLE_INST.id,
        course_id: SAMPLE_COURSE_ID,
        kind: 'lab',
        session_id: body.p_session_id,
        assessment_id: null,
        co_code: body.p_question.co_code || 'CO1',
        difficulty: body.p_question.difficulty || 'medium',
        title: body.p_question.title,
        statement: body.p_question.statement,
        input_spec: '',
        output_spec: '',
        constraints: '',
        starter_code: {},
        status: 'candidate',
        source: 'faculty',
        valid: null,
        validation_note: null,
        created_by: 'uid-faculty',
        created_at: new Date().toISOString(),
      });
      references.push({
        id: `${qid}-ref-c`,
        institution_id: SAMPLE_INST.id,
        question_id: qid,
        lang: 'c',
        code: 'int main(){return 0;}',
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qid) });
      return;
    }

    if (path.endsWith('/rpc/import_lab_questions')) {
      const body = req.postDataJSON() as {
        p_session_id: string;
        p_items: Array<{ title: string; statement: string; difficulty: string; co_code: string }>;
      };
      const ids: string[] = [];
      for (const item of body.p_items) {
        const qid = `q-imp-${questions.length + 1}`;
        ids.push(qid);
        questions.push({
          id: qid,
          institution_id: SAMPLE_INST.id,
          course_id: SAMPLE_COURSE_ID,
          kind: 'lab',
          session_id: body.p_session_id,
          assessment_id: null,
          co_code: item.co_code || 'CO1',
          difficulty: item.difficulty || 'medium',
          title: item.title,
          statement: item.statement,
          input_spec: '',
          output_spec: '',
          constraints: '',
          starter_code: {},
          status: 'candidate',
          source: 'faculty',
          valid: null,
          validation_note: null,
          created_by: 'uid-faculty',
          created_at: new Date().toISOString(),
        });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ids) });
      return;
    }

    if (path.endsWith('/rpc/upsert_bank_item')) {
      const body = req.postDataJSON() as {
        p_session_id: string;
        p_bank: 'pre' | 'post';
        p_level: 'easy' | 'medium' | 'hard';
        p_stem: string;
        p_options: string[];
        p_answer: number;
        p_item_id: string | null;
      };
      if (body.p_item_id) {
        const hit = bankItems.find((b) => b.id === body.p_item_id);
        if (hit) {
          hit.stem = body.p_stem;
          hit.options = body.p_options;
          hit.answer = body.p_answer;
          hit.approved = false;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.p_item_id) });
      } else {
        const nid = `b-${bankItems.length + 1}`;
        bankItems.push({
          id: nid,
          institution_id: SAMPLE_INST.id,
          session_id: body.p_session_id,
          bank: body.p_bank,
          level: body.p_level,
          stem: body.p_stem,
          options: body.p_options,
          answer: body.p_answer,
          approved: false,
          created_at: new Date().toISOString(),
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nid) });
      }
      return;
    }

    if (path.endsWith('/rpc/delete_bank_item')) {
      const body = req.postDataJSON() as { p_item_id: string };
      const idx = bankItems.findIndex((b) => b.id === body.p_item_id);
      if (idx >= 0) bankItems.splice(idx, 1);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
      return;
    }

    if (path.endsWith('/rpc/import_bank_items')) {
      const body = req.postDataJSON() as {
        p_session_id: string;
        p_items: Array<{ bank: 'pre' | 'post'; level: 'easy' | 'medium' | 'hard'; stem: string; options: string[]; answer: number }>;
      };
      for (const item of body.p_items) {
        bankItems.push({
          id: `b-csv-${bankItems.length + 1}`,
          institution_id: SAMPLE_INST.id,
          session_id: body.p_session_id,
          bank: item.bank,
          level: item.level,
          stem: item.stem,
          options: item.options,
          answer: item.answer,
          approved: false,
          created_at: new Date().toISOString(),
        });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.p_items.length) });
      return;
    }

    if (path.endsWith('/rpc/approve_bank')) {
      const body = req.postDataJSON() as { p_session_id: string; p_bank: 'pre' | 'post' };
      const norm = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      const preList = bankItems.filter((b) => b.session_id === body.p_session_id && b.bank === 'pre');
      const postList = bankItems.filter((b) => b.session_id === body.p_session_id && b.bank === 'post');
      const targetList = body.p_bank === 'pre' ? preList : postList;
      const otherList = body.p_bank === 'pre' ? postList : preList;
      const hasOverlap = targetList.some((a) =>
        otherList.some((b) => {
          const sa = new Set(norm(a.stem));
          const sb = new Set(norm(b.stem));
          let inter = 0;
          for (const t of sa) if (sb.has(t)) inter++;
          return sa.size + sb.size - inter > 0 && inter / (sa.size + sb.size - inter) >= 0.8;
        }),
      );
      if (hasOverlap) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'bank_overlap' }) });
        return;
      }
      for (const b of targetList) b.approved = true;
      const allPreOk = preList.length === 45 && preList.every((b) => b.approved);
      const allPostOk = postList.length === 45 && postList.every((b) => b.approved);
      const pickedOk = sessionQuestions.filter((sq) => sq.session_id === body.p_session_id).length === 2;
      const sess = sessions.find((s) => s.id === body.p_session_id);
      if (sess) sess.status = allPreOk && allPostOk && pickedOk ? 'active' : 'draft';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sess?.status ?? 'draft'),
      });
      return;
    }

    if (path.includes('/rpc/')) {
      const rpcBody = (() => {
        try {
          return (req.postDataJSON() ?? {}) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const handledRpc = await handlePhase4Rpc(route, path, rpcBody, {
        instId: SAMPLE_INST.id,
        courseId: SAMPLE_COURSE_ID,
        actorId: currentSessionProfile?.id ?? 'uid-student-1',
        state: phase4State,
        batches,
        enrollments,
        profiles: adminProfiles,
        sessions,
        sessionQuestions,
        bankItems,
      });
      if (handledRpc) return;
      const handledRpc5 = await handlePhase5Rpc(route, path, rpcBody, {
        instId: SAMPLE_INST.id,
        instName: SAMPLE_INST.name,
        courseId: SAMPLE_COURSE_ID,
        actorId: currentSessionProfile?.id ?? 'uid-student-1',
        actorRole: currentSessionProfile?.role ?? null,
        state: phase5State,
        phase4State,
        courses,
        profiles: adminProfiles,
        enrollments,
        rotateSessionToken: (nextToken) => {
          if (currentSessionProfile) {
            currentSessionProfile.calendar_token = nextToken;
          }
        },
      });
      if (handledRpc5) return;
      if (path.endsWith('/rpc/my_institution')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_INST.id) });
        return;
      }
      if (path.endsWith('/rpc/course_stats')) {
        const ids = (rpcBody.p_course_ids as string[] | undefined) ?? [];
        const rows = ids.map((id) => ({
          course_id: id,
          students: 60,
          sessions_total: 30,
          sessions_conducted: 10,
          attendance_pct: 82.5,
          completion_pct: 60.0,
          at_risk: 3,
          live_now: false,
        }));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
        return;
      }
      if (path.endsWith('/rpc/at_risk_students')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
        return;
      }
      if (path.endsWith('/rpc/live_lab_stats')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
        return;
      }
      if (path.endsWith('/rpc/dept_stats')) {
        const rows = opts.emptyCourses
          ? []
          : [
              {
                department_id: 'dept-cs',
                department_name: 'Computer Science',
                school: 'School of Engineering',
                lab_courses: courses.length,
                students: 120,
                labs_live_now: 0,
                attendance_pct: 80.0,
                completion_pct: 65.0,
                co_attained: 4,
                co_total: 5,
                at_risk: 5,
              },
            ];
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
        return;
      }
      if (path.endsWith('/rpc/set_min_attendance')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
        return;
      }
      if (path.endsWith('/rpc/add_holiday')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('hol-new-1') });
        return;
      }
      if (path.endsWith('/rpc/remove_holiday')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) });
      return;
    }

    const reqBodyJson = (() => {
      try {
        return (req.postDataJSON() ?? null) as Record<string, unknown> | null;
      } catch {
        return null;
      }
    })();
    if (await handlePhase4Rest(route, method, path, url, isSingle, reqBodyJson, phase4State)) {
      return;
    }
    if (
      await handlePhase5Rest(
        route,
        method,
        path,
        url,
        isSingle,
        phase5State,
        phase4State,
        currentSessionProfile?.id ?? null,
        currentSessionProfile?.role ?? null,
      )
    ) {
      return;
    }

    if (method !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }

    if (path.endsWith('/profiles')) {
      const idFilter = url.searchParams.get('id');
      if (idFilter?.startsWith('eq.')) {
        const targetId = idFilter.slice(3);
        const found =
          currentSessionProfile && currentSessionProfile.id === targetId
            ? currentSessionProfile
            : adminProfiles.find((p) => p.id === targetId) ?? null;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(isSingle ? found : found ? [found] : []),
        });
        return;
      }
      const rows = applyPostgrestFilters(adminProfiles, url);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
      });
      return;
    }

    if (path.endsWith('/institutions')) {
      const idFilter = url.searchParams.get('id');
      let rows = opts.emptyAdmin ? [] : [SAMPLE_INST];
      if (idFilter?.startsWith('eq.')) {
        const targetId = idFilter.slice(3);
        rows = rows.filter((r) => r.id === targetId);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
      });
      return;
    }

    if (path.endsWith('/schools')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.emptyAdmin ? [] : SAMPLE_SCHOOLS),
      });
      return;
    }

    if (path.endsWith('/departments')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.emptyAdmin ? [] : SAMPLE_DEPTS),
      });
      return;
    }

    if (path.endsWith('/invites')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(invites) });
      return;
    }

    if (path.endsWith('/plans')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plans) });
      return;
    }

    if (path.endsWith('/subscription_requests')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(requests) });
      return;
    }

    if (path.endsWith('/courses')) {
      const rows = applyPostgrestFilters(courses, url);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
      });
      return;
    }

    if (path.endsWith('/course_outcomes')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outcomes) });
      return;
    }

    if (path.endsWith('/co_po_map')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(coPoMap) });
      return;
    }

    if (path.endsWith('/batches')) {
      const rows = applyPostgrestFilters(batches, url);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
      });
      return;
    }

    if (path.endsWith('/enrollments')) {
      const rows = applyPostgrestFilters(enrollments, url);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }

    if (path.endsWith('/pending_enrollments')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pendingEnrollments) });
      return;
    }

    if (path.endsWith('/sessions')) {
      const rows = applyPostgrestFilters(sessions, url);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
      });
      return;
    }

    if (path.endsWith('/holidays')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(holidays) });
      return;
    }

    if (path.endsWith('/questions')) {
      const rows = applyPostgrestFilters(questions, url);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }

    if (path.endsWith('/test_cases')) {
      let rows = applyPostgrestFilters(testCases, url);
      if (currentSessionProfile?.role === 'student') {
        rows = rows.filter((tc) => !tc.hidden);
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }

    if (path.endsWith('/reference_solutions')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(references) });
      return;
    }

    if (path.endsWith('/session_questions')) {
      const rows = applyPostgrestFilters(sessionQuestions, url);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }

    if (path.endsWith('/bank_items')) {
      if (currentSessionProfile?.role === 'student') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      const rows = applyPostgrestFilters(bankItems, url);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}
