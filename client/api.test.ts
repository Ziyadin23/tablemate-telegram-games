import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, RequestTimeout, retryOperation } from './api';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function stalled() {
  vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })));
}
it('a request deadline aborts the transport and settles the caller', async () => {
  vi.useFakeTimers(); stalled(); const request = api('/matches'); const check = expect(request).rejects.toBeInstanceOf(RequestTimeout);
  await vi.advanceTimersByTimeAsync(8000); await check;
});
it('cancellation aborts the transport without a second mutation', async () => {
  vi.useFakeTimers(); stalled(); const controller = new AbortController();
  const request = retryOperation('/matches', 'token', { requestId: 'same-id' }, controller.signal);
  const check = expect(request).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await check; expect(fetch).toHaveBeenCalledTimes(1);
});
it('non-JSON transient failures retry the identical body; conflicts do not retry', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>Unavailable</html>', { status: 503 })).mockResolvedValueOnce(Response.json({ match: 'saved' })); vi.stubGlobal('fetch', fetcher);
  const intent = { actionId: 'unchanged-id', version: 7, kind: 'move' };
  expect(await retryOperation('/matches/m/actions', 'token', intent)).toEqual({ match: 'saved' });
  expect(fetcher.mock.calls.map(call => call[1].body)).toEqual([JSON.stringify(intent), JSON.stringify(intent)]);
  fetcher.mockReset().mockResolvedValue(Response.json({ error: 'Conflict' }, { status: 409 }));
  await expect(retryOperation('/matches/m/actions', 'token', intent)).rejects.toBeInstanceOf(ApiError); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('response body consumption is covered by the deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => Promise.resolve({ ok: true, json: () => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) })));
  const request = api('/matches'); const check = expect(request).rejects.toBeInstanceOf(RequestTimeout); await vi.advanceTimersByTimeAsync(8000); await check;
});
