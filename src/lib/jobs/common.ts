import type { Platform } from "@prisma/client";
import type { BlockKind } from "../scraper/detect";
import type { ParsedProduct } from "../scraper/parse";

/** 業者が判別できないときの仮の業者名・ID (後で取得できたら置き換える) */
export const PLACEHOLDER_SUPPLIER_NAME = "業者未設定";
export const placeholderSupplierId = (platform: Platform, productExternalId: string) => `unknown:${platform}:${productExternalId}`;
export const isPlaceholderSupplier = (s: { externalId: string; name: string }) =>
  s.externalId.startsWith("unknown:") || s.name === PLACEHOLDER_SUPPLIER_NAME;

/** 取り込み時に商品名が取れず URL を仮の商品名にしたかどうか */
export const isPlaceholderTitle = (p: { title: string; url: string }) => !p.title.trim() || p.title === p.url || /^https?:\/\//i.test(p.title);

/** プラットフォームの既定通貨 (ページから取れない場合) */
export const defaultCurrency = (platform: Platform) => (platform === "ALI1688" ? "CNY" : "USD");

export const PLATFORM_NAME: Record<Platform, string> = {
  ALIBABA: "Alibaba.com",
  ALI1688: "1688.com",
  ALIEXPRESS: "AliExpress",
  OTHER: "その他",
};

const MANUAL_HINT = "ページのソースを貼り付けるか、手入力してください";

/** 取得失敗の理由 (画面表示用の日本語) */
export function blockNote(kind: BlockKind | "paused", platform: Platform, opts: { pasted?: boolean } = {}): string {
  if (opts.pasted) {
    return kind === "captcha"
      ? "貼り付けたソースは CAPTCHA (認証) 画面のものです。ブラウザで認証を済ませ、商品ページを表示してからソースを貼り付けてください"
      : kind === "login"
        ? "貼り付けたソースはログイン画面のものです。ログイン後の商品ページのソースを貼り付けてください"
        : "貼り付けたソースはアクセス制限の画面のものです。商品ページのソースを貼り付けてください";
  }
  switch (kind) {
    case "captcha":
      return `CAPTCHA のため取得できませんでした。${MANUAL_HINT}`;
    case "login":
      return `ログインを求められたため取得できませんでした。${MANUAL_HINT}`;
    case "blocked":
      return `アクセスが制限されたため取得できませんでした。時間をおいて再取得するか、${MANUAL_HINT}`;
    case "paused":
      return `${PLATFORM_NAME[platform]} の巡回は一時停止中です (手動での再認証待ち)。設定画面で再開してください`;
  }
}

/** HTTP ステータスの分類: ok / retry (一時的な障害) / fail (再試行しても無駄) */
export function classifyStatus(status: number): "ok" | "retry" | "fail" {
  if (status >= 200 && status < 400) return "ok";
  if (status >= 500 || status === 408 || status === 0) return "retry";
  return "fail";
}

export function statusNote(status: number): string {
  if (status === 404 || status === 410) return `商品ページが見つかりません (HTTP ${status})。販売終了の可能性があります`;
  if (status >= 500 || status === 0) return `サイト側のエラーで取得できませんでした (HTTP ${status})。時間をおいて再取得してください`;
  return `取得できませんでした (HTTP ${status})。${MANUAL_HINT}`;
}

export const NO_PRICE_NOTE = `ページから価格を読み取れませんでした。${MANUAL_HINT}`;

/** ページから抽出できた項目名 (画面に「取得できた項目」として表示する) */
export function parsedFieldsOf(p: ParsedProduct): string[] {
  const f: string[] = [];
  if (p.title) f.push("title");
  if (p.priceTiers.length) f.push("priceTiers");
  if (p.moq !== null) f.push("moq");
  if (p.currency) f.push("currency");
  if (p.stockQty !== null) f.push("stock");
  if (p.supplierName) f.push("supplierName");
  if (p.supplierId) f.push("supplierId");
  if (p.supplierUrl) f.push("supplierUrl");
  return f;
}

/** 一時的なエラー (タイムアウト・ネットワーク断) かどうか */
export function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "FetchTimeoutError" || e.name === "TimeoutError" || e.name === "AbortError") return true;
  const msg = `${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}`;
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|net::ERR/i.test(msg);
}

/** 画面に出すエラー文: 先頭行のみ・端末の色コード除去・長さ制限 (Playwright の呼び出しログ等を出さない) */
export function shortError(e: unknown, max = 160): string {
  const raw = e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 再取得時の通貨の食い違い (地域設定・ログイン状態で表示通貨が変わった等) を検出する。
 * 既に価格がある商品で、ページの通貨が登録時と異なれば理由 (画面表示用) を返す。価格・履歴は更新しないこと。
 */
export function currencyMismatchNote(
  product: { currency: string; priceTiers: unknown },
  parsedCurrency: string | null | undefined,
): string | null {
  const hasTiers = Array.isArray(product.priceTiers) && product.priceTiers.length > 0;
  if (!hasTiers || !parsedCurrency) return null;
  const page = parsedCurrency.trim().toUpperCase();
  const registered = product.currency.trim().toUpperCase();
  if (!page || page === registered) return null;
  return `ページの通貨が ${page} になっていました (登録時 ${registered})。価格は更新していません。`;
}

/** 取得前の URL 検証: 対応プラットフォームの商品 URL で、登録されたプラットフォームと一致する場合だけ取得する (SSRF 対策) */
export const UNFETCHABLE_URL_NOTE = "商品 URL が対応サイト (登録したプラットフォーム) のものではないため、自動取得しません。ページのソースを貼り付けるか、手入力してください";
