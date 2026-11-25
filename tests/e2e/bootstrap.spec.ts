import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('landing and app login serve expected security headers and pass axe', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const landingRes = await page.goto('/');
  expect(landingRes?.status()).toBe(200);
  const landingHeaders = landingRes?.headers() ?? {};
  expect(landingHeaders['content-security-policy']).toContain("default-src 'self'");
  expect(landingHeaders['content-security-policy']).not.toContain("'wasm-unsafe-eval'");
  expect(landingHeaders['x-frame-options']).toBe('DENY');
  expect(landingHeaders['x-content-type-options']).toBe('nosniff');

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Every lab, planned, run and reported without the paperwork.',
  );
  const landingAxe = await new AxeBuilder({ page }).analyze();
  expect(landingAxe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  const appRes = await page.goto('/app/login');
  expect(appRes?.status()).toBe(200);
  const appHeaders = appRes?.headers() ?? {};
  expect(appHeaders['content-security-policy']).toContain("'wasm-unsafe-eval'");
  expect(appHeaders['permissions-policy']).toContain('camera=(self)');

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'The AI faculty assistant that plans, runs and reports every lab.',
  );
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Sign in');
  const appAxe = await new AxeBuilder({ page }).analyze();
  expect(appAxe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  expect(pageErrors).toEqual([]);
});
