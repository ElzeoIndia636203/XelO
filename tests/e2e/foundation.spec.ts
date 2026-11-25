import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { makeProfile, setupSupabaseMocks, type MockProfile } from './mockSupabase';

const ROLE_TARGETS: Array<{
  role: MockProfile['role'];
  expectedPath: RegExp;
  expectedHeading: string;
}> = [
  { role: 'super_admin', expectedPath: /\/app\/admin/, expectedHeading: 'Users and roles' },
  { role: 'vc', expectedPath: /\/app\/oversight/, expectedHeading: 'VC monitor' },
  { role: 'coe', expectedPath: /\/app\/oversight/, expectedHeading: 'CoE monitor' },
  { role: 'dean', expectedPath: /\/app\/oversight/, expectedHeading: 'Dean monitor' },
  { role: 'hod', expectedPath: /\/app\/hod/, expectedHeading: 'Department overview' },
  { role: 'faculty', expectedPath: /\/app\/faculty/, expectedHeading: 'My courses' },
  { role: 'student', expectedPath: /\/app\/student/, expectedHeading: 'Home ·' },
];

for (const tc of ROLE_TARGETS) {
  test(`routes ${tc.role} to its home portal`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await setupSupabaseMocks(page, { sessionProfile: makeProfile(tc.role) });
    await page.goto('/app/login');
    await expect(page).toHaveURL(tc.expectedPath);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(tc.expectedHeading);
    expect(pageErrors).toEqual([]);
  });
}

test('redirects student away from /app/admin to /app/student', async ({ page }) => {
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('student') });
  await page.goto('/app/admin');
  await expect(page).toHaveURL(/\/app\/student/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Home ·');
});

test('refuses wrong domain, not-onboarded, and deactivated emails on sign-in', async ({ page }) => {
  await setupSupabaseMocks(page, {
    sessionProfile: null,
    preflightMap: {
      'new.person@sanjivani.edu.in': 'not_onboarded',
      'disabled.prof@sanjivani.edu.in': 'deactivated',
    },
  });

  await page.goto('/app/login');
  const emailInput = page.getByLabel('Institutional email');

  // Wrong domain blocked before calling preflight
  await emailInput.fill('someone@gmail.com');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('alert')).toContainText('institutional account email');

  // Not onboarded
  await emailInput.fill('new.person@sanjivani.edu.in');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('alert')).toContainText("This email isn't onboarded yet");

  // Deactivated
  await emailInput.fill('disabled.prof@sanjivani.edu.in');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('alert')).toContainText('deactivated');
});

test('preserves deep link across sign-in and shows 404 for unknown routes', async ({ page }) => {
  await setupSupabaseMocks(page, { sessionProfile: null });
  await page.goto('/app/admin?tab=credits');
  await expect(page).toHaveURL(/\/app\/login/);

  // Simulate completing sign-in on next navigation while session is restored
  await setupSupabaseMocks(page, { sessionProfile: makeProfile('super_admin') });
  await page.getByLabel('Institutional email').fill('super_admin.demo@sanjivani.edu.in');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.reload();
  await expect(page).toHaveURL(/\/app\/admin\?tab=credits/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI credits');

  await page.goto('/app/unknown-route');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Page not found');
});

test('super admin tabs render expected sections and landing/login pass axe', async ({ page }) => {
  await setupSupabaseMocks(page, { sessionProfile: null });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  const landingAxe = await new AxeBuilder({ page }).analyze();
  expect(landingAxe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  await page.goto('/app/login');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  const loginAxe = await new AxeBuilder({ page }).analyze();
  expect(loginAxe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  await setupSupabaseMocks(page, { sessionProfile: makeProfile('super_admin') });
  await page.goto('/app/admin');
  await expect(page.getByText('Students are not created here')).toBeVisible();

  await page.getByRole('button', { name: /Institutions/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Institutions');

  await page.getByRole('button', { name: /Subscriptions/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Subscriptions');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  await page.getByRole('button', { name: /AI credits/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI credits');
  await expect(page.getByText('Running low')).toBeVisible();

  await page.getByRole('button', { name: /Audit log/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Audit log');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
});
