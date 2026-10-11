import { api, ApiError } from './api';
import type { Player } from '../shared/types';
export type Session = { token: string; player: Player };
const key = 'tablemate-session-v1';
const volatileStorage = new Map<string, unknown>();
export function readStored<T>(key: string): T | null { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return (volatileStorage.get(key) as T | undefined) ?? null; } }
export function writeStored(key: string, data: unknown) { if (data === null) volatileStorage.delete(key); else volatileStorage.set(key, data); try { if (data === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* The app still works when storage is unavailable. */ } }
export function forgetSession() { writeStored(key, null); }
export async function restoreSession(scope: string, signal: AbortSignal): Promise<Session | null> {
  const saved = readStored<{ scope: string; session: Session }>(key);
  if (!saved || saved.scope !== scope || !saved.session?.token) return null;
  try {
    const data = await api<{ player: Player }>('/session', saved.session.token, undefined, { signal });
    if (data.player.id !== saved.session.player.id) { forgetSession(); return null; }
    return { token: saved.session.token, player: data.player };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { forgetSession(); return null; }
    throw error; // A network failure is not evidence that a session is invalid.
  }
}
export function saveSession(scope: string, session: Session) { writeStored(key, { scope, session }); }
export function launchScope(initData: string): string {
  // Bind restoration to the exact launch, including its signature. Never trust unsigned
  // user fields to select a different identity. A new launch must authenticate afresh.
  return `telegram:${initData}`;
}
let sdk: Promise<NonNullable<Window['Telegram']>['WebApp']> | null = null;
let sdkAttempts = 0;
export function loadTelegramSDK(signal: AbortSignal): Promise<NonNullable<Window['Telegram']>['WebApp']> {
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  if (!sdk) sdk = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Removing a script cannot cancel its underlying download. A retry must not
    // attach to the same stalled browser resource request.
    script.src = `https://telegram.org/js/telegram-web-app.js${sdkAttempts++ ? `?tablemate_retry=${sdkAttempts}` : ''}`;
    script.async = true;
    const finish = (error?: Error) => {
      clearTimeout(timer); script.onload = script.onerror = null;
      if (error) { script.remove(); sdk = null; reject(error); }
      else if (window.Telegram?.WebApp) resolve(window.Telegram.WebApp);
      else { script.remove(); sdk = null; reject(new Error('Telegram did not load. Try again or reopen this app from Telegram.')); }
    };
    const timer = setTimeout(() => finish(new Error('Telegram is taking too long to load. Try again or reopen this app from Telegram.')), 8000);
    script.onload = () => finish(); script.onerror = () => finish(new Error('Could not load Telegram. Check your connection and try again.'));
    document.head.append(script);
  });
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    sdk!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
