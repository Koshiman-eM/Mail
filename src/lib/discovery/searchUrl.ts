import type { Platform } from "@prisma/client";
import { isAllowedFetchHost } from "../scraper/url";

export type SearchPlatform = Exclude<Platform, "OTHER">;
export const SEARCH_PLATFORMS: SearchPlatform[] = ["ALIBABA", "ALIEXPRESS", "ALI1688"];

/** 検索キーワードの最大長 (URL を長くしすぎない) */
export const MAX_KEYWORD_LENGTH = 100;

/** 空白の正規化と長さ制限 */
export function normalizeKeyword(keyword: string): string {
  return keyword.replace(/\s+/g, " ").trim().slice(0, MAX_KEYWORD_LENGTH);
}

/* ------------------------------------------------------------------ */
/* GBK エンコード (1688 の検索は伝統的に GBK でエンコードしたキーワードを受け付ける)       */
/* TextEncoder は UTF-8 しか出力できないため、Node の TextDecoder("gbk") で 2 バイト      */
/* コードを一度だけ総当たりで復号して逆引き表を作る (初回のみ約 2.4 万件・数ミリ秒)。          */
/* ------------------------------------------------------------------ */
let gbkTable: Map<string, [number, number]> | null | undefined;

function buildGbkTable(): Map<string, [number, number]> | null {
  let dec: TextDecoder;
  try {
    dec = new TextDecoder("gbk", { fatal: true });
  } catch {
    return null; // ICU を含まない Node ビルド等
  }
  const map = new Map<string, [number, number]>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      let ch: string;
      try {
        ch = dec.decode(pair);
      } catch {
        continue;
      }
      // 1 文字 (BMP) に復号できたものだけ。同じ文字が複数のコードに割り当たる場合は最初のものを使う
      if (ch.length === 1 && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  return map;
}

/**
 * 文字列を GBK でパーセントエンコードする。GBK で表せない文字を含む場合や GBK 非対応の環境では null。
 * 英数字と `-_.~` はそのまま、空白は `+` (フォームエンコード) にする。
 */
export function encodeGbkComponent(text: string): string | null {
  if (gbkTable === undefined) gbkTable = buildGbkTable();
  const table = gbkTable;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
      else if (ch === " ") out += "+";
      else out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
      continue;
    }
    const bytes = table?.get(ch);
    if (!bytes) return null;
    out += `%${bytes[0].toString(16).toUpperCase()}%${bytes[1].toString(16).toUpperCase()}`;
  }
  return out;
}

/**
 * 検索結果ページ (1 ページ目) の URL を組み立てる。
 * - Alibaba.com: `https://www.alibaba.com/trade/search?SearchText=<kw>`
 * - AliExpress : `https://www.aliexpress.com/w/wholesale-<kw-with-hyphens>.html?SearchText=<kw>`
 * - 1688       : `https://s.1688.com/selloffer/offer_search.htm?keywords=<GBK>`
 *   (1688 は GBK を前提としてきたため GBK でエンコードする。GBK で表せない文字を含む場合は UTF-8 にして `charset=utf8` を付ける。
 *    実サイトで `charset=utf8` が常に解釈されるかは未検証)
 * いずれも isAllowedFetchHost を満たすことを確認して返す (満たさなければ例外)。
 */
export function buildSearchUrl(platform: SearchPlatform, keyword: string): string {
  const kw = normalizeKeyword(keyword);
  if (!kw) throw new Error("検索キーワードが空です");
  let url: string;
  switch (platform) {
    case "ALIBABA":
      url = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(kw).replace(/%20/g, "+")}`;
      break;
    case "ALIEXPRESS": {
      // パス部分はハイフン区切り (記号は除去)。正確な検索語はクエリ側でも渡す
      const slug = kw
        .replace(/[\\/?#%&.]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .map((w) => encodeURIComponent(w))
        .join("-");
      url = `https://www.aliexpress.com/w/wholesale-${slug || "item"}.html?SearchText=${encodeURIComponent(kw).replace(/%20/g, "+")}`;
      break;
    }
    case "ALI1688": {
      const gbk = encodeGbkComponent(kw);
      url = gbk
        ? `https://s.1688.com/selloffer/offer_search.htm?keywords=${gbk}`
        : `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(kw)}&charset=utf8`;
      break;
    }
  }
  if (!isAllowedFetchHost(url)) throw new Error(`検索 URL が許可されたドメインではありません: ${url}`);
  return url;
}
