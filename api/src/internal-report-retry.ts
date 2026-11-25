/** The dashboard and support binding retry only a marked, read-only internal report, using the original scope/URL. */
export async function waitForPendingReport(method: string, path: string, body: unknown, retryAfter: string | null, signal?: AbortSignal) {
  if (method !== 'GET' || !/^\/v1\/(?:support|operator)\//.test(path) || !body || typeof body !== 'object' ||
    !('kind' in body) || body.kind !== 'report' || !('status' in body) || body.status !== 'pending') return false;
  const now = Date.now(), value = retryAfter?.trim() ?? '';
  const date = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  const until = Math.max(now + 1000, Number.isSafeInteger(date) ? date : now + 10_000);
  do {
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new DOMException('The report read was aborted.', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.min(2_147_483_647, until - Date.now()));
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  } while (Date.now() < until);
  return true;
}
