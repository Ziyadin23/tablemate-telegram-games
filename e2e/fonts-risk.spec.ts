import { test, expect } from '@playwright/test';
test('R05: pending font CSS does not prevent the demo from mounting', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', () => {});
  const start = Date.now(); await page.goto('/', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible({ timeout: 3000 });
  console.log('R05 startup with stalled font CSS (ms):', Date.now() - start);
});
