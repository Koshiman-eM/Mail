/**
 * GMOコインの API クライアント (公開 API と非公開 API)。
 *
 * 仕様の出典はユーザーの知識 (この環境からは api.coin.z.com に接続できず、実際の応答では未確認)。
 * 確かめられていない点は「要確認」と書き、応答の形が想定と違うときは推測で進めずに例外にする (fail-closed)。
 * 実際の応答の形は `npm run trader -- gmo check` で確かめる。
 *
 * - 応答は `{ status: 0, data, responsetime }`。status ≠ 0 はエラーで `messages: [{ message_code, message_string }]` を返す。
 * - 数値は文字列で受けて検証してから使う (zod)。ID (orderId / positionId など) は数値でも文字列でも受けて文字列にそろえる。
 * - 認証ヘッダー: API-KEY / API-TIMESTAMP (ミリ秒の文字列) / API-SIGN (HMAC-SHA256(secret, timestamp + method + path + body) の hex)。
 *   path は `/v1/order` のように `/private` を含まず、クエリ文字列も含めない。GET の body は空文字。
 * - レート制限: 公開・非公開とも 1 秒あたり 6 回までに自前で抑える (公開と非公開は別の枠。要確認: GMO 側の実際の上限)。
 * - 発注系 (POST) は二重送信を避けるため再試行しない。非公開の GET は署名を作り直して再試行する。
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { fetchWithRetry, HttpError, redactSecrets } from "../../core/http";

export const GMO_PUBLIC_BASE = "https://api.coin.z.com/public";
export const GMO_PRIVATE_BASE = "https://api.coin.z.com/private";
/** 1 秒あたりの呼び出し上限 (公開・非公開それぞれ) */
export const GMO_MAX_REQUESTS_PER_SEC = 6;

/** エラーコード (要確認: ERR-201 は残高不足の想定) */
export const GMO_ERR = {
  MAINTENANCE: "ERR-5201",
  RATE_LIMIT: "ERR-5003",
  INSUFFICIENT: "ERR-201",
} as const;

export type GmoErrorKind = "maintenance" | "rate_limit" | "insufficient" | "other";

export const GMO_ERROR_KIND_LABEL: Record<GmoErrorKind, string> = {
  maintenance: "メンテナンス中",
  rate_limit: "リクエスト過多",
  insufficient: "残高不足",
  other: "取引所がエラーを返しました",
};

export function gmoErrorKind(codes: readonly string[]): GmoErrorKind {
  if (codes.includes(GMO_ERR.MAINTENANCE)) return "maintenance";
  if (codes.includes(GMO_ERR.RATE_LIMIT)) return "rate_limit";
  if (codes.includes(GMO_ERR.INSUFFICIENT)) return "insufficient";
  return "other";
}

/** 取引所が status ≠ 0 で答えたエラー (= リクエストは受け付けられていない) */
export class GmoApiError extends Error {
  readonly kind: GmoErrorKind;
  constructor(
    readonly path: string,
    readonly codes: string[],
    readonly messages: string[],
    readonly httpStatus?: number,
  ) {
    const kind = gmoErrorKind(codes);
    const detail = codes.map((c, i) => `${c}${messages[i] ? ` ${messages[i]}` : ""}`).join(", ") || "(メッセージなし)";
    super(redactSecrets(`GMO ${path}: ${GMO_ERROR_KIND_LABEL[kind]} (${detail})`));
    this.name = "GmoApiError";
    this.kind = kind;
  }
}

/** 応答の形が想定と違う (推測で進めずに例外にする)。issues は「項目名: 内容」の一覧 */
export class GmoShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string[],
  ) {
    super(`GMO ${path}: 応答の形が想定と違います: ${issues.slice(0, 8).join("; ")}${issues.length > 8 ? ` ほか ${issues.length - 8} 件` : ""}`);
    this.name = "GmoShapeError";
  }
}

/** HMAC-SHA256(secret, timestamp + method + path + body) の hex。path にクエリ文字列を含めない */
export function gmoSign(secret: string, timestamp: string, method: string, path: string, body: string): string {
  const q = path.indexOf("?");
  const p = q >= 0 ? path.slice(0, q) : path;
  return createHmac("sha256", secret).update(timestamp + method + p + body).digest("hex");
}

// ───────── 検証スキーマ ─────────

/** 10 進の数値文字列 (符号・小数点のみ) */
const NUM_RE = /^-?\d+(\.\d+)?$/;
export const numStr = z.string().regex(NUM_RE, "数値の文字列ではありません");
/** 正の数値文字列 */
const posNumStr = numStr.refine((s) => Number(s) > 0, "正の数ではありません");
/** ID: 数値でも文字列でも受けて文字列にそろえる */
const idStr = z.union([z.string().regex(/^\d+$/, "ID が数字ではありません"), z.number().int().nonnegative()]).transform((v) => String(v));
/** ISO 8601 の時刻文字列 → ミリ秒 */
const isoTime = z.string().refine((s) => Number.isFinite(Date.parse(s)), "時刻 (ISO 8601) ではありません").transform((s) => Date.parse(s));
const sideEnum = z.enum(["BUY", "SELL"]);

export const statusSchema = z.object({ status: z.enum(["MAINTENANCE", "PREOPEN", "OPEN"]) });
export const tickerSchema = z.array(
  z.object({ ask: posNumStr, bid: posNumStr, high: numStr, last: numStr, low: numStr, symbol: z.string(), timestamp: isoTime, volume: numStr }),
);
const level = z.object({ price: posNumStr, size: numStr });
export const orderbooksSchema = z.object({ asks: z.array(level), bids: z.array(level), symbol: z.string() });
const paginationSchema = z.object({ currentPage: z.number().int(), count: z.number().int() });
export const tradesSchema = z.object({
  pagination: paginationSchema.optional(),
  list: z.array(z.object({ price: posNumStr, side: sideEnum, size: numStr, timestamp: isoTime })),
});
export const klinesSchema = z.array(
  z.object({
    openTime: z.string().regex(/^\d+$/, "openTime がミリ秒の文字列ではありません").transform((s) => Number(s)),
    open: posNumStr, high: posNumStr, low: posNumStr, close: posNumStr, volume: numStr,
  }),
);
export const symbolsSchema = z.array(
  z.object({ symbol: z.string(), minOrderSize: posNumStr, maxOrderSize: posNumStr, sizeStep: posNumStr, tickSize: posNumStr, takerFee: numStr, makerFee: numStr }),
);
/** 口座の証拠金 (要確認: actualProfitLoss = 時価評価総額、availableAmount = 取引余力) */
export const marginSchema = z.object({ actualProfitLoss: numStr, availableAmount: numStr, margin: numStr, profitLoss: numStr });
export const assetsSchema = z.array(z.object({ symbol: z.string(), amount: numStr, available: numStr }));
const orderStatusEnum = z.enum(["WAITING", "ORDERED", "MODIFYING", "CANCELLING", "CANCELED", "EXECUTED", "EXPIRED"]);
const execTypeEnum = z.enum(["MARKET", "LIMIT", "STOP"]);
export const orderItemSchema = z.object({
  orderId: idStr,
  rootOrderId: idStr,
  symbol: z.string(),
  side: sideEnum,
  orderType: z.enum(["NORMAL", "LOSSCUT"]),
  executionType: execTypeEnum,
  settleType: z.enum(["OPEN", "CLOSE"]),
  size: posNumStr,
  executedSize: numStr,
  /** 成行は価格が "0" のことがある (要確認)。項目自体が無ければ例外 */
  price: numStr,
  losscutPrice: numStr,
  status: orderStatusEnum,
  timeInForce: z.string(),
  timestamp: isoTime,
});
export type GmoOrder = z.infer<typeof orderItemSchema>;
/**
 * 一覧の応答。data は {} (該当なし。要確認) か { list: [...] } だけを許す (strict: 未知のキーは例外)。
 * ページングのある API (activeOrders・latestExecutions・openPositions) は pagination も許す。
 * 要素の必須の項目が欠けていれば例外 (読み飛ばさない = fail-closed)。
 */
const listOf = <T extends z.ZodTypeAny>(item: T, paginated = false) => {
  const withList = paginated
    ? z.object({ pagination: paginationSchema.optional(), list: z.array(item) }).strict()
    : z.object({ list: z.array(item) }).strict();
  // union だと項目名つきの理由が失われるので、空のオブジェクトだけ先に判定して残りは withList の理由をそのまま出す
  return z.unknown().transform((v, ctx): { list: z.infer<T>[] } => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return { list: [] };
    const r = withList.safeParse(v);
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: i.path as (string | number)[] });
      return z.NEVER;
    }
    return { list: r.data.list as z.infer<T>[] };
  });
};
export const ordersSchema = listOf(orderItemSchema);
export const activeOrdersSchema = listOf(orderItemSchema, true);
export const executionItemSchema = z.object({
  executionId: idStr,
  orderId: idStr,
  positionId: idStr,
  symbol: z.string(),
  side: sideEnum,
  settleType: z.enum(["OPEN", "CLOSE"]),
  size: posNumStr,
  price: posNumStr,
  lossGain: numStr,
  fee: numStr,
  timestamp: isoTime,
});
export type GmoExecution = z.infer<typeof executionItemSchema>;
export const executionsSchema = listOf(executionItemSchema);
export const latestExecutionsSchema = listOf(executionItemSchema, true);
export const openPositionsSchema = listOf(
  z.object({
    positionId: idStr, symbol: z.string(), side: sideEnum, size: posNumStr, orderdSize: numStr, price: posNumStr,
    lossGain: numStr, leverage: numStr, losscutPrice: numStr, timestamp: isoTime,
  }),
  true,
);
export const positionSummarySchema = listOf(
  z.object({ averagePositionRate: numStr, positionLossGain: numStr, side: sideEnum, sumOrderQuantity: numStr, sumPositionQuantity: numStr, symbol: z.string() }),
);
export type GmoPositionSummary = z.infer<typeof positionSummarySchema>["list"][number];
/** 発注の応答の data は orderId (文字列) */
export const orderIdSchema = z.string().regex(/^\d+$/, "orderId が数字の文字列ではありません");

const envelopeSchema = z.object({
  status: z.number().int(),
  data: z.unknown().optional(),
  messages: z.array(z.object({ message_code: z.string().optional(), message_string: z.string().optional() })).optional(),
  responsetime: z.string().optional(),
});

function issuesOf(e: z.ZodError, prefix: string): string[] {
  return e.issues.map((i) => `${[prefix, ...i.path.map(String)].join(".")}: ${i.message}`);
}

/** 応答本文 (JSON) を検証する。status ≠ 0 は GmoApiError、形の違いは GmoShapeError */
export function parseGmoResponse<T>(path: string, raw: unknown, schema: z.ZodType<T>, httpStatus?: number): T {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new GmoShapeError(path, issuesOf(env.error, "(応答)"));
  if (env.data.status !== 0) {
    const msgs = env.data.messages ?? [];
    throw new GmoApiError(path, msgs.map((m) => m.message_code ?? "(コードなし)"), msgs.map((m) => m.message_string ?? ""), httpStatus);
  }
  const d = schema.safeParse(env.data.data);
  if (!d.success) throw new GmoShapeError(path, issuesOf(d.error, "data"));
  return d.data;
}

// ───────── レート制限 ─────────

/** 直近 windowMs の呼び出しを max 回までに抑える (呼び出し順に待つ) */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.stamps.length && t - this.stamps[0] >= this.windowMs) this.stamps.shift();
        if (this.stamps.length < this.max) {
          this.stamps.push(t);
          return;
        }
        await this.sleep(Math.max(1, this.windowMs - (t - this.stamps[0])));
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

// ───────── クライアント ─────────

export interface GmoClientOptions {
  /**
   * POST (発注・決済・取消) を許可する。live の GmoBroker (assertLive 済み) だけが true にする。
   * 公開データの feed・`gmo check` のクライアントには付けない (付いていなければ送信前に例外)
   */
  allowPost?: boolean;
  apiKey?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
  /** 時刻 (API-TIMESTAMP とレート制限) */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 1 回の試行のタイムアウト (既定 10 秒) */
  timeoutMs?: number;
  publicBase?: string;
  privateBase?: string;
}

type Query = Record<string, string | number | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function queryString(q?: Query): string {
  if (!q) return "";
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** 失敗が再試行してよい種類か (通信・タイムアウト・429・5xx) */
function retryable(e: unknown): boolean {
  if (e instanceof GmoApiError || e instanceof GmoShapeError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  return true;
}

export interface GmoOrderBody {
  symbol: string;
  side: "BUY" | "SELL";
  executionType: "MARKET" | "LIMIT";
  timeInForce?: string;
  price?: string;
  size: string;
}

export class GmoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly publicLimiter: RateLimiter;
  private readonly privateLimiter: RateLimiter;

  constructor(private readonly o: GmoClientOptions = {}) {
    this.fetchImpl = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.publicLimiter = new RateLimiter(GMO_MAX_REQUESTS_PER_SEC, 1000, this.now, this.sleep);
    this.privateLimiter = new RateLimiter(GMO_MAX_REQUESTS_PER_SEC, 1000, this.now, this.sleep);
  }

  /** 非公開 API のキーがあるか */
  get hasCredentials(): boolean {
    return Boolean(this.o.apiKey && this.o.apiSecret);
  }

  /** 本文を JSON として読み、検証する。非 2xx の本文が GMO のエラー形式なら GmoApiError にする */
  private async send<T>(url: string, path: string, init: RequestInit, schema: z.ZodType<T>, retries = 0): Promise<T> {
    let res: Response;
    try {
      res = await fetchWithRetry(url, { ...init, retries, sleep: this.sleep, timeoutMs: this.o.timeoutMs ?? 10_000, fetchImpl: this.fetchImpl });
    } catch (e) {
      if (e instanceof HttpError) {
        let body: unknown;
        try {
          body = JSON.parse(e.body);
        } catch {
          throw e;
        }
        const env = envelopeSchema.safeParse(body);
        if (env.success && env.data.status !== 0) parseGmoResponse(path, body, schema, e.status);
      }
      throw e;
    }
    const text = await res.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new GmoShapeError(path, [`(応答): JSON ではありません (${redactSecrets(text.slice(0, 80))})`]);
    }
    return parseGmoResponse(path, raw, schema);
  }

  /** 公開 API (GET)。通信エラー・429・5xx は src/core/http.ts の再試行 (Retry-After を尊重) で retries 回まで */
  async publicGet<T>(path: string, query: Query | undefined, schema: z.ZodType<T>, retries = 3): Promise<T> {
    const url = `${this.o.publicBase ?? GMO_PUBLIC_BASE}${path}${queryString(query)}`;
    await this.publicLimiter.acquire();
    return this.send(url, path, { method: "GET", headers: { accept: "application/json" } }, schema, retries);
  }

  /** 非公開 API。GET は署名を作り直して再試行する。POST は再試行しない (二重発注の防止) */
  async privateCall<T>(method: "GET" | "POST", path: string, query: Query | undefined, body: unknown, schema: z.ZodType<T>, retries = method === "GET" ? 2 : 0): Promise<T> {
    if (method === "POST" && this.o.allowPost !== true) throw new Error(`GMO: このクライアントは POST (${path}) を許可されていません (発注・取消は live の GmoBroker だけ)`);
    const key = this.o.apiKey;
    const secret = this.o.apiSecret;
    if (!key || !secret) throw new Error("GMO の非公開 API には GMO_API_KEY / GMO_API_SECRET が必要です");
    const url = `${this.o.privateBase ?? GMO_PRIVATE_BASE}${path}${queryString(query)}`;
    const text = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const tries = method === "POST" ? 0 : retries;
    for (let attempt = 0; ; attempt++) {
      await this.privateLimiter.acquire();
      const ts = String(this.now());
      const headers: Record<string, string> = {
        accept: "application/json",
        "API-KEY": key,
        "API-TIMESTAMP": ts,
        "API-SIGN": gmoSign(secret, ts, method, path, text),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      };
      try {
        return await this.send(url, path, { method, headers, ...(method === "POST" ? { body: text } : {}) }, schema);
      } catch (e) {
        if (attempt >= tries || !retryable(e)) throw e;
        await this.sleep(500 * 2 ** attempt);
      }
    }
  }

  // ───── 公開 API ─────
  getStatus() {
    return this.publicGet("/v1/status", undefined, statusSchema);
  }
  getTicker(symbol?: string, retries?: number) {
    return this.publicGet("/v1/ticker", { symbol }, tickerSchema, retries);
  }
  getOrderbooks(symbol: string, retries?: number) {
    return this.publicGet("/v1/orderbooks", { symbol }, orderbooksSchema, retries);
  }
  getTrades(symbol: string, page = 1, count = 100, retries?: number) {
    return this.publicGet("/v1/trades", { symbol, page, count }, tradesSchema, retries);
  }
  getKlines(symbol: string, interval: string, date: string) {
    return this.publicGet("/v1/klines", { symbol, interval, date }, klinesSchema);
  }
  getSymbols() {
    return this.publicGet("/v1/symbols", undefined, symbolsSchema);
  }

  // ───── 非公開 API (読み取り) ─────
  getMargin() {
    return this.privateCall("GET", "/v1/account/margin", undefined, undefined, marginSchema);
  }
  getAssets() {
    return this.privateCall("GET", "/v1/account/assets", undefined, undefined, assetsSchema);
  }
  getOrders(orderId: string) {
    return this.privateCall("GET", "/v1/orders", { orderId }, undefined, ordersSchema);
  }
  getActiveOrders(symbol: string, page = 1, count = 100) {
    return this.privateCall("GET", "/v1/activeOrders", { symbol, page, count }, undefined, activeOrdersSchema);
  }
  getExecutions(orderId: string) {
    return this.privateCall("GET", "/v1/executions", { orderId }, undefined, executionsSchema);
  }
  getLatestExecutions(symbol: string, page = 1, count = 100) {
    return this.privateCall("GET", "/v1/latestExecutions", { symbol, page, count }, undefined, latestExecutionsSchema);
  }
  getOpenPositions(symbol: string, page = 1, count = 100) {
    return this.privateCall("GET", "/v1/openPositions", { symbol, page, count }, undefined, openPositionsSchema);
  }
  getPositionSummary(symbol: string) {
    return this.privateCall("GET", "/v1/positionSummary", { symbol }, undefined, positionSummarySchema);
  }

  // ───── 非公開 API (発注・取消。再試行しない) ─────
  postOrder(body: GmoOrderBody) {
    return this.privateCall("POST", "/v1/order", undefined, body, orderIdSchema);
  }
  /** 建玉を反対売買で一括決済する (side は決済注文の売買方向。要確認) */
  postCloseBulkOrder(body: GmoOrderBody) {
    return this.privateCall("POST", "/v1/closeBulkOrder", undefined, body, orderIdSchema);
  }
  /** 取消。orderId は数値で送る (要確認: GMO の例は数値) */
  postCancelOrder(orderId: string) {
    const n = Number(orderId);
    if (!/^\d+$/.test(orderId) || !Number.isSafeInteger(n)) throw new Error(`GMO: orderId が不正です: ${orderId}`);
    return this.privateCall("POST", "/v1/cancelOrder", undefined, { orderId: n }, z.unknown());
  }
}

/** GMO の銘柄名 → 統一シンボル ("BTC_JPY" → "BTC/JPY")。レバレッジ銘柄 (BASE_QUOTE) 以外は undefined */
export function gmoToUnified(gmoSymbol: string): string | undefined {
  const m = /^([A-Z0-9]+)_([A-Z]+)$/.exec(gmoSymbol);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** 統一シンボル → GMO のレバレッジ銘柄名 ("BTC/JPY" → "BTC_JPY")。"BTC_JPY" はそのまま */
export function unifiedToGmo(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "_");
}

/** GMO_SYMBOLS (カンマ区切り) を解析する。レバレッジ銘柄 (BTC_JPY 形式) だけを受け付ける */
export function parseGmoSymbols(s: string): string[] {
  const list = [...new Set(s.split(",").map((x) => unifiedToGmo(x)).filter(Boolean))];
  for (const x of list) {
    if (!gmoToUnified(x)) throw new Error(`GMO_SYMBOLS の銘柄が不正です: ${x} (レバレッジ銘柄を BTC_JPY の形式で指定してください)`);
  }
  return list;
}
