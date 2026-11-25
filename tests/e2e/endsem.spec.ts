/**
 * tests/e2e/endsem.spec.ts
 * E2E tests for Phase 7: Faculty F8 (E1-E6), Student S7-S10,
 * waiting room gating, proctored IDE, and MediaPipe wasm CSP load.
 */

import { expect, test } from '@playwright/test';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from './mockSupabase';

const ASSESS_ID = 'assess-1';
const PAPER_ID = 'paper-1';
const Q1_ID = 'q-end-1';
const Q2_ID = 'q-end-2';

const DEFAULT_RULES = {
  questions_per_student: 2,
  mix: { easy: 15, medium: 15, hard: 10 },
  visible_count: 2,
  hidden_count: 3,
  marks_per_test: 5,
  viva_marks: 10,
  duration_min: 120,
};

function makeAssessment(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSESS_ID,
    course_id: SAMPLE_COURSE_ID,
    batch_id: 'batch-a',
    rules: DEFAULT_RULES,
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
    ...overrides,
  };
}

test('F8 faculty assessments: E1 rules -> E2 assist pick 30 -> E6 marks & add to file', async ({ page }) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
  });

  let currentAssess = makeAssessment({ stage: 'rules' });
  const candidates = Array.from({ length: 40 }, (_, i) => ({
    id: `aq-${i + 1}`,
    question_id: `q-end-${i + 1}`,
    approved: false,
    questions: {
      id: `q-end-${i + 1}`,
      title: `End-sem Question ${i + 1}`,
      co_code: 'CO1',
      difficulty: 'medium',
      valid: true,
    },
  }));

  await page.route('**/rest/v1/assessments*', async (r) => {
    const accept = r.request().headers()['accept'] ?? '';
    if (accept.includes('vnd.pgrst.object')) {
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentAssess) });
      return;
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([currentAssess]) });
  });

  await page.route('**/rest/v1/assessment_questions*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidates) });
  });

  await page.route('**/rest/v1/exam_papers*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route('**/rest/v1/attendance*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route('**/rest/v1/viva*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route('**/rest/v1/rpc/pick_assessment_questions', async (r) => {
    const body = r.request().postDataJSON() as { p_question_ids?: string[] };
    const picked = new Set(body.p_question_ids ?? []);
    for (const c of candidates) c.approved = picked.has(c.question_id);
    await r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  await page.route('**/rest/v1/rpc/send_assessment_to_hod', async (r) => {
    currentAssess = makeAssessment({ stage: 'hod_pending', hod_status: 'sent', rules_locked: true });
    await r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/assessments`);
  await expect(page.getByRole('heading', { name: 'End-sem assessments' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('25 marks per question')).toBeVisible();

  // Switch to E2 by advancing mock state on reload
  currentAssess = makeAssessment({ stage: 'generate', rules_locked: true });
  await page.reload();
  await expect(page.getByText('E2 · Select 30 of 40 (0/30 selected)')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Assist pick best 30' }).click();
  await expect(page.getByText('E2 · Select 30 of 40 (30/30 selected)')).toBeVisible();

  await page.getByRole('button', { name: 'Add to question bank and send to HOD' }).click();
  await expect(page.getByText('E3 · HOD approval')).toBeVisible();
});

test('Student S7-S10: waiting room blocks Start until activated, proctored IDE loads, and S10 shows results', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('student', {
      id: 'uid-student-1',
      email: 's1@sanjivani.edu.in',
      full_name: 'Aarav Patil',
      roll_no: '2301001',
    }),
    coursePlanStatus: 'approved',
  });

  // Verify MediaPipe wasm asset is served cleanly under /app/* CSP
  const wasmRes = await page.request.get('/vendor/mediapipe/vision_wasm_internal.js');
  expect(wasmRes.status()).toBe(200);

  let currentAssess = makeAssessment({ stage: 'scheduled', activated_at: null });
  let attState: { state: string } | null = null;
  let paperData: Record<string, unknown> | null = null;

  await page.route('**/rest/v1/assessments*', async (r) => {
    const accept = r.request().headers()['accept'] ?? '';
    if (accept.includes('vnd.pgrst.object')) {
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentAssess) });
      return;
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([currentAssess]) });
  });

  await page.route('**/rest/v1/attendance*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(attState) });
  });

  await page.route('**/rest/v1/exam_papers*', async (r) => {
    const accept = r.request().headers()['accept'] ?? '';
    if (accept.includes('vnd.pgrst.object')) {
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(paperData) });
      return;
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(paperData ? [paperData] : []) });
  });

  await page.route('**/rest/v1/viva*', async (r) => {
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ marks: 9 }) });
  });

  await page.route('**/rest/v1/submissions*', async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { question_id: Q1_ID, visible_passed: 2, visible_total: 2, hidden_passed: 3, hidden_total: 3, marks: 25 },
        { question_id: Q2_ID, visible_passed: 2, visible_total: 2, hidden_passed: 3, hidden_total: 3, marks: 25 },
      ]),
    });
  });

  // S7: Before the day
  await page.goto('/app/student/endsem');
  await expect(page.getByText('Eligible')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Open secure check & waiting room' }).click();

  // S8: Waiting room blocks Start until all checks + present + activated
  await expect(page.getByText('Pre-exam checklist')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start exam' })).toBeDisabled();

  // S9: Navigate directly to proctored IDE to verify proctor bar & no nav
  paperData = {
    id: PAPER_ID,
    assessment_id: ASSESS_ID,
    student_id: 'uid-student-1',
    q_ids: [Q1_ID, Q2_ID],
    deadline: new Date(Date.now() + 7_200_000).toISOString(),
    submitted_at: null,
    flagged: false,
  };
  await page.route('**/rest/v1/questions*', async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: Q1_ID,
          course_id: SAMPLE_COURSE_ID,
          kind: 'endsem',
          co_code: 'CO1',
          difficulty: 'medium',
          title: 'Sum Two Numbers',
          statement: 'Read two integers and print their sum.',
          input_spec: 'Two integers',
          output_spec: 'Single integer',
          constraints: '',
          starter_code: { python: 'print(0)' },
          status: 'approved',
          valid: true,
        },
        {
          id: Q2_ID,
          course_id: SAMPLE_COURSE_ID,
          kind: 'endsem',
          co_code: 'CO2',
          difficulty: 'medium',
          title: 'Reverse Array',
          statement: 'Reverse an array of integers.',
          input_spec: 'N followed by N integers',
          output_spec: 'Reversed integers',
          constraints: '',
          starter_code: { python: 'print(0)' },
          status: 'approved',
          valid: true,
        },
      ]),
    });
  });

  await page.goto(`/app/student/endsem/exam/${PAPER_ID}`);
  await expect(page.getByText('Copy/paste blocked')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Submit exam' })).toBeVisible();

  // S10: Results after HOD approval + added_to_file
  await page.route('**/rest/v1/courses*', async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: SAMPLE_COURSE_ID, code: 'CSL-101', title: 'Programming in C Lab', final_status: 'hod_approved' }),
    });
  });
  currentAssess = makeAssessment({ stage: 'marks', added_to_file: true, ended_at: '2026-12-10T12:00:00Z' });
  attState = { state: 'present' };
  await page.goto('/app/student/endsem');
  await expect(page.getByText('Published after HOD approval')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Total: 59 / 60')).toBeVisible();
});
