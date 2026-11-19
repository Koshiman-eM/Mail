/**
 * 外部 HTTP 呼び出しの共通ラッパー: タイムアウト + 指数バックオフ (ジッター付き) リトライ。
 * 429 / 5xx / ネットワークエラーのみ再試行し、4xx は即失敗。
 * エラーメッセージにはクエリ文字列とトークンらしき文字列を出さない。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_KEYS = "auth_token|access_token|refresh_token|api[_-]?key|apikey|api[_-]?secret|secret(?:_key)?|token|password|passphrase|signature|key";

/** 文字列中のトークンらしき部分を伏せる (エラーメッセージ・ログ用。過剰に伏せる方向に倒す) */
export function redactSecrets(text: string): string {
  return (
    text
      // key=value (クエリ・フォーム)
      .replace(new RegExp(`\\b(${SECRET_KEYS})=([^&\\s"'<>]+)`, "gi"), "$1=***")
      // "key": "value" (JSON)
      .replace(new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"[^"]*"`, "gi"), '$1"***"')
      // Authorization ヘッダー相当
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
      // 英字と数字が混ざった 32 文字以上の連続 (API キー・JWT の各部など)。注文 ID 等の UUID は残す
      .replace(/[A-Za-z0-9_+=-]{32,}/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) && !UUID_RE.test(m) ? "***" : m))
  );
}

/** URL のクエリ文字列 (トークン等を含みうる) を伏せる。パスにキーを含む API もあるのでパスも redactSecrets に通す */
export function redactUrl(url: string): string {
  const i = url.indexOf("?");
  return redactSecrets(i < 0 ? url : `${url.slice(0, i)}?***`);
}

export class HttpError extends Error {
  /** クエリ文字列を伏せた URL */
  public readonly url: string;
  constructor(
    public readonly status: number,
    url: string,
    /** 応答本文 (呼び出し側の判定用に生のまま保持する。表示・ログには redactSecrets を通す) */
    public readonly body: string,
  ) {
    const safeUrl = redactUrl(url);
    super(`HTTP ${status} ${safeUrl}: ${redactSecrets(body.slice(0, 200))}`);
    this.name = "HttpError";
    this.url = safeUrl;
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
