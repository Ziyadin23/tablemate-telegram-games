import 'dotenv/config';
import { randomBytes } from 'node:crypto';

export type Config = { mode: 'demo' | 'telegram'; port: number; host: string; dbPath: string; publicUrl: string; botToken: string; botUsername: string; sessionSecret: string; production: boolean };
export function readConfig(): Config {
  const mode = process.env.APP_MODE ?? 'demo';
  const production = process.env.NODE_ENV === 'production';
  if (mode !== 'demo' && mode !== 'telegram') throw new Error('APP_MODE must be demo or telegram');
  if (production && mode === 'demo') throw new Error('Demo authentication is disabled in production. Set APP_MODE=telegram.');
  const botToken = process.env.BOT_TOKEN ?? '', botUsername = (process.env.BOT_USERNAME ?? '').replace(/^@/, '');
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173').replace(/\/$/, '');
  if (mode === 'telegram' && (!botToken || !botUsername || !publicUrl.startsWith('https://'))) throw new Error('Telegram mode requires BOT_TOKEN, BOT_USERNAME and an HTTPS PUBLIC_URL.');
  const sessionSecret = process.env.SESSION_SECRET || (mode === 'demo' ? 'tablemate-local-demo-only-session-secret' : randomBytes(32).toString('hex'));
  if (production && (!process.env.SESSION_SECRET || sessionSecret.length < 32)) throw new Error('Production requires SESSION_SECRET of at least 32 characters.');
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
  return { mode, production, port, host: mode === 'demo' ? '127.0.0.1' : '0.0.0.0', dbPath: process.env.DB_PATH || `data/${mode}.sqlite`, publicUrl, botToken, botUsername, sessionSecret };
}
