import { test, expect, type Browser, type Page } from '@playwright/test';

async function table(browser: Browser, alice: Page, game: string) {
  await alice.goto('/'); await alice.getByRole('button', { name: `Play ${game}`, exact: true }).click();
  await expect(alice.getByRole('heading', { name: 'Waiting for player' })).toBeVisible();
  await expect(alice.locator('.waiting-countdown')).toBeVisible();
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bob = await bobContext.newPage(); const url = new URL(alice.url()); url.searchParams.set('player', 'Bob');
  await bob.goto(url.toString());
  await expect(bob.getByRole('button', { name: /join|invit|share/i })).toHaveCount(0);
  await expect(alice.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await expect(alice.locator('.waiting-countdown')).toHaveCount(0);
  return { bob, bobContext };
}

test('two friends finish tic-tac-toe and resume the saved result', async ({ page, browser }) => {
  const { bob, bobContext } = await table(browser, page, 'Tic-tac-toe');
  for (const [i, cell] of [1, 4, 2, 5, 3].entries()) {
    const actor = i % 2 ? bob : page, observer = i % 2 ? page : bob;
    await expect(actor.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
    await actor.getByRole('button', { name: `Cell ${cell} empty`, exact: true }).click();
    await expect(observer.getByRole('button', { name: `Cell ${cell} ${i % 2 ? 'O' : 'X'}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Alice won' })).toBeVisible(); await expect(bob.getByRole('heading', { name: 'Alice won' })).toBeVisible();
  const saved = page.url(); await page.reload(); await expect(page.getByRole('heading', { name: 'Alice won' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to games' }).click(); await page.getByRole('tab', { name: 'Finished', exact: true }).click(); await expect(page.locator('.match-list')).toContainText('Alice won');
  await page.goto(saved); await page.locator('.move-history summary').click(); await expect(page.locator('.move-history li')).toHaveCount(5); await bobContext.close();
});

test('chess moves synchronize on mobile and finish by checkmate', async ({ page, browser }) => {
  const { bob, bobContext } = await table(browser, page, 'Chess');
  for (const [actor, from, to] of [[page, 'f2', 'f3'], [bob, 'e7', 'e5'], [page, 'g2', 'g4'], [bob, 'd8', 'h4']] as [Page, string, string][]) {
    await expect(actor.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
    await actor.getByRole('button', { name: new RegExp(`^${from} `) }).click(); await actor.getByRole('button', { name: `${to} legal move`, exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Bob won' })).toBeVisible(); await expect(page.getByText('Checkmate', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/chess-mobile.png', fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path: 'test-results/chess-mobile-light.png', fullPage: true });
  await bobContext.close();
});

test('checkers lets both friends take a legal turn', async ({ page, browser }) => {
  const { bob, bobContext } = await table(browser, page, 'Checkers');
  await page.getByRole('button', { name: 'Square 17 red checker', exact: true }).click(); await page.getByRole('button', { name: 'Square 24 legal move', exact: true }).click();
  await expect(bob.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible(); await bob.getByRole('button', { name: 'Square 40 white checker', exact: true }).click(); await bob.getByRole('button', { name: 'Square 33 legal move', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible(); await expect(page.locator('.move-history li')).toHaveCount(2); await bobContext.close();
});

test('a disconnected player receives the latest board after reconnecting', async ({ page, browser }) => {
  const { bob, bobContext } = await table(browser, page, 'Tic-tac-toe');
  await bobContext.setOffline(true); await expect(bob.locator('.connection')).toHaveText('Reconnecting');
  await page.getByRole('button', { name: 'Cell 1 empty', exact: true }).click(); await bobContext.setOffline(false);
  await expect(bob.getByRole('button', { name: 'Cell 1 X', exact: true })).toBeVisible(); await expect(bob.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible(); await bobContext.close();
});

test('desktop lobby and mobile game chooser stay within the viewport', async ({ page, browser }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Play Chess', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel game', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm cancellation' }).getByRole('button', { name: 'Cancel game', exact: true }).click();
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a game' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); await desktop.goto('/'); await expect(desktop.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await expect(desktop.getByRole('button', { name: /join|invit|share/i })).toHaveCount(0);
  await desktop.screenshot({ path: 'test-results/lobby-desktop.png', fullPage: true }); await page.getByRole('button', { name: 'Back to games' }).click(); await page.screenshot({ path: 'test-results/lobby-mobile.png', fullPage: true }); await desktop.close();
});

test('the board fits a small phone without extra joining or sharing controls', async ({ page, browser }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const { bobContext } = await table(browser, page, 'Chess');
  const board = await page.getByRole('group', { name: 'Chess board' }).boundingBox();
  expect(board).not.toBeNull(); expect(board!.y + board!.height).toBeLessThan(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: /join|invit|share/i })).toHaveCount(0);
  await bobContext.close();
});

test('opening retries safely when the first response is lost after joining', async ({ page, browser }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Play Chess', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for player' })).toBeVisible();
  const bobContext = await browser.newContext(); const bob = await bobContext.newPage();
  let opens = 0;
  await bob.route('**/api/matches/*/open', async route => {
    opens++;
    if (opens === 1) { await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  const url = new URL(page.url()); url.searchParams.set('player', 'Bob'); await bob.goto(url.toString());
  await expect(page.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await expect(bob.getByRole('heading', { name: 'Alice’s turn', exact: true })).toBeVisible();
  expect(opens).toBe(2); await expect(bob.getByRole('alert')).toHaveCount(0);
  await bobContext.close();
});
