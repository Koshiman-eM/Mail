import { defaultSleep } from "./util";
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

/** エラー文 (ccxt は URL・署名を含みうる) は伏せてから記録する */
export const redactedErrMsg = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

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
  /** 1 回の試行 (ヘッダー受信から本文の読み込み完了まで) のタイムアウト */
  timeoutMs?: number;
  /** 再試行回数 (既定 3)。5 秒ごとの気配取得など、次の周期がすぐ来る呼び出しは 0〜1 にする */
  retries?: number;
  baseDelayMs?: number;
  /** 本文サイズの上限 (バイト、既定 10MB。環境変数 HTTP_MAX_BODY_BYTES でも変更可)。超えたら再試行せずエラー */
  maxBodyBytes?: number;
  /** 429/503 の Retry-After を尊重するときの待ち時間の上限 (ミリ秒、既定 30 秒) */
  maxRetryAfterMs?: number;
  /** テスト用に差し替え可能 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number, url: string) {
    super(`応答本文が上限 (${limit} バイト) を超えました: ${redactUrl(url)}`);
    this.name = "BodyTooLargeError";
  }
}

export function backoffDelay(attempt: number, baseMs: number, rand: () => number = Math.random): number {
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/** Retry-After ヘッダー (秒数または HTTP 日付) をミリ秒にする。無効なら undefined */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

function defaultMaxBody(): number {
  const n = Number(process.env.HTTP_MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BODY_BYTES;
}

/**
 * 本文を最後まで読む (タイムアウトの AbortSignal が効いている間に)。
 * limit を超えたら: truncate なら切り詰めて返し、そうでなければ BodyTooLargeError。
 */
async function readBody(res: Response, limit: number, url: string, truncate: boolean): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(limit, url);
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > limit) {
      if (truncate) return buf.subarray(0, limit);
      throw new BodyTooLargeError(limit, url);
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel().catch(() => undefined);
      if (truncate) {
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        break;
      }
      throw new BodyTooLargeError(limit, url);
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * 成功 (2xx) なら本文を読み切った Response (res.json() / res.text() がそのまま使える) を返す。
 * タイムアウトは本文の読み込み完了まで有効。
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = 10_000, retries = 3, baseDelayMs = 500, fetchImpl = fetch, sleep = defaultSleep,
    maxBodyBytes = defaultMaxBody(), maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS, ...init
  } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let retryAfterMs: number | undefined;
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      if (res.ok) {
        const bytes = await readBody(res, maxBodyBytes, url, false);
        const headers = new Headers(res.headers);
        headers.delete("content-encoding"); // fetch が展開済み
        headers.delete("content-length");
        return new Response(bytes as unknown as ArrayBuffer, { status: res.status, statusText: res.statusText, headers });
      }
      const body = new TextDecoder().decode(await readBody(res, Math.min(maxBodyBytes, 64 * 1024), url, true).catch(() => new Uint8Array()));
      const err = new HttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err;
      if (res.status === 429 || res.status === 503) {
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        if (ra !== undefined) retryAfterMs = Math.min(ra, maxRetryAfterMs);
      }
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      if (e instanceof BodyTooLargeError) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      const delay = backoffDelay(attempt, baseDelayMs);
      await sleep(retryAfterMs !== undefined ? Math.max(delay, retryAfterMs) : delay);
    }
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
