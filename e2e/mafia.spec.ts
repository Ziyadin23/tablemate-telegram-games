import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';

async function create(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'Play Mafia', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gather your players', exact: true })).toBeVisible();
  return new URL(page.url()).searchParams.get('match')!;
}
async function choose(page: Page, target: string, phase: 'night' | 'day') {
  await page.getByRole('button', { name: `${target} select target`, exact: true }).click();
  await page.getByRole('button', { name: phase === 'night' ? 'Confirm night action' : 'Confirm vote', exact: true }).click();
}
function accelerate(id: string, kind: 'lobby' | 'phase') {
  const db = new Database('data/e2e.sqlite'), until = new Date(Date.now() + 250).toISOString();
  try {
    if (kind === 'lobby') db.prepare('UPDATE matches SET waiting_expires_at=? WHERE id=?').run(until, id);
    else db.prepare("UPDATE matches SET phase_expires_at=?,state=json_set(state,'$.phaseExpiresAt',?) WHERE id=?").run(until, until, id);
  } finally { db.close(); }
}
test('five friends play Mafia with private roles, investigation, voting, and a saved town victory', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const id = await create(page), contexts = [], players = new Map<string, Page>([['Alice', page]]);
  try {
    await expect(page.getByRole('button', { name: 'Start Mafia', exact: true })).toBeDisabled();
    for (const name of ['Bob', 'Carol', 'Dave', 'Eve']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
      const friend = await context.newPage(); await friend.goto(`/?match=${id}&player=${name}`); players.set(name, friend);
      await expect(friend.getByRole('heading', { name: 'Gather your players', exact: true })).toBeVisible();
    }
    await expect(page.getByText('5/10 players · 5 needed to start', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/mafia-lobby-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Start Mafia', exact: true }).click();
    const roles = new Map<string, string>();
    for (const [name, friend] of players) {
      await expect(friend.getByRole('heading', { name: 'Night 1', exact: true })).toBeVisible();
      roles.set(name, (await friend.getByRole('region', { name: 'Your secret role' }).getByRole('heading').textContent())!);
      await expect(friend.locator('.mafia-roster')).not.toContainText(/Doctor|Detective|Villager|Mafia/);
    }
    await page.reload(); await expect(page.getByRole('region', { name: 'Your secret role' })).toContainText(roles.get('Alice')!);
    await page.screenshot({ path: 'test-results/mafia-night-mobile.png', fullPage: true });
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.screenshot({ path: 'test-results/mafia-night-mobile-light.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const observerContext = await browser.newContext(); contexts.push(observerContext); const observer = await observerContext.newPage();
    await observer.goto(`/?match=${id}&player=Frank`);
    await expect(observer.getByText('Watching', { exact: true })).toBeVisible();
    await expect(observer.getByRole('region', { name: 'Your secret role' })).toHaveCount(0);
    await expect(observer.getByRole('button', { name: /Confirm night action|Confirm vote/ })).toHaveCount(0);
    const nameFor = (role: string) => [...roles].find(([, assigned]) => assigned === role)![0];
    const mafia = nameFor('Mafia'), doctor = nameFor('Doctor'), detective = nameFor('Detective'), villager = nameFor('Villager');
    await Promise.all([choose(players.get(mafia)!, villager, 'night'), choose(players.get(doctor)!, villager, 'night'), choose(players.get(detective)!, mafia, 'night')]);
    for (const friend of players.values()) await expect(friend.getByRole('heading', { name: 'Day 1', exact: true })).toBeVisible();
    await expect(players.get(detective)!.getByRole('region', { name: 'Your investigations' })).toContainText(`${mafia}: Mafia`);
    for (const [name, friend] of players) if (name !== detective) await expect(friend.getByRole('region', { name: 'Your investigations' })).toHaveCount(0);
    await expect(observer.getByRole('region', { name: 'Your investigations' })).toHaveCount(0);
    await Promise.all([...players].map(([name, friend]) => choose(friend, name === mafia ? doctor : mafia, 'day')));
    for (const friend of players.values()) await expect(friend.getByRole('heading', { name: 'Town won', exact: true })).toBeVisible();
    await expect(observer.getByRole('heading', { name: 'Town won', exact: true })).toBeVisible();
    await expect(page.locator('.mafia-roster')).toContainText('Detective'); await expect(page.locator('.mafia-roster')).toContainText('Doctor');
    await page.reload(); await expect(page.getByRole('heading', { name: 'Town won', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to games' }).click(); await page.getByRole('tab', { name: 'Finished', exact: true }).click();
    await expect(page.locator('.match-row').filter({ hasText: 'Mafia' }).first()).toContainText('Town won');
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    try { await desktop.goto(`/?match=${id}`); await expect(desktop.getByRole('heading', { name: 'Town won', exact: true })).toBeVisible(); await desktop.screenshot({ path: 'test-results/mafia-desktop.png', fullPage: true }); }
    finally { await desktop.close(); }
  } finally { for (const context of contexts) await context.close(); }
});
test('Mafia lobby expiry starts a populated room and timed phases continue without player actions', async ({ page, request }) => {
  const id = await create(page);
  for (const player of ['Bob', 'Carol', 'Dave', 'Eve']) {
    const auth = await request.post('/api/auth/demo', { data: { player } }).then(response => response.json());
    await request.post(`/api/matches/${id}/open`, { headers: { authorization: `Bearer ${auth.token}` }, data: {} });
  }
  await expect(page.getByText('5/10 players · 5 needed to start', { exact: true })).toBeVisible();
  accelerate(id, 'lobby'); await expect(page.getByRole('heading', { name: 'Night 1', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your secret role' })).toBeVisible();
  accelerate(id, 'phase'); await expect(page.getByRole('heading', { name: 'Day 1', exact: true })).toBeVisible();
  accelerate(id, 'phase'); await expect(page.getByRole('heading', { name: 'Night 2', exact: true })).toBeVisible();
  await expect(page.locator('.mafia-events')).toContainText('The vote ended without an elimination.');
});
test('Mafia disbands a lobby without enough players and supports cancellation and a new game', async ({ page, request }) => {
  const id = await create(page), bob = await request.post('/api/auth/demo', { data: { player: 'Bob' } }).then(response => response.json());
  await request.post(`/api/matches/${id}/open`, { headers: { authorization: `Bearer ${bob.token}` }, data: {} });
  await expect(page.getByText('2/10 players · 5 needed to start', { exact: true })).toBeVisible();
  accelerate(id, 'lobby'); await expect(page.getByRole('heading', { name: 'Game disbanded', exact: true })).toBeVisible();
  await expect(page.getByText('Not enough players joined in time. Mafia needs at least 5 players.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New game', exact: true }).click(); await page.getByRole('button', { name: 'Play Mafia', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel game', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm cancellation' }).getByRole('button', { name: 'Cancel game', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Game cancelled', exact: true })).toBeVisible();
});
