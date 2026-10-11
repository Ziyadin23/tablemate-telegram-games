import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Player } from '../shared/types.js';

export class AppError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
function equal(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function validateTelegramData(raw: string, botToken: string, now = Date.now()): Player {
  const data = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key] of data) { if (seen.has(key)) throw new AppError(401, 'Invalid Telegram session'); seen.add(key); }
  const hash = data.get('hash'); data.delete('hash');
  const check = [...data.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  const date = Number(data.get('auth_date'));
  if (!hash || !equal(hash, expected) || !date || date * 1000 < now - 10 * 60_000 || date * 1000 > now + 30_000) throw new AppError(401, 'Your Telegram session expired. Reopen the app from Telegram.');
  let user: { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown };
  try { user = JSON.parse(data.get('user') ?? 'null'); } catch { throw new AppError(401, 'Missing Telegram identity'); }
  if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || typeof user.first_name !== 'string') throw new AppError(401, 'Missing Telegram identity');
  return { id: String(user.id), name: [user.first_name, typeof user.last_name === 'string' ? user.last_name : ''].filter(Boolean).join(' ').slice(0, 128), ...(typeof user.username === 'string' ? { username: user.username } : {}) };
}
export function issueSession(playerId: string, secret: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: playerId, exp: now + 24 * 60 * 60_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifySession(token: string, secret: string): string {
  if (token.length > 2048) throw new AppError(401, 'Invalid session');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) throw new AppError(401, 'Invalid session');
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof value.sub === 'string' && typeof value.exp === 'number' && value.exp > Date.now()) return value.sub;
  } catch { /* handled below */ }
  throw new AppError(401, 'Session expired. Reopen the app.');
}
