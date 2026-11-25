import { expect, test } from '@playwright/test';
import { makeProfile, SAMPLE_COURSE_ID, setupSupabaseMocks } from './mockSupabase';

test('student joins batch, completes pre-test, codes/reloads draft, unlocks post-test, and never sees hidden inputs', async ({
  page,
}) => {
  const inspectedPayloads: string[] = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/rest/v1/test_cases') || u.includes('/functions/v1/run-code')) {
      inspectedPayloads.push(await res.text().catch(() => ''));
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
    seedPrep: true,
    seedRun: true,
  });

  await page.goto('/app/student');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Home ·');
  await expect(page.getByText('CSL-101 · Programming in C Lab')).toBeVisible();

  // Bad class code displays mapped error; valid class code joins cleanly
  await page.getByLabel('Class code from your invite').fill('BAD999');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('That class code was not found.')).toBeVisible();

  await page.getByLabel('Class code from your invite').fill('CS8R5M');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Joined course successfully.')).toBeVisible();

  // Take Pre-test (S3)
  await page.getByRole('link', { name: 'Take it now' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Pre-test');
  for (let i = 0; i < 5; i++) {
    await page.locator('fieldset').nth(i).getByRole('radio').first().check();
  }
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText('Score: 5 / 5')).toBeVisible();

  // Open Today's lab IDE (S4)
  await page.getByRole('link', { name: 'Return to lab IDE' }).click();
  await expect(page.locator('aside[aria-label="Problem statement"]')).toBeVisible();
  await expect(page.getByText('Echo formatted integer pair')).toBeVisible();
  await expect(page.getByText('Hint from faculty ·')).toBeVisible();
  await expect(page.getByText('Pre-test 5/5 · closed')).toBeVisible();
  await expect(page.locator('header').getByText('Post-test locked')).toBeVisible();

  // Edit code in CodeMirror, test Run, and test Esc+Tab keyboard hatch
  const cmContent = page.locator('.cm-content');
  await cmContent.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('#include <stdio.h>\nint main(){/* DRAFT_KEEP_42 */ return 0;}');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(cmContent).not.toBeFocused();

  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText('Visible 2/2 passed')).toBeVisible();
  await expect(page.locator('header').getByText('Post-test locked')).toBeVisible();

  // Reload restores typed draft cleanly
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.cm-content')).toContainText('DRAFT_KEEP_42');

  // Verify zero hidden test inputs leaked to student network responses or page DOM
  const allWire = inspectedPayloads.join('\n');
  for (const secretInput of ['5 6', '7 8', '9 10']) {
    expect(allWire).not.toContain(secretInput);
    await expect(page.locator('body')).not.toContainText(secretInput);
  }

  // Submit Q1 & Q2 -> unlock Post-test
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/Hidden\s+3\/3/)).toBeVisible();

  await page.getByRole('button', { name: 'Question 2' }).click();
  await expect(page.getByText('Right-aligned integer table')).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Post-test open until 23:59')).toBeVisible();

  await page.getByRole('button', { name: 'Start post-test' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Post-test');
  for (let i = 0; i < 5; i++) {
    await page.locator('fieldset').nth(i).getByRole('radio').first().check();
  }
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText('Score: 5 / 5')).toBeVisible();
});

test('faculty opens pending attendance modal F6a, monitors live lab F6, inspects student F6f, and previews F6p', async ({
  page,
}) => {
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
    seedRun: 'pending_attendance',
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/sessions?s=1&roll=2301002`);
  await expect(page.getByRole('button', { name: 'Confirm and open session' })).toBeVisible();

  // Check-ins pre-marked 2301001 & 2301002 present, 2301003 absent -> toggle 2301003 to present
  await page.getByRole('button', { name: '2301003: absent' }).click();
  await expect(page.getByRole('button', { name: '2301003: present' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and open session' }).click();
  await expect(page.getByText('Attendance confirmed and live lab opened.')).toBeVisible();

  // Now check live mode features (alerts, hint, viva, inspector, preview)
  await setupSupabaseMocks(page, {
    sessionProfile: makeProfile('faculty'),
    coursePlanStatus: 'approved',
    seedPrep: true,
    seedRun: 'live',
  });

  await page.goto(`/app/faculty/c/${SAMPLE_COURSE_ID}/sessions?s=1&roll=2301001`);
  await expect(page.getByRole('heading', { name: 'Pre-test performance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live monitor' })).toBeVisible();
  await expect(page.getByText('Student inspector · Aarav Patil (2301001)')).toBeVisible();

  // Select struggling student alert and send hint + flag slow learner
  await page.getByRole('checkbox', { name: /2301002/ }).check();
  await page.getByLabel('Hint message').fill('Print a:b with newline');
  await page.getByRole('button', { name: 'Send hint to 1' }).click();
  await expect(page.getByText('Hint delivered live to 1 student(s).')).toBeVisible();

  await page.getByRole('button', { name: 'Send TA to seats' }).click();
  await expect(page.getByText('Send TA to seats · Batch A')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Add to slow-learner list' }).click();
  await expect(page.getByText('Added 1 student(s) to slow-learner list.')).toBeVisible();

  // Enter viva marks cleanly
  const vivaInput = page.getByLabel('Viva for 2301002');
  await vivaInput.fill('8.5');
  await vivaInput.blur();
  await expect(page.getByText('Viva marks saved.')).toBeVisible();

  // Inspector code toggle
  await page.getByRole('button', { name: 'Show code' }).first().click();
  await expect(page.locator('pre').getByText(/scanf/)).toBeVisible();

  // Preview as student route (F6p)
  await page.getByRole('link', { name: 'Preview as student' }).first().click();
  await expect(page.getByText('Preview as student (read-only)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
});
