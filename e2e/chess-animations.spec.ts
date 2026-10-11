import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import type { GameSnapshot } from '../shared/types';

type Point = { x: number; y: number };
type TravelSample = { from: string; to: string; start: Point; middle: Point; end: Point; source: Point; target: Point };
type CaptureSample = { square: string; startOpacity: number; endOpacity: number };
declare global { interface Window { motionSamples: TravelSample[]; captureSamples: CaptureSample[] } }

async function prepare(request: APIRequestContext, moves: string[] = []) {
  const alice = await request.post('/api/auth/demo', { data: { player: 'Alice' } }).then(r => r.json());
  const bob = await request.post('/api/auth/demo', { data: { player: 'Bob' } }).then(r => r.json());
  let match: GameSnapshot = (await request.post('/api/matches', { headers: { authorization: `Bearer ${alice.token}` }, data: { game: 'chess' } }).then(r => r.json())).match;
  match = (await request.post(`/api/matches/${match.id}/open`, { headers: { authorization: `Bearer ${bob.token}` }, data: {} }).then(r => r.json())).match;
  const chess = new Chess();
  for (const [i, san] of moves.entries()) {
    const move = chess.move(san);
    const response = await request.post(`/api/matches/${match.id}/actions`, { headers: { authorization: `Bearer ${i % 2 ? bob.token : alice.token}` }, data: { kind: 'move', actionId: randomUUID(), version: match.version, move: { kind: 'chess', from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) } } });
    expect(response.ok()).toBe(true); match = (await response.json()).match;
  }
  return { match, alice, bob };
}
async function watchAnimations(page: Page) {
  await page.addInitScript(() => {
    window.motionSamples = []; window.captureSamples = [];
    const seen = new WeakSet<Element>();
    const center = (element: Element) => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    document.addEventListener('animationstart', event => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || seen.has(element) || !['chess-slide', 'chess-capture'].includes(event.animationName)) return;
      const animation = element.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === event.animationName);
      if (!animation?.effect) return;
      seen.add(element); animation.pause();
      const duration = Number(animation.effect.getTiming().duration);
      if (event.animationName === 'chess-slide') {
        const board = element.closest('.board-wrap')!.querySelector('.chess-board')!;
        const from = element.dataset.from!, to = element.dataset.to!;
        animation.currentTime = 0; const start = center(element);
        animation.currentTime = duration / 2; const middle = center(element);
        animation.currentTime = duration; const end = center(element);
        window.motionSamples.push({ from, to, start, middle, end, source: center(board.querySelector(`[data-square="${from}"]`)!), target: center(board.querySelector(`[data-square="${to}"]`)!) });
      } else {
        animation.currentTime = 0; const startOpacity = Number(getComputedStyle(element).opacity);
        animation.currentTime = duration; const endOpacity = Number(getComputedStyle(element).opacity);
        window.captureSamples.push({ square: element.dataset.square!, startOpacity, endOpacity });
      }
      animation.currentTime = 0; animation.play();
    });
  });
}
async function open(page: Page, id: string, player: 'Alice' | 'Bob') {
  await page.goto(`/?match=${id}&player=${player}`);
  await expect(page.getByRole('group', { name: 'Chess board' })).toBeVisible();
  await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected');
}
async function play(page: Page, from: string, to: string) {
  await expect(page.getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${from} `) }).click();
  await page.getByRole('button', { name: new RegExp(`^${to}(?: .*)? legal move$`) }).click();
}
function verifyPath(sample: TravelSample) {
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  expect(distance(sample.start, sample.source)).toBeLessThan(1);
  expect(distance(sample.end, sample.target)).toBeLessThan(1);
  expect(distance(sample.start, sample.middle)).toBeGreaterThan(1);
  expect(distance(sample.middle, sample.end)).toBeGreaterThan(1);
  expect(distance(sample.start, sample.middle)).toBeLessThan(distance(sample.start, sample.end));
}

test('local and opponent moves slide between the correct squares and en passant fades its pawn', async ({ page, browser, request }) => {
  const { match } = await prepare(request);
  const bob = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await watchAnimations(page); await watchAnimations(bob);
  await open(page, match.id, 'Alice'); await open(bob, match.id, 'Bob');
  for (const [actor, from, to] of [[page, 'e2', 'e4'], [bob, 'g8', 'f6'], [page, 'e4', 'e5'], [bob, 'd7', 'd5'], [page, 'e5', 'd6']] as [Page, string, string][]) await play(actor, from, to);
  for (const player of [page, bob]) {
    await expect.poll(() => player.evaluate(() => window.motionSamples.length)).toBe(5);
    const samples = await player.evaluate(() => window.motionSamples); samples.forEach(verifyPath);
    expect(samples.map(s => `${s.from}-${s.to}`)).toEqual(['e2-e4', 'g8-f6', 'e4-e5', 'd7-d5', 'e5-d6']);
    await expect.poll(() => player.evaluate(() => window.captureSamples)).toEqual([{ square: 'd5', startOpacity: 1, endOpacity: 0 }]);
    await expect(player.locator('.piece-motion-layer')).toHaveCount(0);
    await expect(player.getByRole('button', { name: 'd6 white pawn', exact: true })).toBeVisible();
    await expect(player.getByRole('button', { name: 'd5', exact: true })).toBeVisible();
  }
  const white = await page.evaluate(() => window.motionSamples[0]), black = await bob.evaluate(() => window.motionSamples[0]);
  expect(white.end.y).toBeLessThan(white.start.y); expect(black.end.y).toBeGreaterThan(black.start.y);
  await bob.close();
});

test('castling moves the king and rook together on both boards', async ({ page, browser, request }) => {
  const { match } = await prepare(request, ['e4', 'e5', 'Nf3', 'Nf6', 'Bc4', 'Bc5']);
  const bob = await browser.newPage(); await watchAnimations(page); await watchAnimations(bob);
  await open(page, match.id, 'Alice'); await open(bob, match.id, 'Bob');
  expect(await page.evaluate(() => window.motionSamples)).toEqual([]);
  await play(page, 'e1', 'g1'); await play(bob, 'e8', 'g8');
  for (const player of [page, bob]) {
    await expect.poll(() => player.evaluate(() => window.motionSamples.length)).toBe(4);
    const samples = await player.evaluate(() => window.motionSamples); samples.forEach(verifyPath);
    expect(samples.map(s => `${s.from}-${s.to}`)).toEqual(['e1-g1', 'h1-f1', 'e8-g8', 'h8-f8']);
    await expect(player.locator('.piece-motion-layer')).toHaveCount(0);
    await expect(player.getByRole('button', { name: 'f1 white rook', exact: true })).toBeVisible();
    await expect(player.getByRole('button', { name: 'f8 black rook', exact: true })).toBeVisible();
  }
  await bob.close();
});

test('reduced motion applies moves immediately and reopening does not replay them', async ({ page, request }) => {
  const { match } = await prepare(request);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await watchAnimations(page); await open(page, match.id, 'Alice');
  await play(page, 'e2', 'e4');
  await expect(page.getByRole('button', { name: 'e4 white pawn', exact: true })).toBeVisible();
  await expect(page.locator('.piece-motion-layer')).toHaveCount(0); expect(await page.evaluate(() => window.motionSamples)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.reload();
  await expect(page.getByRole('button', { name: 'e4 white pawn', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.motionSamples)).toEqual([]);
});
