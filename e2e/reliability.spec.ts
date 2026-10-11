import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { validateTelegramData } from '../server/auth';

async function waiting(page: any) {
  await page.goto('/'); await page.getByRole('button', { name: 'Play Chess', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for player' })).toBeVisible();
  return new URL(page.url());
}

test('QA01: reconnect retries auto-join after both initial open requests fail', async ({ page, browser, request }) => {
  const url = await waiting(page); url.searchParams.set('player', 'Bob');
  const context = await browser.newContext(); const bob = await context.newPage(); let opens = 0, failOpens = true;
  await bob.route('**/api/matches/*/open', async route => { opens++; if (failOpens) await route.abort(); else await route.continue(); });
  await bob.goto(url.toString()); await expect.poll(() => opens).toBeGreaterThanOrEqual(2);
  await context.setOffline(true); await expect(bob.locator('.connection')).toContainText('Reconnecting');
  failOpens = false; await context.setOffline(false); await expect(bob.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  console.log('QA01 open requests after reconnect:', opens);
  await expect(bob.getByRole('heading', { name: 'Alice’s turn', exact: true })).toBeVisible({ timeout: 3000 });
  await context.close();
});

test('QA02: HTTP 503 on open recovers and joins when connectivity returns', async ({ page, browser }) => {
  const url = await waiting(page); url.searchParams.set('player', 'Bob');
  const context = await browser.newContext(); const bob = await context.newPage(); let opens = 0;
  await bob.route('**/api/matches/*/open', async route => { opens++; if (opens === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary outage' }) }); else await route.continue(); });
  await bob.goto(url.toString()); await expect.poll(() => opens).toBeGreaterThanOrEqual(1);
  await context.setOffline(true); await context.setOffline(false); await expect(bob.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  console.log('QA02 open requests after reconnect:', opens);
  await expect(bob.getByRole('heading', { name: 'Alice’s turn', exact: true })).toBeVisible({ timeout: 3000 });
  await context.close();
});

test('QA03: an expired launch payload can reload using its valid app session', async ({ page, request }) => {
  const user = { id: 7, first_name: 'Alice' }; const data = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...data].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('123:qa').digest(); data.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  let authCalls = 0;
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(data.toString())},colorScheme:'dark',themeParams:{},ready(){},expand(){},onEvent(){},offEvent(){}}};` }));
  await page.route('**/api/config', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'telegram', botUsername: 'qa_bot' }) }));
  await page.route('**/api/auth/telegram', async route => {
    authCalls++;
    try {
      validateTelegramData(route.request().postDataJSON().initData, '123:qa', Date.now() + (authCalls > 1 ? 11 * 60_000 : 0));
      const response = await request.post('/api/auth/demo', { data: { player: 'Alice' } });
      await route.fulfill({ contentType: 'application/json', body: await response.text() });
    } catch { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your Telegram session expired. Reopen the app from Telegram.' }) }); }
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await page.reload();
  console.log('QA03 authentication calls after reload:', authCalls);
  await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible({ timeout: 3000 });
  expect(authCalls).toBe(1);
});

test('QA04: lost creation response still opens the one committed game', async ({ page, request }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  const ids: string[] = []; const committed = new Set<string>();
  await page.route('**/api/matches', async route => { if (route.request().method() === 'POST') { ids.push(route.request().postDataJSON().requestId); const response = await route.fetch(); committed.add((await response.json()).match.id); await route.abort(); } else await route.continue(); });
  await page.getByRole('button', { name: 'Play Chess', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for player' })).toBeVisible({ timeout: 3000 });
  expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1); expect(committed.size).toBe(1);
});

test('QA05: expired websocket token in lobby produces a reopen-session message', async ({ page }) => {
  let sockets = 0;
  await page.routeWebSocket('**/ws', ws => {
    sockets++; ws.onMessage(message => {
      const data = JSON.parse(String(message));
      if (data.type === 'auth') { ws.send(JSON.stringify({ type: 'error', error: 'Session expired. Reopen the app.' })); ws.close({ code: 1008, reason: 'Session expired' }); }
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unable to open game' })).toBeVisible();
  expect(sockets).toBe(1);
});

test('QA06: promotion moves keyboard focus into its modal and Escape closes it', async ({ page, request }) => {
  const alice = await request.post('/api/auth/demo', { data: { player: 'Alice' } }).then(r => r.json());
  const bob = await request.post('/api/auth/demo', { data: { player: 'Bob' } }).then(r => r.json());
  let match = (await request.post('/api/matches', { headers: { authorization: `Bearer ${alice.token}` }, data: { game: 'chess' } }).then(r => r.json())).match;
  match = (await request.post(`/api/matches/${match.id}/open`, { headers: { authorization: `Bearer ${bob.token}` }, data: {} }).then(r => r.json())).match;
  const sequence = [['a2','a4'],['h7','h5'],['a4','a5'],['h5','h4'],['a5','a6'],['h4','h3'],['a6','b7'],['h3','g2']];
  for (const [i, [from,to]] of sequence.entries()) match = (await request.post(`/api/matches/${match.id}/actions`, { headers: { authorization: `Bearer ${i % 2 ? bob.token : alice.token}` }, data: { kind: 'move', actionId: crypto.randomUUID(), version: match.version, move: { kind: 'chess', from, to } } }).then(r => r.json())).match;
  await page.goto(`/?match=${match.id}`); await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  await page.getByRole('button', { name: 'b7 white pawn', exact: true }).click(); await page.getByRole('button', { name: 'a8 black rook legal move', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose promotion piece' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Promote to queen' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Promote to queen' })).toBeFocused();
  await page.getByRole('button', { name: 'Resign', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm resignation' });
  await expect(confirmation.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Promote to queen' })).toBeFocused();
  const focusedInside = await dialog.evaluate(el => el.contains(document.activeElement)); console.log('QA06 focus inside promotion modal:', focusedInside);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0, { timeout: 1500 });
  expect(focusedInside).toBe(true);
  await expect(page.getByRole('button', { name: 'a8 black rook legal move', exact: true })).toBeFocused();
});

test('QA07: stalled game creation releases busy state after a request deadline', async ({ page }) => {
  await page.clock.install(); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await page.route('**/api/matches', async route => {
    if (route.request().method() === 'POST') return;
    await route.continue();
  });
  const play = page.getByRole('button', { name: 'Play Chess', exact: true }); await play.click();
  await expect(play).toBeDisabled(); await page.clock.fastForward(120_000);
  await expect(play).toBeEnabled({ timeout: 1500 });
});

test('QA08: websocket authentication stall has a recovery deadline', async ({ page }) => {
  await page.clock.install(); let connections = 0;
  await page.routeWebSocket('**/ws', ws => { connections++; ws.onMessage(() => {}); });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.locator('.connection')).toHaveText('Reconnecting');
  await page.clock.fastForward(8000);
  // Socket close events are asynchronous; let them dispatch before advancing backoff.
  await page.clock.runFor(1000);
  await page.clock.fastForward(111_000);
  await page.clock.runFor(1000);
  console.log('QA08 websocket connections after 2 minutes:', connections);
  expect(connections).toBeGreaterThan(1);
});

test('QA09: failed saved-game loading exposes a retryable error', async ({ page }) => {
  await page.route('**/api/matches', async route => { if (route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary outage' }) }); else await route.continue(); });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 1500 });
});

test('QA10: blocking the external Telegram SDK still allows the demo to load', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', () => {});
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible({ timeout: 3000 });
});

test('QA11: count saved-list refreshes generated by one normal move', async ({ page, browser }) => {
  const url = await waiting(page); url.searchParams.set('player', 'Bob');
  const context = await browser.newContext(); const bob = await context.newPage(); await bob.goto(url.toString());
  await expect(page.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await expect(bob.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  let aliceLists = 0, bobLists = 0;
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/matches' && req.method() === 'GET') aliceLists++; });
  bob.on('request', req => { if (new URL(req.url()).pathname === '/api/matches' && req.method() === 'GET') bobLists++; });
  await page.route('**/api/matches/*/actions', async route => {
    const response = await route.fetch();
    // The WS event arrives before a delayed HTTP response; they still cause one list GET.
    await new Promise(resolve => setTimeout(resolve, 500)); await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'e2 white pawn', exact: true }).click(); await page.getByRole('button', { name: 'e4 legal move', exact: true }).click();
  await expect(bob.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resign', exact: true })).toBeEnabled();
  await expect.poll(() => aliceLists).toBe(1); await expect.poll(() => bobLists).toBe(1);
  // Observe beyond the refresh coalescing window so a delayed duplicate is caught.
  await page.waitForTimeout(250);
  console.log('QA11 list requests after one move:', JSON.stringify({ aliceLists, bobLists }));
  expect(aliceLists).toBe(1); expect(bobLists).toBe(1);
  await context.close();
});

test('QA12: a late list response cannot replace a newer saved-game snapshot', async ({ page, request }) => {
  const alice = await request.post('/api/auth/demo', { data: { player: 'Alice' } }).then(r => r.json());
  const bob = await request.post('/api/auth/demo', { data: { player: 'Bob' } }).then(r => r.json());
  let old = (await request.post('/api/matches', { headers: { authorization: `Bearer ${alice.token}` }, data: { game: 'chess' } }).then(r => r.json())).match;
  old = (await request.post(`/api/matches/${old.id}/open`, { headers: { authorization: `Bearer ${bob.token}` }, data: {} }).then(r => r.json())).match;
  const latest = (await request.post(`/api/matches/${old.id}/actions`, { headers: { authorization: `Bearer ${alice.token}` }, data: { kind: 'move', actionId: crypto.randomUUID(), version: old.version, move: { kind: 'chess', from: 'e2', to: 'e4' } } }).then(r => r.json())).match;
  const summary = (m: typeof old) => { const { state, history, legalMoves, drawOffer, ...row } = m; return row; };
  let pending: any; let reads = 0;
  await page.route('**/api/matches', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++;
    if (reads === 1) { pending = route; return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ matches: [summary(latest)] }) });
  });
  await page.goto('/'); await expect.poll(() => reads).toBe(1);
  // A visibility recovery requests a newer list while the first request is pending.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.match-row')).toContainText('Their turn');
  const oldResponse = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/matches' && (await response.json()).matches?.[0]?.version === old.version);
  await pending.fulfill({ contentType: 'application/json', body: JSON.stringify({ matches: [summary(old)] }) }); await oldResponse;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.match-row')).toContainText('Their turn', { timeout: 1500 });
});

test('SDK deadline exposes boot recovery and a retry can load Telegram', async ({ page, request }) => {
  await page.clock.install(); let blocked = true;
  await page.route('https://telegram.org/js/telegram-web-app.js*', route => {
    if (blocked) return;
    return route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'mock-signed-launch',colorScheme:'dark',themeParams:{},ready(){},expand(){},onEvent(){},offEvent(){}}};` });
  });
  await page.route('**/api/config', route => route.fulfill({ json: { mode: 'telegram', botUsername: 'qa_bot' } }));
  await page.route('**/api/auth/telegram', async route => { const response = await request.post('/api/auth/demo', { data: { player: 'Alice' } }); await route.fulfill({ json: await response.json() }); });
  await page.goto('/', { waitUntil: 'commit' }); await expect(page.getByText('Loading…', { exact: true })).toBeVisible();
  await page.clock.runFor(100); await page.clock.fastForward(8000);
  await expect(page.getByRole('heading', { name: 'Unable to open game' })).toBeVisible(); await expect(page.getByText(/Telegram is taking too long/)).toBeVisible();
  blocked = false; await page.getByRole('button', { name: 'Try again' }).click(); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
});

test('saved-list recovery preserves previous rows and newer authoritative removals', async ({ page }) => {
  let state: 'success' | 'failure' | 'empty' = 'success';
  const row = { id: 'saved-match-demo', game: 'chess', status: 'active', creator: { id: 'demo-alice', name: 'Alice' }, opponent: { id: 'demo-bob', name: 'Bob' }, turn: 'first', result: null, version: 10, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  await page.route('**/api/matches', route => route.fulfill(state === 'failure' ? { status: 503, json: { error: 'Temporary outage' } } : { json: { matches: state === 'empty' ? [] : [row] } }));
  await page.goto('/'); await expect(page.locator('.match-row')).toContainText('Your turn');
  state = 'failure'; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('alert')).toContainText('Showing previously loaded games'); await expect(page.locator('.match-row')).toContainText('Your turn');
  state = 'empty'; await page.getByRole('button', { name: 'Retry saved games' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.match-row')).toHaveCount(0); await expect(page.getByText('No active games.')).toBeVisible();
});

test('lost action responses can be retried with the original action ID without a second move', async ({ page, browser, request }) => {
  const url = await waiting(page); url.searchParams.set('player', 'Bob');
  const context = await browser.newContext(); const bob = await context.newPage(); await bob.goto(url.toString());
  await expect(page.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  const ids: string[] = []; let failing = true;
  await page.route('**/api/matches/*/actions', async route => { ids.push(route.request().postDataJSON().actionId); const response = await route.fetch(); if (failing) await route.abort(); else await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'e2 white pawn', exact: true }).click(); await page.getByRole('button', { name: 'e4 legal move', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved action' })).toBeEnabled(); failing = false;
  await page.getByRole('button', { name: 'Retry saved action' }).click(); await expect(page.getByRole('button', { name: 'Retry saved action' })).toHaveCount(0);
  expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(1);
  const auth = await request.post('/api/auth/demo', { data: { player: 'Alice' } }).then(r => r.json());
  const saved = await request.get(`/api/matches/${url.searchParams.get('match')}`, { headers: { authorization: `Bearer ${auth.token}` } }).then(r => r.json());
  expect(saved.match.history).toHaveLength(1); await context.close();
});

test('pending creation survives reload and resolves the original committed match', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  const committed: string[] = [];
  await page.route('**/api/matches', async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); committed.push((await response.json()).match.id); await route.abort(); });
  await page.route('**/api/creations/*', route => route.abort());
  await page.getByRole('button', { name: 'Play Chess', exact: true }).click(); await expect(page.getByRole('button', { name: 'Play Chess', exact: true })).toBeEnabled();
  expect(committed).toHaveLength(2); expect(new Set(committed).size).toBe(1);
  await page.unroute('**/api/creations/*'); await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting for player' })).toBeVisible(); expect(new URL(page.url()).searchParams.get('match')).toBe(committed[0]);
});

test('board navigation keeps one authenticated WebSocket', async ({ page }) => {
  let sockets = 0; page.on('websocket', ws => { if (new URL(ws.url()).pathname === '/ws') sockets++; });
  const url = await waiting(page); await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
  await page.getByRole('button', { name: 'Back to games' }).click(); await expect(page.getByRole('heading', { name: 'Play', exact: true })).toBeVisible();
  await page.goto(url.toString()); // A full reload necessarily creates a new connection.
  await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected'); expect(sockets).toBe(2);
  await page.getByRole('button', { name: 'Back to games' }).click();
  await page.locator('.match-row').filter({ hasText: 'Waiting' }).first().click(); await expect(page.getByRole('heading', { name: 'Waiting for player' })).toBeVisible(); expect(sockets).toBe(2);
});
