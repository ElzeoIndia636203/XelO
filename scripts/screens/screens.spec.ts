import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from '../../tests/e2e/mockSupabase';

const outDir = resolve(process.cwd(), 'docs/ui/shots/actual');

test('captures Phase 1 and Phase 2 screens at desktop and mobile without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, { sessionProfile: null });

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(outDir, 'g1-landing-1440.png'), fullPage: true });

  await page.goto('/app/login', { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(outDir, 'g2-login-1440.png'), fullPage: true });

  await setupSupabaseMocks(page, { sessionProfile: makeProfile('super_admin') });
  const adminTabs = [
    { id: 'users', file: 'a1-admin-users-1440.png', title: 'Users and roles' },
    { id: 'institutions', file: 'a2-admin-institutions-1440.png', title: 'Institutions' },
    { id: 'subs', file: 'a3-admin-subscriptions-1440.png', title: 'Subscriptions' },
    { id: 'credits', file: 'a4-admin-credits-1440.png', title: 'AI credits' },
    { id: 'audit', file: 'a5-admin-audit-1440.png', title: 'Audit log' },
  ];

  for (const tab of adminTabs) {
    await page.goto(`/app/admin?tab=${tab.id}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(tab.title);
    await page.screenshot({ path: resolve(outDir, tab.file), fullPage: true });
  }

  // Phase 2 screens (1440px)
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('faculty'), coursePlanStatus: 'draft' });
  await page.goto('/app/faculty', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My courses');
  await page.screenshot({ path: resolve(outDir, 'f0-faculty-list-1440.png'), fullPage: true });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/setup`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Course setup');
  await page.screenshot({ path: resolve(outDir, 'f1-course-setup-1440.png'), fullPage: true });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/batches`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Batch creation');
  await page.screenshot({ path: resolve(outDir, 'f2-batches-1440.png'), fullPage: true });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/plan`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Session plan and calendar');
  await page.screenshot({ path: resolve(outDir, 'f3-session-plan-1440.png'), fullPage: true });

  await setupSupabaseMocks(page, { sessionProfile: makeProfile('hod'), coursePlanStatus: 'sent' });
  await page.goto('/app/hod?tab=approvals', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Approvals');
  await page.screenshot({ path: resolve(outDir, 'h2-hod-approvals-1440.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('captures Phase 3, mobile, and empty screens without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setViewportSize({ width: 1440, height: 900 });

  // Phase 3 screens (1440px)
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
  });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/questions`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lab questions');
  await page.screenshot({ path: resolve(outDir, 'f4-lab-questions-1440.png'), fullPage: true });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/banks`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pre-test and post-test banks');
  await page.getByRole('button', { name: /Session 2 Operators and expressions/ }).click();
  await page.screenshot({ path: resolve(outDir, 'f5-test-banks-1440.png'), fullPage: true });

  // Mobile 390px check
  await page.setViewportSize({ width: 390, height: 844 });
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('faculty'), coursePlanStatus: 'draft' });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/setup`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(outDir, 'f1-course-setup-390.png'), fullPage: true });

  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
  });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/banks`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(outDir, 'f5-test-banks-390.png'), fullPage: true });

  // Empty states check
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('faculty'), emptyCourses: true });
  await page.goto('/app/faculty', { waitUntil: 'networkidle' });
  await expect(page.getByText('No courses yet')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f0-faculty-list-empty.png'), fullPage: true });

  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'draft',
  });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/questions`, { waitUntil: 'networkidle' });
  await expect(page.getByText('Lab questions unlock after course plan approval and session planning')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f4-lab-questions-empty.png'), fullPage: true });

  await setupSupabaseMocks(page, { sessionProfile: makeProfile('hod'), emptyCourses: true });
  await page.goto('/app/hod?tab=approvals', { waitUntil: 'networkidle' });
  await expect(page.getByText('Nothing waiting. All clear.')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'h2-hod-approvals-empty.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('captures Phase 4 screens at desktop and mobile without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
    seedRun: 'pending_attendance',
  });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/sessions`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Confirm and open session' })).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f6a-attendance-modal-1440.png'), fullPage: true });

  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
    seedRun: 'live',
  });
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/sessions`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Live monitor' })).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f6-live-sessions-1440.png'), fullPage: true });

  await page.getByRole('button', { name: 'Inspect' }).first().click();
  await expect(page.getByText(/Student inspector ·/)).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f6f-student-inspector-1440.png'), fullPage: true });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/preview`, { waitUntil: 'networkidle' });
  await expect(page.getByText('Preview as student (read-only)')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f6p-preview-as-student-1440.png'), fullPage: true });

  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('student', { id: 'uid-student-1', email: 's1@sanjivani.edu.in', full_name: 'Aarav Patil', roll_no: '2301001' }),
    coursePlanStatus: 'approved',
    seedPrep: true,
    seedRun: true,
  });
  await page.goto('/app/student', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Home ·');
  await page.screenshot({ path: resolve(outDir, 's1-student-home-1440.png'), fullPage: true });

  await page.goto('/app/student/test/sess-1/pre', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pre-test');
  await page.screenshot({ path: resolve(outDir, 's3-pre-test-1440.png'), fullPage: true });

  await page.goto('/app/student/lab/sess-1', { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 's4-lab-ide-1440.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/student', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Home ·');
  await page.screenshot({ path: resolve(outDir, 's1-student-home-390.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('captures Phase 5 screens at desktop and mobile without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Faculty Phase 5 screens (1440px)
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedClassroomReports: true,
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/classroom`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Jump to this week' })).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f7-classroom-1440.png'), fullPage: true });

  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'g4-bell-open-1440.png'), fullPage: true });
  await page.keyboard.press('Escape');

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/reports`, { waitUntil: 'networkidle' });
  await expect(page.getByText('Course file (14 NBA/NAAC sections)')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: resolve(outDir, 'f9a-course-file-1440.png'), fullPage: true });

  await page.getByRole('button', { name: 'Internal report' }).click();
  await expect(page.getByText('CO attainment')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f9b-internal-report-1440.png'), fullPage: true });

  await page.getByRole('button', { name: 'Student lab files' }).click();
  await expect(page.getByText('Student lab files roster')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'f9c-student-lab-files-1440.png'), fullPage: true });

  // Student Phase 5 screens (1440px + 390px)
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('student', {
      id: 'uid-student-1',
      email: 's1@sanjivani.edu.in',
      full_name: 'Aarav Patil',
      roll_no: '2301001',
    }),
    coursePlanStatus: 'approved',
    finalStatus: 'coe_accepted',
    seedClassroomReports: true,
  });

  await page.goto('/app/student/classroom', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CSL-101 · Programming in C Lab');
  await page.screenshot({ path: resolve(outDir, 's2-student-classroom-1440.png'), fullPage: true });

  await page.goto('/app/student/lab-file', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lab file · CSL-101');
  await page.screenshot({ path: resolve(outDir, 's5-lab-file-1440.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/student/classroom', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CSL-101 · Programming in C Lab');
  await page.screenshot({ path: resolve(outDir, 's2-student-classroom-390.png'), fullPage: true });

  // Public verification screen (1440px, unauthenticated)
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, {
    sessionProfile: null,
    coursePlanStatus: 'approved',
    finalStatus: 'coe_accepted',
    seedClassroomReports: true,
  });
  await page.goto(`/app/verify/${SAMPLE_COURSE_ID}/uid-student-1`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Verified Laboratory Record');
  await page.screenshot({ path: resolve(outDir, 's6-public-verify-1440.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('captures Phase 6 HOD and Oversight console screens without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('hod') });

  // H1 – HOD Overview
  await page.goto('/app/hod', { waitUntil: 'networkidle' });
  await expect(page.getByText('Lab courses')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'h1-hod-overview-1440.png'), fullPage: true });

  // H3 – HOD Courses
  await page.getByRole('button', { name: 'Courses' }).click();
  await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'h3-hod-courses-1440.png'), fullPage: true });

  // H4 – HOD Live
  await page.getByRole('button', { name: 'Live' }).click();
  await expect(page.getByText('No labs running right now.')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'h4-hod-live-1440.png'), fullPage: true });

  // H5 – HOD Final marks
  await page.getByRole('button', { name: 'Final marks' }).click();
  await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'h5-hod-final-1440.png'), fullPage: true });

  // Oversight Console (CoE)
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('coe') });

  // O1 – Monitor
  await page.goto('/app/oversight', { waitUntil: 'networkidle' });
  await expect(page.getByText('Controller of Examinations')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Computer Science')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 'o1-oversight-monitor-1440.png'), fullPage: true });

  // O2 – Courses
  await page.getByRole('button', { name: 'Courses' }).click();
  await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'o2-oversight-courses-1440.png'), fullPage: true });

  // O3 – Internals
  await page.getByRole('button', { name: 'Internals' }).click();
  await expect(page.getByRole('button', { name: 'Fetch HOD-approved internals' })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'o3-oversight-internals-1440.png'), fullPage: true });

  // O4 – Eligibility
  await page.getByRole('button', { name: 'Eligibility' }).click();
  await expect(page.getByText('Minimum attendance requirement')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'o4-oversight-eligibility-1440.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});

test('captures Phase 7 End-Sem screens at 1440px without page errors', async ({ page }) => {
  mkdirSync(outDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
  });

  const assess = {
    id: 'assess-1',
    course_id: SAMPLE_COURSE_ID,
    batch_id: 'batch-a',
    rules: {
      questions_per_student: 2,
      mix: { easy: 15, medium: 15, hard: 10 },
      visible_count: 2,
      hidden_count: 3,
      marks_per_test: 5,
      viva_marks: 10,
      duration_min: 120,
    },
    cos: ['co-1'],
    rules_locked: false,
    stage: 'rules',
    hod_status: 'draft',
    hod_remark: null,
    scheduled_at: '2026-12-10T10:00:00Z',
    room: 'Lab 1',
    attendance_done: false,
    activated_at: null,
    ended_at: null,
    added_to_file: false,
  };

  await page.route('**/rest/v1/assessments*', async (r) => {
    const accept = r.request().headers()['accept'] ?? '';
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(accept.includes('vnd.pgrst.object') ? assess : [assess]),
    });
  });

  // F8 – Assessments (E1 Rules)
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/assessments`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'End-sem assessments' })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 'f8-assessments-1440.png'), fullPage: true });

  // Student S7 & S8
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('student', {
      id: 'uid-student-1',
      email: 's1@sanjivani.edu.in',
      full_name: 'Aarav Patil',
      roll_no: '2301001',
    }),
    coursePlanStatus: 'approved',
  });
  await page.route('**/rest/v1/assessments*', async (r) => {
    const accept = r.request().headers()['accept'] ?? '';
    const schedAssess = { ...assess, stage: 'scheduled' };
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(accept.includes('vnd.pgrst.object') ? schedAssess : [schedAssess]),
    });
  });
  await page.goto('/app/student/endsem', { waitUntil: 'networkidle' });
  await expect(page.getByText('Eligible')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: resolve(outDir, 's7-endsem-before-1440.png'), fullPage: true });

  await page.getByRole('button', { name: 'Open secure check & waiting room' }).click();
  await expect(page.getByText('Pre-exam checklist')).toBeVisible();
  await page.screenshot({ path: resolve(outDir, 's8-secure-check-1440.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
});
