import type { Platform } from "@prisma/client";
import { findTagAttr, tagAttr } from "./html";

export interface AnalyzedUrl {
  platform: Exclude<Platform, "OTHER">;
  /** 商品 ID。短縮リンクなど URL から判別できない場合は null (取得してリダイレクト先で再判定する) */
  externalId: string | null;
  /** 追跡パラメータを除いた正規 URL (短縮リンクは元の URL) */
  canonicalUrl: string;
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/\.$/, "");
const isHost = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/** 取得 (リダイレクト追従を含む) を許可するドメイン。各サブドメイン (短縮リンク・ログイン・CAPTCHA 画面を含む) も許可 */
export const ALLOWED_FETCH_DOMAINS = [
  "alibaba.com",
  "1688.com",
  "aliexpress.com",
  "aliexpress.us",
  "aliexpress.ru",
  // 1688 のログイン画面 (login.taobao.com) へのリダイレクトもブロック検知のため許可する
  "taobao.com",
] as const;

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** ホスト名が IP アドレスのリテラル (IPv4 / IPv6 / 数値表記) かどうか */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6
  if (IPV4_RE.test(h)) return true;
  // 0x7f000001 / 2130706433 など (WHATWG URL は正規化するが念のため)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  return false;
}

/** localhost・ループバック・プライベートアドレス等 (サイトのアセットであっても取得させない) */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    // IPv6: ループバック・未指定・リンクローカル・ユニークローカル・IPv4 射影
    return h === "::1" || h === "::" || /^fe[89ab]/.test(h) || /^f[cd]/.test(h) || h.startsWith("::ffff:") || h.startsWith("0:");
  }
  if (IPV4_RE.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return /^(?:0x[0-9a-f]+|\d+)$/i.test(h);
}

/**
 * 商品ページの取得 (リダイレクトの各段を含む) を許可する URL か。
 * http / https のみ、対応プラットフォームのドメイン (とそのサブドメイン) のみ。IP リテラル・localhost・ポート指定・認証情報付きは拒否。
 */
export function isAllowedFetchHost(input: string | URL): boolean {
  let u: URL;
  try {
    u = typeof input === "string" ? new URL(input) : input;
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const h = host(u);
  if (!h || isIpLiteral(h) || isPrivateOrLocalHost(h)) return false;
  return ALLOWED_FETCH_DOMAINS.some((d) => isHost(h, d));
}

/**
 * Playwright 内のリクエストを許可するか (SSRF 対策)。
 * - localhost・プライベート/ループバック IP への要求はすべて拒否
 * - ページ遷移 (document) は対応サイトのドメインのみ許可
 * - それ以外のサブリソース (画像・スクリプト等) は描画のため許可
 */
export function shouldAllowBrowserRequest(url: string, resourceType: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return resourceType !== "document" || u.protocol === "about:";
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "wss:" && u.protocol !== "ws:") return false;
  if (isPrivateOrLocalHost(u.hostname)) return false;
  if (resourceType === "document") return isAllowedFetchHost(u);
  return true;
}

/**
 * 商品 URL を解析してプラットフォーム・商品 ID・正規 URL を返す。対応外なら null。
 * - Alibaba.com: `/product-detail/<slug>_<id>.html` (www / m / 各言語サブドメイン)
 * - 1688: `detail.1688.com/offer/<id>.html`, `m.1688.com/offer/<id>.html`, `qr.1688.com/...` (短縮 → ID 不明)
 * - AliExpress: `/item/<id>.html` (aliexpress.com / ja. / m. / aliexpress.us)、`a.aliexpress.com` / `s.click.aliexpress.com` (短縮 → ID 不明)
 */
export function analyzeProductUrl(input: string): AnalyzedUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = host(u);
  const path = u.pathname;

  if (isHost(h, "alibaba.com")) {
    const m = path.match(/\/product-detail\/(?:[^/]*?_)?(\d{6,})\.html/i) ?? path.match(/\/(?:product|p-detail)\/(\d{6,})(?:\.html)?/i);
    if (!m) return null;
    // 商品詳細はデスクトップ版 (www) に揃える。モバイル専用パスは元のホストのままクエリだけ除去
    const canonicalUrl = /^\/product-detail\//i.test(path) ? `https://www.alibaba.com${path}` : `https://${h}${path}`;
    return { platform: "ALIBABA", externalId: m[1], canonicalUrl };
  }

  if (isHost(h, "1688.com")) {
    if (h === "qr.1688.com") return { platform: "ALI1688", externalId: null, canonicalUrl: u.toString() };
    const m = path.match(/\/offer\/(\d{6,})\.html/i);
    if (m) return { platform: "ALI1688", externalId: m[1], canonicalUrl: `https://detail.1688.com/offer/${m[1]}.html` };
    const q = u.searchParams.get("offerId");
    if (q && /^\d{6,}$/.test(q)) return { platform: "ALI1688", externalId: q, canonicalUrl: `https://detail.1688.com/offer/${q}.html` };
    return null;
  }

  if (isHost(h, "aliexpress.com") || isHost(h, "aliexpress.us") || isHost(h, "aliexpress.ru")) {
    if (h === "a.aliexpress.com" || h === "s.click.aliexpress.com" || h === "click.aliexpress.com") {
      return { platform: "ALIEXPRESS", externalId: null, canonicalUrl: u.toString() };
    }
    const m = path.match(/\/item\/(?:[^/]*?\/)?(\d{6,})\.html/i);
    if (m) {
      const base = isHost(h, "aliexpress.us") ? "https://www.aliexpress.us" : "https://www.aliexpress.com";
      return { platform: "ALIEXPRESS", externalId: m[1], canonicalUrl: `${base}/item/${m[1]}.html` };
    }
    const q = u.searchParams.get("productId");
    if (q && /^\d{6,}$/.test(q)) return { platform: "ALIEXPRESS", externalId: q, canonicalUrl: `https://www.aliexpress.com/item/${q}.html` };
    return null;
  }
  return null;
}

/** 文中に含まれる URL を順に取り出す (末尾の句読点・括弧は除去) */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>「」『』（）【】、。]{1,4000}/gi)) {
    // 末尾の句読点・括弧を除去 (正規表現の `[...]+$` は長い連続で遅くなるためループで削る)
    let end = m[0].length;
    while (end > 0 && "),.!?;:".includes(m[0][end - 1])) end--;
    const url = m[0].slice(0, end);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 共有テキスト (Android アプリは「商品名 https://...」のような文を送る) から URL を取り出す。
 * 対応サイトの商品 URL を優先し、無ければ最初の URL を返す。
 */
export function extractUrlFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const urls = extractUrls(text);
  return urls.find((u) => analyzeProductUrl(u)) ?? urls[0] ?? null;
}

/** 共有された title / text / url から最初に見つかった対応商品 URL を返す */
export function findProductUrl(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    if (!p) continue;
    for (const u of extractUrls(p)) if (analyzeProductUrl(u)) return u;
  }
  return null;
}

/** HTML 内の canonical / og:url (短縮リンクを貼り付けたソースから商品 URL を得るため) */
export function canonicalFromHtml(html: string): string | null {
  // 正規表現でタグ全体を探すと巨大な入力で遅くなる (ReDoS) ため、線形時間のタグ走査を使う
  const href = findTagAttr(html, "link", (t) => (tagAttr(t, "rel") ?? "").toLowerCase() === "canonical", "href");
  const og = findTagAttr(html, "meta", (t) => (tagAttr(t, "property") ?? "").toLowerCase() === "og:url", "content");
  for (const c of [href, og]) {
    if (!c) continue;
    const abs = c.startsWith("//") ? `https:${c}` : c;
    if (analyzeProductUrl(abs)?.externalId) return abs;
  }
  return null;
}
