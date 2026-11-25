/**
 * tests/e2e/oversight.spec.ts
 * E2E tests for Phase 6: HOD console and Oversight console.
 */

import { test, expect } from '@playwright/test';
import { makeProfile, setupSupabaseMocks } from './mockSupabase';

test.describe('HOD Console', () => {
  test.beforeEach(async ({ page }) => {
    await setupSupabaseMocks(page, { sessionProfile: makeProfile('hod') });
    await page.goto('/app/hod');
    await page.waitForLoadState('networkidle');
  });

  test('HOD lands on overview with KPI cards', async ({ page }) => {
    await expect(page.getByText('Lab courses')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Students')).toBeVisible();
    await expect(page.getByText('Avg attendance')).toBeVisible();
    await expect(page.getByText('Avg completion')).toBeVisible();
    await expect(page.getByText('At risk')).toBeVisible();
  });

  test('HOD sees Assist panel', async ({ page }) => {
    await expect(page.getByText('Assist suggests')).toBeVisible({ timeout: 10_000 });
  });

  test('HOD navigates to Courses tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Courses' }).click();
    await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('82.5%')).toBeVisible();
    await expect(page.getByText('10/30')).toBeVisible();
  });

  test('HOD navigates to Live tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Live' }).click();
    await expect(page.getByText('No labs running right now.')).toBeVisible({ timeout: 10_000 });
  });

  test('HOD navigates to Final marks tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Final marks' }).click();
    await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
  });

  test('HOD navigates to Approvals tab with no pending', async ({ page }) => {
    await page.getByRole('button', { name: 'Approvals' }).click();
    await expect(page.getByText('Nothing waiting. All clear.')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('HOD approves final marks', () => {
  test('approve flow calls decide_final_marks', async ({ page }) => {
    await setupSupabaseMocks(page, { sessionProfile: makeProfile('hod') });

    await page.route('**/rest/v1/notifications*', async (r) => {
      if (r.request().method() === 'GET') {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'notif-1',
              kind: 'final_marks_pending',
              entity_id: 'course-1',
              created_at: new Date(Date.now() - 3_600_000).toISOString(),
              payload: { course_code: 'CSL-101', course_title: 'Programming in C Lab' },
              read_at: null,
              title: 'Final marks ready',
              body: 'Awaiting HOD approval',
              link: '/hod?tab=approvals',
            },
          ]),
        });
        return;
      }
      await r.continue();
    });

    let decideCalled = false;
    await page.route('**/rest/v1/rpc/decide_final_marks', async (r) => {
      decideCalled = true;
      await r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    await page.goto('/app/hod?tab=approvals');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('button', { name: 'Approve & send to CoE' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Approve & send to CoE' }).click();
    await page.waitForTimeout(300);
    expect(decideCalled).toBe(true);
  });
});

test.describe('Oversight Console — CoE', () => {
  test.beforeEach(async ({ page }) => {
    await setupSupabaseMocks(page, { sessionProfile: makeProfile('coe') });
    await page.goto('/app/oversight');
    await page.waitForLoadState('networkidle');
  });

  test('CoE lands on Monitor with KPIs', async ({ page }) => {
    await expect(page.getByText('Controller of Examinations')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Departments', { exact: true })).toBeVisible();
    await expect(page.getByText('Computer Science')).toBeVisible();
    await expect(page.getByText('4/5')).toBeVisible();
  });

  test('CoE sees Courses tab with dept filter', async ({ page }) => {
    await page.getByRole('button', { name: 'Courses' }).click();
    await expect(page.getByText('CSL-101')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('combobox')).toHaveValue('');
  });

  test('CoE sees Internals tab with fetch button', async ({ page }) => {
    await page.getByRole('button', { name: 'Internals' }).click();
    await expect(page.getByRole('button', { name: 'Fetch HOD-approved internals' })).toBeVisible({ timeout: 10_000 });
  });

  test('CoE sees Eligibility tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Eligibility' }).click();
    await expect(page.getByText('Minimum attendance requirement')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Holidays')).toBeVisible();
  });

  test('CoE accept internals flow', async ({ page }) => {
    let acceptCalled = false;
    await page.route('**/rest/v1/rpc/decide_final_marks', async (r) => {
      acceptCalled = true;
      await r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    await page.route('**/rest/v1/courses*', async (r) => {
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'course-1',
            code: 'CSL-101',
            title: 'Programming in C Lab',
            final_status: 'hod_approved',
            departments: { name: 'Computer Science' },
            course_snapshots: [{ overall_pct: 74 }],
            approvals: [{ actor_id: 'hod-1', created_at: '2026-11-20T10:00:00Z', profiles: { full_name: 'Dr HOD' } }],
          },
        ]),
      });
    });

    await page.getByRole('button', { name: 'Internals' }).click();
    await page.getByRole('button', { name: 'Fetch HOD-approved internals' }).click();
    await expect(page.getByRole('button', { name: 'Accept into results' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Accept into results' }).click();
    await page.waitForTimeout(300);
    expect(acceptCalled).toBe(true);
  });
});
