/**
 * 外部 HTTP 呼び出しの共通ラッパー: タイムアウト + 指数バックオフ (ジッター付き) リトライ。
 * 429 / 5xx / ネットワークエラーのみ再試行し、4xx は即失敗。
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export interface FetchOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  /** テスト用に差し替え可能 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, baseMs: number, rand: () => number = Math.random): number {
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp / 2 + rand() * (exp / 2));
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, retries = 3, baseDelayMs = 500, fetchImpl = fetch, sleep = defaultSleep, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const err = new HttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(backoffDelay(attempt, baseDelayMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, { ...opts, headers: { accept: "application/json", ...(opts.headers ?? {}) } });
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}
