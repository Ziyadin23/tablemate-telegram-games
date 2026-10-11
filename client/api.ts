export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class RequestTimeout extends Error {
  constructor() { super('Request timed out. Check your connection and retry safely.'); }
}
export const isTransient = (error: unknown) => !(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429;
export async function api<T>(path: string, token?: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController(); let expired = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { expired = true; controller.abort(); }, options.timeoutMs ?? 8000);
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.error || `Request failed (${response.status})`);
    if (data === null) throw new Error('The server returned an unreadable response. Please retry.');
    return data as T;
  } catch (error) {
    if (expired) throw new RequestTimeout();
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
  }
}
// One bounded retry; both attempts retain the operation's durable identity.
export async function retryOperation<T>(path: string, token: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + 12_000;
  try { return await api<T>(path, token, body, { signal, timeoutMs: 6000 }); }
  catch (error) {
    if (!isTransient(error) || signal?.aborted) throw error;
    if (Date.now() >= deadline) throw new RequestTimeout();
    return api<T>(path, token, body, { signal, timeoutMs: Math.max(1, Math.min(6000, deadline - Date.now())) });
  }
}
