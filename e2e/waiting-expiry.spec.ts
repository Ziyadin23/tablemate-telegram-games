import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';

for (const game of ['Chess', 'Checkers', 'Tic-tac-toe']) {
  test(`${game} counts down without resetting on reload and disbands when nobody joins`, async ({ page, browser }) => {
    await page.goto('/');
    const creation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/matches' && response.request().method() === 'POST');
    await page.getByRole('button', { name: `Play ${game}`, exact: true }).click();
    const waiting = (await (await creation).json()).match;
    expect(Date.parse(waiting.waitingExpiresAt) - Date.parse(waiting.createdAt)).toBe(180_000);
    const countdown = page.locator('.waiting-countdown');
    await expect(countdown).toContainText('Disbands in');
    const first = await countdown.textContent();
    await expect.poll(() => countdown.textContent()).not.toBe(first);
    const reopened = page.waitForResponse(response => new URL(response.url()).pathname === `/api/matches/${waiting.id}/open`);
    await page.reload();
    expect((await (await reopened).json()).match.waitingExpiresAt).toBe(waiting.waitingExpiresAt);
    await expect(countdown).toContainText('Disbands in');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/waiting-${waiting.game}.png`, fullPage: true });

    await page.getByRole('button', { name: 'Cancel game', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm cancellation' })).toBeVisible();
    // Accelerate the persisted deadline while keeping the real expiry worker and socket flow.
    const db = new Database('data/e2e.sqlite');
    try { db.prepare('UPDATE matches SET waiting_expires_at=? WHERE id=?').run(new Date(Date.now() + 250).toISOString(), waiting.id); }
    finally { db.close(); }
    await expect(page.getByRole('heading', { name: 'Game disbanded', exact: true })).toBeVisible();
    await expect(page.getByText('No second player joined in time.', { exact: true })).toBeVisible();
    await expect(countdown).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel game', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New game', exact: true })).toBeVisible();
    const saved = page.url();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Game disbanded', exact: true })).toBeVisible();
    const context = await browser.newContext(), bob = await context.newPage();
    try {
      const url = new URL(saved); url.searchParams.set('player', 'Bob'); await bob.goto(url.toString());
      await expect(bob.getByRole('heading', { name: 'Game disbanded', exact: true })).toBeVisible();
      await expect(bob.getByRole('heading', { name: 'Your turn', exact: true })).toHaveCount(0);
    } finally { await context.close(); }
    await page.getByRole('button', { name: 'Back to games' }).click();
    await page.getByRole('tab', { name: 'Finished', exact: true }).click();
    await expect(page.locator('.match-row').filter({ hasText: game }).first()).toContainText('Disbanded');
  });
}
