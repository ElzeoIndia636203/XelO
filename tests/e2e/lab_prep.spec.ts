import { expect, test } from '@playwright/test';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from './mockSupabase';

test('faculty reviews lab candidates on F4, keeps invalid disabled, picks 2, writes own, uploads JSON, and stops cleanly on AI cap', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
    aiFailAfter: { calls: 1, error: 'daily_cap' },
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/questions`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lab questions');
  await expect(page.getByText('1 / 30 sessions ready')).toBeVisible();

  // Failing candidate is visible with failure note and its checkbox is disabled
  await expect(page.getByText('Fails hidden case 4 · wrong_answer')).toBeVisible();
  const invalidCheckbox = page.getByRole('checkbox', { name: /Operators · Debug overflow case/ });
  await expect(invalidCheckbox).toBeDisabled();

  // Assist pick best 2 on S2
  const s2Section = page.locator('section.card', { hasText: 'S2 · Operators and expressions' });
  await s2Section.getByRole('button', { name: 'Assist pick best 2' }).click();
  await expect(page.getByText('Saved 2 questions for S2.')).toBeVisible();
  await expect(page.getByText('2 / 30 sessions ready')).toBeVisible();

  // Write own question modal on S2
  await s2Section.getByRole('button', { name: 'Write own question' }).click();
  await page.getByLabel('Title').fill('Own Matrix Determinant');
  await page.getByLabel('Problem statement').fill('Compute determinant of a 2x2 matrix.');
  const expectedInputs = page.locator('input[required]').filter({ hasText: '' });
  const count = await expectedInputs.count();
  for (let i = 0; i < count; i++) {
    const val = await expectedInputs.nth(i).inputValue();
    if (!val) await expectedInputs.nth(i).fill('0');
  }
  const refAreas = page.locator('textarea[required]');
  const refCount = await refAreas.count();
  for (let i = 0; i < refCount; i++) {
    const val = await refAreas.nth(i).inputValue();
    if (!val) await refAreas.nth(i).fill('int main(){return 0;}');
  }
  await page.getByRole('button', { name: 'Save and validate' }).click();
  await expect(page.getByText('Own Matrix Determinant')).toBeVisible();

  // Also test JSON question upload preview modal on S2
  const jsonPayload = JSON.stringify([
    {
      title: 'Uploaded Factorial Check',
      statement: 'Read n and compute factorial.',
      difficulty: 'easy',
      co_code: 'CO1',
      visible_tests: [
        { input: '3', expected: '6' },
        { input: '4', expected: '24' },
      ],
      hidden_tests: [
        { input: '0', expected: '1' },
        { input: '1', expected: '1' },
        { input: '5', expected: '120' },
      ],
      references: { c: 'int main(){return 0;}' },
    },
  ]);
  await s2Section.locator('input[type="file"]').setInputFiles({
    name: 'own.json',
    mimeType: 'application/json',
    buffer: Buffer.from(jsonPayload, 'utf8'),
  });
  await expect(page.getByText('Confirm uploaded questions · S2')).toBeVisible();
  await expect(page.getByText('Uploaded Factorial Check')).toBeVisible();
  await page.getByRole('button', { name: 'Insert and validate' }).click();
  await expect(page.getByText('Uploaded and validated 1 question(s) for S2.')).toBeVisible();

  // Sequential bulk AI draft stops cleanly on daily_cap after 1st remaining session
  await page.getByRole('button', { name: /Draft candidates for \d+ remaining sessions/ }).click();
  await expect(
    page.getByText('Stopped after 1 session(s): Daily cap reached; resets at midnight IST.'),
  ).toBeVisible();
});

test('faculty resolves pre/post overlap on F5 and activates S2 once both banks are approved', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
  });

  // First pick S2's 2 questions so approving both banks activates S2
  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/questions`);
  const s2Section = page.locator('section.card', { hasText: 'S2 · Operators and expressions' });
  await s2Section.getByRole('button', { name: 'Assist pick best 2' }).click();
  await expect(page.getByText('2 / 30 sessions ready')).toBeVisible();

  // Navigate to F5 Pre/post-test banks and select S2
  await page.getByRole('button', { name: /Pre\/post-test banks/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pre-test and post-test banks');
  await page.getByRole('button', { name: /Session 2 Operators and expressions/ }).click();

  // Overlap detected and highlighted
  await expect(page.getByText('1 overlap(s) found')).toBeVisible();
  await expect(page.getByText('Overlaps the other bank').first()).toBeVisible();

  // Trying to approve with overlap returns bank_overlap message
  await page.getByRole('button', { name: 'Approve post-test bank' }).click();
  await expect(page.getByText(/matching or near-identical questions/)).toBeVisible();

  // Edit colliding item inside Post-test bank to remove overlap, then approve both banks
  const postCard = page.locator('section.card', { hasText: 'Post-test bank' });
  await postCard.getByRole('button', { name: 'Edit' }).first().click();
  await page
    .getByLabel('Question stem')
    .fill('Distinct complexity evaluation prompt for post-test verification');
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByText('0 overlaps')).toBeVisible();

  await page.getByRole('button', { name: 'Approve pre-test bank' }).click();
  await page.getByRole('button', { name: 'Approve post-test bank' }).click();
  await expect(page.getByText('Active for all batches')).toBeVisible();
  await expect(page.getByText('2/30').first()).toBeVisible();
});
