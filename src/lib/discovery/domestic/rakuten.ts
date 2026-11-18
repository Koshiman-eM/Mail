import { env } from "../../env";
import { DomesticProviderError, type DomesticPriceProvider, type DomesticSample, type DomesticSearchResult } from "./types";

/**
 * 楽天市場 商品検索 API クライアント。
 *
 * 2026 年に楽天ウェブサービスは新 API (openapi.rakuten.co.jp) へ移行し、applicationId に加えて accessKey と、
 * Rakuten Developers に登録したサイト URL の Referer ヘッダーが必須になった。
 *
 * 【未検証】既定のエンドポイント・パラメーター名・accessKey の渡し方は公開情報からの推測で、実 API では確認できていない。
 * - エンドポイントは RAKUTEN_ITEM_SEARCH_URL で上書きできる (https かつ rakuten.co.jp のホストのみ許可)
 * - accessKey はクエリ (accessKey=) と Authorization: Bearer ヘッダーの両方で送る (RAKUTEN_ACCESS_KEY_MODE=param|header で片方のみ)
 * - 応答は formatVersion=2 (Items[].itemName) と旧形式 (Items[].Item.itemName) の両方を受け付ける
 */
export const DEFAULT_RAKUTEN_ITEM_SEARCH_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";

/** API 呼び出しの最短間隔 (楽天の目安: 1 秒に 1 回) */
export const RAKUTEN_MIN_INTERVAL_MS = 1000;
export const RAKUTEN_HITS = 30;

export interface RakutenOptions {
  applicationId?: string;
  accessKey?: string;
  referer?: string;
  endpoint?: string;
  accessKeyMode?: "param" | "header" | "both";
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** 同じプロセス内の全呼び出しで共有する最終呼び出し時刻 (1 秒間隔を守る) */
const throttle = { last: 0 };
/** テスト用 */
export function resetRakutenThrottle() {
  throttle.last = 0;
}

/** 上書きエンドポイントの検証: https かつ rakuten.co.jp (のサブドメイン) のみ (キーを他所へ送らないため) */
export function isAllowedRakutenEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && (h === "rakuten.co.jp" || h.endsWith(".rakuten.co.jp"));
  } catch {
    return false;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 応答本文 (formatVersion 2 / 1 の両方) から商品を取り出す */
export function parseRakutenItems(body: unknown): DomesticSample[] {
  if (!isObj(body)) return [];
  const raw = Array.isArray(body.Items) ? body.Items : Array.isArray(body.items) ? body.items : [];
  const out: DomesticSample[] = [];
  for (const entry of raw) {
    const it = isObj(entry) && isObj(entry.Item) ? entry.Item : entry;
    if (!isObj(it)) continue;
    const price = Number(it.itemPrice);
    const title = typeof it.itemName === "string" ? it.itemName.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const url = typeof it.itemUrl === "string" && /^https:\/\//i.test(it.itemUrl) ? it.itemUrl : "";
    if (!title || !url || !Number.isFinite(price) || price <= 0) continue;
    out.push({ title, priceJpy: String(Math.round(price)), url, ...(typeof it.shopName === "string" && it.shopName ? { shop: it.shopName } : {}) });
  }
  return out;
}

/** エラー応答を日本語の理由にする (旧 API: { error, error_description } / 新 API: { errors: {...} } 等を許容) */
export function rakutenErrorNote(status: number, body: unknown): string {
  let detail = "";
  if (isObj(body)) {
    const errs = body.errors;
    const e = Array.isArray(errs) ? errs[0] : errs;
    if (isObj(e)) detail = String(e.errorMessage ?? e.message ?? e.errorCode ?? "");
    detail ||= String(body.error_description ?? body.message ?? body.error ?? "");
  }
  detail = detail.slice(0, 200);
  if (status === 429) return "楽天 API の呼び出し回数の上限に達しました。時間をおいて再実行してください";
  if (status === 401 || status === 403)
    return `楽天 API の認証に失敗しました (HTTP ${status})。applicationId・accessKey と、Rakuten Developers に登録したサイト URL (Referer) を確認してください${detail ? `: ${detail}` : ""}`;
  if (status === 400 || status === 404) return `楽天 API へのリクエストが不正です (HTTP ${status})。エンドポイント (RAKUTEN_ITEM_SEARCH_URL) を確認してください${detail ? `: ${detail}` : ""}`;
  if (status >= 500) return `楽天 API が一時的に利用できません (HTTP ${status})`;
  return `楽天 API でエラーが発生しました (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

export function createRakutenProvider(opts: RakutenOptions = {}): DomesticPriceProvider {
  const cfg = () => ({
    applicationId: opts.applicationId ?? env.rakutenApplicationId,
    accessKey: opts.accessKey ?? env.rakutenAccessKey,
    referer: opts.referer ?? env.rakutenReferer,
    endpoint: opts.endpoint ?? env.rakutenItemSearchUrl ?? DEFAULT_RAKUTEN_ITEM_SEARCH_URL,
    mode: opts.accessKeyMode ?? env.rakutenAccessKeyMode,
  });
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const missing = () => {
    const c = cfg();
    const m: string[] = [];
    if (!c.applicationId) m.push("RAKUTEN_APPLICATION_ID");
    if (!c.accessKey) m.push("RAKUTEN_ACCESS_KEY");
    if (!c.referer) m.push("RAKUTEN_REFERER (または APP_URL)");
    return m;
  };

  return {
    id: "rakuten",
    label: "楽天市場",
    isConfigured: () => missing().length === 0 && isAllowedRakutenEndpoint(cfg().endpoint),
    statusNote() {
      const m = missing();
      if (m.length) return `未設定: ${m.join("・")}`;
      if (!isAllowedRakutenEndpoint(cfg().endpoint)) return "RAKUTEN_ITEM_SEARCH_URL は https の rakuten.co.jp の URL を指定してください";
      return "設定済み (エンドポイントの仕様は未検証。うまく取得できない場合は RAKUTEN_ITEM_SEARCH_URL で変更できます)";
    },
    async search(keywordJa: string): Promise<DomesticSearchResult> {
      const c = cfg();
      if (missing().length) throw new DomesticProviderError(`楽天 API が未設定です (${missing().join("・")})`);
      if (!isAllowedRakutenEndpoint(c.endpoint)) throw new DomesticProviderError("RAKUTEN_ITEM_SEARCH_URL が楽天のドメインではありません");
      const keyword = keywordJa.replace(/\s+/g, " ").trim().slice(0, 100);
      if (!keyword) return { items: [] };

      const url = new URL(c.endpoint);
      url.searchParams.set("applicationId", c.applicationId!);
      if (c.mode !== "header") url.searchParams.set("accessKey", c.accessKey!);
      url.searchParams.set("format", "json");
      url.searchParams.set("formatVersion", "2");
      url.searchParams.set("keyword", keyword);
      url.searchParams.set("hits", String(RAKUTEN_HITS));
      url.searchParams.set("sort", "standard");
      url.searchParams.set("availability", "1");
      const headers: Record<string, string> = { Accept: "application/json", Referer: c.referer! };
      if (c.mode !== "param") headers.Authorization = `Bearer ${c.accessKey}`;

      // 1 秒間隔を守る
      const wait = throttle.last + RAKUTEN_MIN_INTERVAL_MS - now();
      if (wait > 0) await sleep(wait);
      throttle.last = now();

      let res: Response;
      try {
        res = await (opts.fetchImpl ?? globalThis.fetch)(url.toString(), {
          headers,
          // Referer を確実に送る (fetch の既定のリファラーポリシーで落とされないように)
          referrerPolicy: "unsafe-url",
          redirect: "error",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (e) {
        throw new DomesticProviderError(`楽天 API に接続できませんでした (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`, true);
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) throw new DomesticProviderError(rakutenErrorNote(res.status, body), res.status === 429 || res.status >= 500);
      if (isObj(body) && (body.error || body.errors)) throw new DomesticProviderError(rakutenErrorNote(400, body));
      if (body === null) throw new DomesticProviderError("楽天 API の応答を解析できませんでした");
      return { items: parseRakutenItems(body) };
    },
  };
}
