import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.env.SCREEN_BASE_URL || 'http://127.0.0.1:4173';
const outDir = resolve(process.cwd(), 'docs/ui/shots/actual');

export const SCREENS = [
  { id: 'G1', path: '/', name: 'g1-landing.png' },
  { id: 'G2', path: '/app/login', name: 'g2-login.png' },
];

async function run() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  for (const screen of SCREENS) {
    await page.goto(`${baseUrl}${screen.path}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(outDir, screen.name), fullPage: true });
  }

  await browser.close();
  if (pageErrors.length > 0) {
    console.error('Page errors detected:', pageErrors);
    process.exit(1);
  }
  console.log(`Captured ${SCREENS.length} screen(s) to ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('screens.mjs')) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
