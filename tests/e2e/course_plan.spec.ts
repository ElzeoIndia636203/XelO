import { expect, test } from '@playwright/test';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from './mockSupabase';

test('faculty deep-links to course setup, drafts outcomes, checks Ask box, and submits to HOD', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'draft',
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/setup`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Course setup');
  await expect(page.getByText('CSL-101 Programming in C Lab')).toBeVisible();
  await expect(page.getByText('50 / 50 valid')).toBeVisible();

  // Syllabus AI draft modal (F1a)
  await page.getByRole('button', { name: 'Draft from syllabus with Assist' }).click();
  await page
    .getByLabel('Or paste syllabus text')
    .fill('Unit 1 C programming fundamentals, loops, arrays, pointers, and file handling.');
  await page.getByRole('button', { name: 'Draft COs with Assist (1 AI run)' }).click();
  await expect(page.getByText('Review & edit before inserting')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Submit plan to HOD
  await page.getByRole('button', { name: 'Send course plan to HOD' }).click();
  await expect(page.getByText('Course plan sent to the department HOD')).toBeVisible();

  // Ask box navigation
  await page.getByLabel('Ask Assist').fill('batches');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page).toHaveURL(`/app/faculty/c/${SAMPLE_COURSE_ID}/batches`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Batch creation');
});

test('faculty previews roster split and session plan shortfall merge', async ({ page }) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
  });

  // Batches preview (F2)
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/batches`);
  await expect(page.getByText('Code: CS7Q4K')).toBeVisible();

  const csvRows = [
    'roll_no,full_name,email',
    ...Array.from({ length: 126 }, (_, i) => `2301${String(i + 1).padStart(3, '0')},Stu ${i + 1},stu${i + 1}@sanjivani.edu.in`),
  ].join('\n');
  await page.getByLabel('Or paste CSV / TSV rows').fill(csvRows);
  await page.getByRole('button', { name: 'Preview split' }).click();
  await expect(page.getByText('Batch A (63) · Batch B (63)')).toBeVisible();

  // Session plan shortfall + Assist merge (F3)
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/plan`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Session plan and calendar');
  await page.getByLabel('Last teaching day').fill('2027-04-14');
  await expect(page.getByText(/Short by 1 period/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByText(/Short by 1 period/)).toHaveCount(0);
});

test('HOD reviews pending course plan, requires remark to decline, and approves', async ({ page }) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('hod'),
    coursePlanStatus: 'sent',
  });

  await page.goto('/app/hod?tab=approvals');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Approvals');
  await expect(page.getByText('CSL-101 · Programming in C Lab').first()).toBeVisible();

  // Decline without remark triggers server error
  await page.getByRole('button', { name: 'Decline with remarks' }).click();
  await expect(page.getByText('Please enter a remark before declining or returning.')).toBeVisible();

  // Approve works cleanly
  await page.getByRole('button', { name: 'Approve course plan' }).click();
  await expect(page.getByText('CSL-101 course plan approved.')).toBeVisible();
});
