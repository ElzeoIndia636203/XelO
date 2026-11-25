import { expect, test } from '@playwright/test';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from './mockSupabase';

test('G4 bell, G5 calendar token rotation, and F7 faculty classroom timeline', async ({ page }) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedClassroomReports: true,
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/plan`, { waitUntil: 'networkidle' });

  // G5: Personal calendar feed link & reset rotation
  const calInput = page.getByLabel('Personal calendar feed URL');
  await expect(calInput).toHaveValue(/\/functions\/v1\/calendar\?t=44444444-4444-4444-4444-444444444444/);

  const validIcsStatus = await page.evaluate(async (feedUrl) => {
    const res = await fetch(feedUrl);
    return { status: res.status, text: await res.text() };
  }, await calInput.inputValue());
  expect(validIcsStatus.status).toBe(200);
  expect(validIcsStatus.text).toContain('BEGIN:VCALENDAR');

  const invalidStatus = await page.evaluate(async () => {
    const res = await fetch('https://e2e.supabase.co/functions/v1/calendar?t=invalid');
    return res.status;
  });
  expect(invalidStatus).toBe(401);

  await page.getByRole('button', { name: 'Reset link' }).click();
  await expect(calInput).toHaveValue(/\/functions\/v1\/calendar\?t=55555555-5555-4444-8888-000000000002/);
  await expect(page.getByText('Generated a fresh calendar link. Previous link is now revoked.')).toBeVisible();

  // G4: Notification bell with light popover contrast even inside dark-header context
  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toBeVisible();
  const popoverColors = await dialog.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color };
  });
  expect(popoverColors.bg).toBe('rgb(255, 255, 255)');
  expect(popoverColors.fg).toBe('rgb(20, 20, 19)');

  await dialog.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications (0 unread)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // F7: Faculty Classroom timeline
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/classroom`, { waitUntil: 'networkidle' });
  await expect(page.getByText('Batch A: CS7Q4K')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend 1 invites' })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to this week' }).click();

  const week2Card = page.locator('#week-card-2');
  await expect(week2Card).toContainText('This week');
  await expect(week2Card).toContainText('Predict printf return value');

  // View existing student response in Responses modal
  await week2Card.getByRole('button', { name: 'Responses (1)' }).click();
  const respDialog = page.getByRole('dialog', { name: /Responses · Predict printf return value/ });
  await expect(respDialog).toContainText('Diya Kulkarni');
  await expect(respDialog).toContainText('2301002');
  await respDialog.getByRole('button', { name: 'Close' }).click();

  // Generate AI task preview -> approve into Week 2
  await week2Card.getByRole('button', { name: '+ Add task, resource or announcement' }).click();
  await week2Card.getByRole('button', { name: 'Generate with AI' }).click();
  await expect(week2Card.getByText('Assist draft preview (review before adding)')).toBeVisible();
  await expect(week2Card.getByText('Answer key: 0')).toBeVisible();
  await week2Card.getByRole('button', { name: 'Add to this week' }).click();
  await expect(week2Card.getByText('Operator precedence check')).toBeVisible();

  // Draft announcement with Assist -> add to Week 2
  await week2Card.getByRole('button', { name: '+ Add task, resource or announcement' }).click();
  await week2Card.getByRole('button', { name: 'Announcement' }).click();
  await week2Card.getByRole('button', { name: 'Draft with Assist' }).click();
  await expect(week2Card.getByLabel('Announcement title')).toHaveValue('Bring lab manual printout for S2');
  await week2Card.getByRole('button', { name: 'Add to this week' }).click();
  await expect(week2Card.getByText('Bring lab manual printout for S2')).toBeVisible();

  // Attach private file resource -> upload to storage & add to Week 2
  await week2Card.getByRole('button', { name: '+ Add task, resource or announcement' }).click();
  await week2Card.getByRole('button', { name: 'Resource' }).click();
  await week2Card.locator('input[type="file"]').setInputFiles({
    name: 'week2-notes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nWeek 2 lab notes\n'),
  });
  await expect(week2Card.getByText(/Stored: .*week2-notes\.pdf/)).toBeVisible();
  await week2Card.getByRole('button', { name: 'Add to this week' }).click();
  await expect(week2Card.getByText('week2-notes')).toBeVisible();
});

test('S2 student classroom hides answer keys, S5 printable lab file, and S6 unauthenticated verification', async ({
  page,
}) => {
  const answerKeyPayloads: string[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/rest/v1/class_answer_keys')) {
      answerKeyPayloads.push(await res.text().catch(() => ''));
    }
  });

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

  // Student Home (S1): Previous semesters shows CoE-accepted course lab file link + calendar feed
  await page.goto('/app/student', { waitUntil: 'networkidle' });
  await expect(page.getByText('Personal calendar feed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Previous semesters' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Lab file' })).toBeVisible();

  // S2: Student Classroom timeline
  await page.goto('/app/student/classroom', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CSL-101 · Programming in C Lab');
  await expect(page.getByText('Lab S2 pre-test window closes at 10:00')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open link' })).toHaveAttribute(
    'href',
    'https://www.gnu.org/software/gnu-c-manual/',
  );

  // Answer Predict task inline & verify score without any answer key exposure
  await page.getByLabel('Answer for Predict printf return value').fill('1');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Submitted. Score: 1')).toBeVisible();
  await expect(page.getByText('Done · 1/1')).toBeVisible();
  expect(answerKeyPayloads.every((p) => p === '[]')).toBe(true);

  // Open signed private file URL in popup
  await page.context().route('**/storage/v1/object/sign/**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Mock signed PDF' });
      return;
    }
    await route.fallback();
  });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open file' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  expect(popup.url()).toContain('/storage/v1/object/sign/class-files/');
  await popup.close();

  // S5: Printable 4-page student lab file
  await page.goto('/app/student/lab-file', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lab file · CSL-101');
  await expect(page.locator('section[aria-label="Title page"]')).toContainText('Sanjivani University');
  await expect(page.locator('section[aria-label="Title page"]')).toContainText('Aarav Patil');
  const decl = page.locator('section[aria-label="Declaration"]');
  await expect(decl).toContainText('98 / 100');
  await expect(decl).toContainText('100%');
  await expect(decl.locator('svg[aria-label^="QR code to verify"]')).toBeVisible();
  await expect(page.locator('section[aria-label="Index"]')).toContainText('Input and output');
  await expect(page.locator('section[aria-label="Record of submitted programs"]')).toContainText(
    'Echo formatted integer pair',
  );

  // Toggle "Show all code" reveals submitted C source
  await page.getByRole('button', { name: 'Show all code' }).click();
  await expect(page.locator('section[aria-label="Record of submitted programs"]')).toContainText('#include <stdio.h>');

  // S6: Public unauthenticated verify link works with zero auth session
  await setupSupabaseMocks(page, {
    sessionProfile: null,
    coursePlanStatus: 'approved',
    finalStatus: 'coe_accepted',
    seedClassroomReports: true,
  });
  await page.goto(`/app/verify/${SAMPLE_COURSE_ID}/uid-student-1`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Verified Laboratory Record');
  await expect(page.getByText('Verified record')).toBeVisible();
  await expect(page.getByText('Aarav Patil')).toBeVisible();
  await expect(page.getByText('2301001', { exact: true })).toBeVisible();
  await expect(page.getByText('98 / 100')).toBeVisible();

  await page.goto(`/app/verify/${SAMPLE_COURSE_ID}/unknown-student`, { waitUntil: 'networkidle' });
  await expect(page.getByText('Record not found')).toBeVisible();
});

test('F9a-F9d faculty reports: 14-section course file, internal report, student lab files ZIP, and final marks', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedClassroomReports: true,
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/reports`, { waitUntil: 'networkidle' });

  // F9a: 14 NBA/NAAC sections + actual log + Assist narratives + CSV exports
  await expect(page.getByText('Course file (14 NBA/NAAC sections)')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Course details')).toBeVisible();
  await expect(page.getByText('Overall summary', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Actual log of session plan')).toBeVisible();
  await expect(page.getByText('As planned')).toBeVisible();

  await page.getByRole('button', { name: 'Draft summaries with Assist' }).click();
  await expect(page.getByText('Drafted report summaries with Assist. Review and save below.')).toBeVisible();
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText('Saved course file summaries and BoS suggestions.')).toBeVisible();

  const dlMarkList = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Mark list (CSV)' }).click();
  expect((await dlMarkList).suggestedFilename()).toBe('CSL-101-mark-list.csv');

  const dlActualLog = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Actual log (CSV)' }).click();
  expect((await dlActualLog).suggestedFilename()).toBe('CSL-101-actual-log.csv');

  // F9b: Internal report KPIs, CO attainment, histogram/bell curve, manual flag, snapshot
  await page.getByRole('button', { name: 'Internal report' }).click();
  await expect(page.getByText('CO attainment')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Histogram with bell curve' })).toBeVisible();
  await expect(page.getByText('Gaps & insights')).toBeVisible();

  await page.getByLabel('Student to flag').selectOption('uid-student-3');
  await page.getByLabel('Learner group').selectOption('slow');
  await page.getByLabel('Flag note').fill('Needs loop tracing practice');
  await page.getByRole('button', { name: 'Add flag' }).click();
  await expect(page.getByText('2301003 (slow)')).toBeVisible();

  await page.getByRole('button', { name: 'Save snapshot' }).click();
  await expect(page.getByText('Saved course attainment snapshot for oversight dashboards.')).toBeVisible();

  // F9c: Student lab files roster + ZIP bundle + deep-link student file view
  await page.getByRole('button', { name: 'Student lab files' }).click();
  await expect(page.getByRole('cell', { name: 'Aarav Patil' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '98/100' })).toBeVisible();

  const dlZip = page.waitForEvent('download');
  await page.getByRole('button', { name: 'All students (ZIP)' }).click();
  expect((await dlZip).suggestedFilename()).toBe('CSL-101-lab-files.zip');

  await page.getByRole('link', { name: 'Open full lab file' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lab file · CSL-101');
  await page.getByRole('link', { name: 'Back to reports' }).click();

  // F9d: Final marks submission pipeline -> sent to HOD
  await page.getByRole('button', { name: 'Final marks' }).click();
  await page.getByRole('button', { name: 'Submit final marks to HOD' }).click();
  await expect(page.getByText('Final marks submitted to HOD for verification.')).toBeVisible();
  await expect(page.getByText('1. Faculty submitted')).toBeVisible();
});
