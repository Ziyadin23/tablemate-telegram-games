import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { launchScope, restoreSession, saveSession } from './session';
const session = { token: 'signed-token', player: { id: '7', name: 'Ada' } };
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it('restoration validates the token on the server and binds it to the launch', async () => {
  const scope = launchScope('user=7&hash=authentic'); saveSession(scope, session);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ player: session.player })); vi.stubGlobal('fetch', fetcher);
  expect(await restoreSession(scope, new AbortController().signal)).toEqual(session);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer signed-token');
  expect(await restoreSession(launchScope('user=8&hash=new-launch'), new AbortController().signal)).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('expiry and identity mismatch clear a stored session; network failure preserves it', async () => {
  const signal = new AbortController().signal; saveSession('scope', session);
  const fetcher = vi.fn().mockRejectedValue(new Error('Offline')); vi.stubGlobal('fetch', fetcher);
  await expect(restoreSession('scope', signal)).rejects.toThrow('Offline');
  fetcher.mockResolvedValue(Response.json({ player: session.player })); expect(await restoreSession('scope', signal)).toEqual(session);
  fetcher.mockResolvedValue(Response.json({ player: { id: '8', name: 'Bob' } })); expect(await restoreSession('scope', signal)).toBeNull();
  saveSession('scope', session); fetcher.mockResolvedValue(Response.json({ error: 'Expired' }, { status: 401 })); expect(await restoreSession('scope', signal)).toBeNull();
});
