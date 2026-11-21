/**
 * Jupiter (https://api.jup.ag) の読み取り専用 HTTP クライアント。
 *
 * 仕様の出典は Jupiter の公式資料 (検索で確認した記述)。この環境からは接続できず、実際の応答・上限は未確認 (要確認)。
 * - キーなしの利用は 1 秒あたり約 0.5 回まで (要確認)。API キーは `x-api-key` ヘッダー (環境変数 JUPITER_API_KEY を呼び出し側が読んで渡す)。
 * - レート制限はトークンバケット (TokenBucket) で自前に抑える。既定はキーなし 0.5 回/秒、キーあり 1 回/秒 (要確認: プランごとに違う)。
 * - 429 / 5xx / 通信エラーは src/core/http.ts の fetchWithRetry で指数バックオフ (Retry-After を尊重) して再試行する。
 *   再試行のたびにレート制限の枠も取り直す (再試行で上限を超えない)。
 * - エラー文にはキーを出さない (応答本文にキーが含まれていても伏せる)。キーはログにも出さない。
 * - 読み取り専用: GET だけで、呼べるのは価格・トークン情報・見積もり (quote / キーなしの order) のパスだけ。
 *   swap・execute (署名・送信) のパスは送信前に例外にする。
 * - fetch は注入できる (テストは完全オフライン)。
 */
import type { z } from "zod";
import { fetchWithRetry, HttpError, redactSecrets } from "../../core/http";
import { defaultSleep } from "../../core/util";
import { issuesOf, JupiterShapeError } from "./parse";

export const JUPITER_BASE_URL = "https://api.jup.ag";
/** キーなしの上限 (1 秒あたり。公式資料の記述。要確認) */
export const JUPITER_KEYLESS_RPS = 0.5;
/** キーありの既定 (1 秒あたり。要確認: プランごとに違うので JupiterClientOptions.ratePerSec で上書きする) */
export const JUPITER_KEYED_RPS = 1;

// ───────── レート制限 ─────────

export interface TokenBucketOptions {
  /** 1 秒あたりの補充量 (= 平均の呼び出し回数の上限) */
  ratePerSec: number;
  /** 貯められる最大の回数 (既定 1 = 連続呼び出しなし) */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * トークンバケット。acquire は呼び出し順に待つ (直列)。
 * 時刻と待機は注入できる (テストでは sleep で時計を進める)
 */
export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  private tokens: number;
  private last: number;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: TokenBucketOptions) {
    if (!(Number.isFinite(o.ratePerSec) && o.ratePerSec > 0)) throw new Error(`TokenBucket: ratePerSec は正の数にしてください (${o.ratePerSec})`);
    this.ratePerSec = o.ratePerSec;
    this.burst = Math.max(1, Math.floor(Number.isFinite(o.burst) ? (o.burst as number) : 1));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.tokens = this.burst;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.last);
    this.tokens = Math.min(this.burst, this.tokens + (dt * this.ratePerSec) / 1000);
    this.last = t;
  }

  /** 次の 1 回を取れるまでの待ち時間 (ミリ秒。待ちの列は考えない) */
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 - 1e-9 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSec);
  }

  /** 待たずに取れれば取って true */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1 - 1e-9) {
      this.tokens = Math.max(0, this.tokens - 1);
      return true;
    }
    return false;
  }

  /** 1 回分を取る (足りなければ補充まで待つ。呼び出し順) */
  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        if (this.tryAcquire()) return;
        await this.sleep(Math.max(1, this.waitMs()));
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

// ───────── 読み取り専用のパス ─────────

/** 呼べるパス (前方一致)。swap / execute / trigger / recurring などの書き込み系はここに無い */
const READ_ONLY_PREFIXES = ["/price/v3", "/tokens/v2/", "/swap/v1/quote", "/ultra/v1/order"] as const;
/** 署名・送信につながるクエリ (キーなしの order は見積もりだけ。taker を付けるとトランザクションが返る) */
const FORBIDDEN_QUERY_KEYS = ["taker", "payer", "userPublicKey", "signedTransaction"];

/** 読み取り専用のパスか (違えば例外)。swap・execute は絶対に呼ばない */
export function assertReadOnlyPath(path: string, query?: Query): void {
  const p = path.split("?")[0];
  const ok = READ_ONLY_PREFIXES.some((pre) => (pre.endsWith("/") ? p.startsWith(pre) : p === pre || p.startsWith(`${pre}/`)));
  if (!ok || /\/(execute|swap-instructions)(\/|$)/i.test(p) || /^\/swap\/v\d+\/swap/i.test(p)) {
    throw new Error(`Jupiter: 読み取り専用のクライアントでは ${p} を呼べません (swap・execute は未実装)`);
  }
  if (query) {
    for (const k of FORBIDDEN_QUERY_KEYS) {
      if (query[k] !== undefined) throw new Error(`Jupiter: 読み取り専用のクライアントでは ${k} を付けられません`);
    }
  }
}

// ───────── クライアント ─────────

export type QueryValue = string | number | boolean | undefined | readonly string[];
export type Query = Record<string, QueryValue>;

/** クエリ文字列。配列はカンマ区切り (カンマはそのまま。mint は base58 なのでエスケープは不要だが念のため各要素はエスケープする) */
export function buildQuery(q?: Query): string {
  if (!q) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "") continue;
    const s = Array.isArray(v) ? (v as readonly string[]).map((x) => encodeURIComponent(x)).join(",") : encodeURIComponent(String(v));
    parts.push(`${encodeURIComponent(k)}=${s}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface HttpJsonClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 1 回の試行のタイムアウト (既定 10 秒) */
  timeoutMs?: number;
  /** 429 / 5xx / 通信エラーの再試行回数 (既定 3) */
  retries?: number;
  /** バックオフの基準 (既定 1000 ms。2 倍ずつ、ジッター付き) */
  baseDelayMs?: number;
  /** 本文の上限 (既定は src/core/http.ts の既定) */
  maxBodyBytes?: number;
}

export interface JupiterClientOptions extends HttpJsonClientOptions {
  /** API キー (JUPITER_API_KEY を呼び出し側が読んで渡す)。表示・ログには出さない */
  apiKey?: string;
  baseUrl?: string;
  /** 1 秒あたりの上限 (既定: キーなし 0.5、キーあり 1) */
  ratePerSec?: number;
  /** 連続で呼べる回数 (既定 1) */
  burst?: number;
  /** レート制限を共有したいとき (複数のクライアントで 1 つの枠) */
  limiter?: TokenBucket;
}

/** エラー文・本文から秘密の文字列を伏せる (HttpError は status を保ったまま作り直す) */
export function scrubSecret(e: unknown, secret: string | undefined): unknown {
  if (!secret) return e;
  const hide = (s: string) => s.split(secret).join("***");
  if (e instanceof HttpError) {
    if (!e.body.includes(secret) && !e.message.includes(secret)) return e;
    return new HttpError(e.status, hide(e.url), hide(e.body));
  }
  if (e instanceof Error) {
    if (e.message.includes(secret)) e.message = hide(e.message);
    return e;
  }
  return hide(String(e));
}

/** レート制限つきで GET して JSON を返す (Jupiter・GeckoTerminal の共通部分) */
export async function limitedGetJson(
  url: string,
  path: string,
  headers: Record<string, string>,
  limiter: TokenBucket,
  o: HttpJsonClientOptions,
  secret?: string,
): Promise<unknown> {
  const sleep = o.sleep ?? defaultSleep;
  await limiter.acquire();
  let text: string;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers,
      retries: o.retries ?? 3,
      baseDelayMs: o.baseDelayMs ?? 1000,
      timeoutMs: o.timeoutMs ?? 10_000,
      ...(o.maxBodyBytes !== undefined ? { maxBodyBytes: o.maxBodyBytes } : {}),
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      // 再試行の前にも枠を取り直す (バックオフ・Retry-After の待ちの後)
      sleep: async (ms) => {
        await sleep(ms);
        await limiter.acquire();
      },
    });
    text = await res.text();
  } catch (e) {
    throw scrubSecret(e, secret);
  }
  try {
    return JSON.parse(text);
  } catch {
    const head = secret ? text.slice(0, 80).split(secret).join("***") : text.slice(0, 80);
    throw new JupiterShapeError(path, [`(応答): JSON ではありません (${redactSecrets(head)})`]);
  }
}

export class JupiterClient {
  readonly #apiKey: string | undefined;
  readonly baseUrl: string;
  readonly limiter: TokenBucket;
  private readonly o: JupiterClientOptions;

  constructor(o: JupiterClientOptions = {}) {
    const key = o.apiKey?.trim();
    this.#apiKey = key ? key : undefined;
    this.baseUrl = (o.baseUrl ?? JUPITER_BASE_URL).replace(/\/+$/, "");
    this.limiter =
      o.limiter ??
      new TokenBucket({
        ratePerSec: o.ratePerSec ?? (this.#apiKey ? JUPITER_KEYED_RPS : JUPITER_KEYLESS_RPS),
        burst: o.burst ?? 1,
        ...(o.now ? { now: o.now } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
      });
    // キーは o に残さない (表示・シリアライズで漏れないように)
    const { apiKey: _drop, ...rest } = o;
    void _drop;
    this.o = rest;
  }

  /** API キーが設定されているか (キーそのものは返さない) */
  get hasApiKey(): boolean {
    return this.#apiKey !== undefined;
  }

  /** 読み取り専用の GET。JSON をそのまま返す (形の検証は呼び出し側) */
  async getJson(path: string, query?: Query): Promise<unknown> {
    assertReadOnlyPath(path, query);
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#apiKey) headers["x-api-key"] = this.#apiKey;
    return limitedGetJson(url, path, headers, this.limiter, this.o, this.#apiKey);
  }

  /** GET して zod で検証する。形が違えば JupiterShapeError */
  async get<T>(path: string, query: Query | undefined, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.getJson(path, query);
    const r = schema.safeParse(raw);
    if (!r.success) throw new JupiterShapeError(path, issuesOf(r.error, "(応答)"));
    return r.data;
  }

  /** console.log などでキーを出さない */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, hasApiKey: this.hasApiKey, ratePerSec: this.limiter.ratePerSec };
  }
}
