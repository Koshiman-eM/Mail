import type { PriceTier } from "../profit/types";
import { scanTags, tagAttr } from "../scraper/html";
import { extractAssignedJson, findKey } from "../scraper/parse";
import { analyzeProductUrl } from "../scraper/url";
import type { SearchPlatform } from "./searchUrl";

/** 検索結果 1 件 */
export interface SearchItem {
  externalId: string;
  /** 正規化した商品 URL */
  url: string;
  title: string;
  imageUrl: string | null;
  /** ISO 4217。価格が取れない場合は null */
  currency: string | null;
  /** 最安段階の単価 (外貨・10 進文字列)。取れない場合は null */
  unitPrice: string | null;
  priceTiers: PriceTier[];
  moq: number | null;
  supplierName: string | null;
  supplierExternalId: string | null;
  shopUrl: string | null;
}

export interface SearchParseResult {
  items: SearchItem[];
  /** 抽出経路 (embedded-json / json-script / dom / none) */
  source: string;
}

/** 1 ページから取り出す最大件数 */
export const MAX_ITEMS_PER_PAGE = 30;

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* 値の正規化 (正規表現はすべて長さ制限付き)                             */
/* ------------------------------------------------------------------ */

/** 文字列・数値から最初の価格らしい数値を取り出す ("US $1,234.50 - 2.00" → "1234.50") */
export function priceFromText(v: Json): string | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? String(v) : null;
  if (typeof v !== "string") return null;
  const s = v.slice(0, 200).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = s.match(/\d{1,12}(?:\.\d{1,6})?/);
  if (!m) return null;
  return Number(m[0]) > 0 ? m[0] : null;
}

/** 文字列・数値から最初の整数を取り出す ("Min. order: 1,000 pieces" → 1000, "≥3件" → 3) */
export function intFromText(v: Json): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = v.slice(0, 200).replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d{1,9}/);
  if (!m) return null;
  const n = Number(m[0]);
  return n > 0 ? n : null;
}

/**
 * 表示価格の記号から通貨を推定する。明示的な通貨コードがあればそちらを優先すること。
 * 素の「¥ / ￥」は 1688 では人民元、それ以外 (日本向け表示) では円とみなす (実サイトでの表示は未検証)。
 */
export function currencyFromText(text: string, platform: SearchPlatform): string | null {
  const s = text.slice(0, 200);
  const code = s.match(/\b(USD|CNY|RMB|JPY|EUR|GBP)\b/);
  if (code) return code[1] === "RMB" ? "CNY" : code[1];
  if (/CN\s?[¥￥]|元|人民币/.test(s)) return "CNY";
  if (/JP\s?[¥￥]|円/.test(s)) return "JPY";
  if (/US\s?\$|\$/.test(s)) return "USD";
  if (/€/.test(s)) return "EUR";
  if (/£/.test(s)) return "GBP";
  if (/[¥￥]/.test(s)) return platform === "ALI1688" ? "CNY" : "JPY";
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** タイトルの HTML タグ除去・実体参照の復号・空白の正規化 */
export function cleanTitle(raw: string): string {
  return raw
    .slice(0, 2000)
    .replace(/<[^<>]{0,300}>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** `//host/path` を https に揃え、http(s) の URL だけ返す */
function absUrl(v: Json): string | null {
  if (typeof v !== "string") return null;
  let u = v.trim();
  if (!u || u.length > 2000) return null;
  if (u.startsWith("//")) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

const SHOP_HOST: Record<SearchPlatform, RegExp> = {
  ALIBABA: /(^|\.)alibaba\.com$/i,
  ALIEXPRESS: /(^|\.)aliexpress\.(com|us|ru)$/i,
  ALI1688: /(^|\.)1688\.com$/i,
};

/** 商品 ID から正規の商品 URL を作る (analyzeProductUrl で解析できる形) */
export function productUrlFor(platform: SearchPlatform, id: string): string {
  switch (platform) {
    case "ALIBABA":
      return `https://www.alibaba.com/product-detail/${id}.html`;
    case "ALIEXPRESS":
      return `https://www.aliexpress.com/item/${id}.html`;
    case "ALI1688":
      return `https://detail.1688.com/offer/${id}.html`;
  }
}

const ID_KEYS = ["productId", "offerId", "itemId", "id", "product_id", "offer_id"];
const URL_KEYS = ["productUrl", "detailUrl", "itemUrl", "offerUrl", "productDetailUrl", "linkUrl", "url", "href"];
const TITLE_KEYS = ["title", "subject", "displayTitle", "productTitle", "offerTitle", "titleText", "name"];
const IMAGE_KEYS = ["imageUrl", "imgUrl", "mainImage", "image", "picUrl", "offerPicUrl", "imagePath", "img"];
const PRICE_KEYS = ["salePrice", "promotionPrice", "minPrice", "price", "priceInfo", "prices", "tradePrice", "priceStr", "priceRange", "localPrice", "formattedPrice", "originalPrice"];
const TIER_KEYS = ["ladderPrices", "ladderPrice", "priceTiers", "quantityPrices", "priceRanges", "skuRangePrices"];
const MOQ_KEYS = ["moq", "minOrderQuantity", "quantityBegin", "beginAmount", "minOrder", "moqText", "minOrderText", "moqV2"];
const SUPPLIER_NAME_KEYS = ["companyName", "storeName", "supplierName", "shopName", "sellerName", "companyTitle"];
const SUPPLIER_ID_KEYS = ["companyId", "storeId", "memberId", "sellerId", "supplierId", "storeNum", "sellerMemberId"];
const SHOP_URL_KEYS = ["supplierHref", "supplierHomeHref", "companyUrl", "companyHomeUrl", "storeUrl", "storeURL", "shopUrl", "winportUrl", "sellerWinportUrl"];
const SUPPLIER_OBJ_KEYS = ["supplier", "company", "store", "seller", "shop"];

const idStr = (v: Json): string | null => {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^\d{6,20}$/.test(v.trim())) return v.trim();
  return null;
};
const supplierIdStr = (v: Json): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[^\s"'<>\/\\]{1,128}$/u.test(v.trim()) && v.trim() !== "0") return v.trim();
  return null;
};
const titleOf = (v: Json): string | null => {
  if (typeof v === "string") return cleanTitle(v) || null;
  if (isObj(v)) return titleOf(v.displayTitle ?? v.seoTitle ?? v.text ?? null);
  return null;
};
const imageOf = (v: Json): string | null => {
  if (isObj(v)) return absUrl(v.imgUrl ?? v.imageUrl ?? v.url ?? v.mainImage ?? null);
  return absUrl(v);
};

interface PriceHit {
  value: string;
  currency: string | null;
}

/** 価格の値 (数値・文字列・{ minPrice, currencyCode, formattedPrice } 等) を解釈する */
function priceOf(v: Json, platform: SearchPlatform, depth = 0): PriceHit | null {
  if (depth > 3) return null;
  if (typeof v === "number" || typeof v === "string") {
    const value = priceFromText(v);
    return value ? { value, currency: typeof v === "string" ? currencyFromText(v, platform) : null } : null;
  }
  if (!isObj(v)) return null;
  const code = [v.currencyCode, v.currency].find((c) => typeof c === "string" && /^[A-Z]{3}$/.test(c)) as string | undefined;
  for (const k of ["minPrice", "value", "price", "amount", "minAmount", "salePrice", "priceInfo", "offerPrice", "formattedPrice", "priceStr", "valueString"]) {
    if (!(k in v) || v[k] == null) continue;
    const hit = priceOf(v[k], platform, depth + 1);
    if (hit) {
      const fromFmt = typeof v.formattedPrice === "string" ? currencyFromText(v.formattedPrice, platform) : null;
      return { value: hit.value, currency: code ?? hit.currency ?? fromFmt };
    }
  }
  return null;
}

function tiersOf(v: Json, platform: SearchPlatform): PriceTier[] {
  if (!Array.isArray(v)) return [];
  const byQty = new Map<number, PriceTier>();
  for (const t of v.slice(0, 20)) {
    if (!isObj(t)) continue;
    const q = ["min", "minQuantity", "beginAmount", "startQuantity", "quantity", "minQty", "begin"].map((k) => intFromText(t[k])).find((n) => n !== null);
    const p = ["price", "dollarPrice", "value", "valueString", "unitPrice", "formatPrice"].map((k) => priceOf(t[k], platform)).find(Boolean);
    if (p && !byQty.has(q ?? 1)) byQty.set(q ?? 1, { minQty: q ?? 1, unitPrice: p.value });
  }
  return [...byQty.values()].sort((a, b) => a.minQty - b.minQty);
}

const findIn = (obj: Obj, keys: string[], accept: (v: Json) => boolean, depth = 3) => findKey(obj, keys, accept, depth);

/** 検索結果 1 件分のオブジェクトを正規化する。必須項目 (ID・商品名) が無ければ null */
export function normalizeSearchItem(platform: SearchPlatform, obj: Obj): SearchItem | null {
  // URL → ID の順で特定する (URL のプラットフォームが一致する場合のみ採用)
  const rawUrl = absUrl(findIn(obj, URL_KEYS, (v) => {
    const a = absUrl(v);
    return !!a && analyzeProductUrl(a)?.platform === platform && !!analyzeProductUrl(a)?.externalId;
  }));
  const analyzed = rawUrl ? analyzeProductUrl(rawUrl) : null;
  const id = analyzed?.externalId ?? idStr(findIn(obj, ID_KEYS, (v) => idStr(v) !== null, 2));
  if (!id) return null;
  const title = titleOf(findIn(obj, TITLE_KEYS, (v) => titleOf(v) !== null));
  if (!title) return null;
  const url = analyzed?.externalId === id ? analyzed.canonicalUrl : productUrlFor(platform, id);

  let tiers = tiersOf(findIn(obj, TIER_KEYS, (v) => tiersOf(v, platform).length > 0), platform);
  const single = priceOf(findIn(obj, PRICE_KEYS, (v) => priceOf(v, platform) !== null), platform);
  let moq = intFromText(findIn(obj, MOQ_KEYS, (v) => intFromText(isObj(v) ? (v.value ?? v.quantity ?? null) : v) !== null));
  if (moq === null) {
    const m = findIn(obj, MOQ_KEYS, isObj);
    if (isObj(m)) moq = intFromText(m.value ?? m.quantity ?? null);
  }
  if (!tiers.length && single) tiers = [{ minQty: moq ?? 1, unitPrice: single.value }];
  if (tiers.length && moq && tiers[0].minQty < moq) tiers[0] = { ...tiers[0], minQty: moq };
  moq ??= tiers[0]?.minQty ?? null;
  const unitPrice = tiers.length ? tiers.reduce((a, b) => (Number(b.unitPrice) < Number(a.unitPrice) ? b : a)).unitPrice : null;
  const currency = unitPrice
    ? ((findIn(obj, ["currencyCode", "currency"], (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v)) as string | undefined) ?? single?.currency ?? (platform === "ALI1688" ? "CNY" : "USD"))
    : null;

  let supplierName = (findIn(obj, SUPPLIER_NAME_KEYS, (v) => typeof v === "string" && v.trim() !== "") as string | undefined)?.trim() ?? null;
  let supplierExternalId = supplierIdStr(findIn(obj, SUPPLIER_ID_KEYS, (v) => supplierIdStr(v) !== null));
  let shopUrl = absUrl(findIn(obj, SHOP_URL_KEYS, (v) => {
    const a = absUrl(v);
    return !!a && SHOP_HOST[platform].test(new URL(a).hostname);
  }));
  for (const k of SUPPLIER_OBJ_KEYS) {
    const sub = obj[k];
    if (!isObj(sub)) continue;
    if (!supplierName && typeof sub.name === "string" && sub.name.trim()) supplierName = sub.name.trim();
    supplierExternalId ??= supplierIdStr(sub.id ?? null);
    if (!shopUrl) {
      const a = absUrl(sub.url ?? sub.href ?? null);
      if (a && SHOP_HOST[platform].test(new URL(a).hostname)) shopUrl = a;
    }
  }

  return {
    externalId: id,
    url,
    title,
    imageUrl: imageOf(findIn(obj, IMAGE_KEYS, (v) => imageOf(v) !== null)),
    currency,
    unitPrice,
    priceTiers: tiers,
    moq,
    supplierName: supplierName ? supplierName.replace(/\s+/g, " ").slice(0, 200) : null,
    supplierExternalId,
    shopUrl,
  };
}

/**
 * JSON の中から「商品一覧らしい配列」を探す: 正規化できる要素が最も多い配列を採用する。
 * 走査するノード数に上限を設ける (巨大な入力でも時間を抑えるため)。
 */
function bestItemArray(platform: SearchPlatform, root: Json, maxNodes = 20_000, maxNormalize = 3_000): SearchItem[] {
  let best: SearchItem[] = [];
  const stack: { v: Json; d: number }[] = [{ v: root, d: 0 }];
  let visited = 0;
  let normalized = 0;
  while (stack.length && visited < maxNodes && normalized < maxNormalize) {
    const { v, d } = stack.pop()!;
    visited++;
    if (d > 14) continue;
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (objs.length >= 1) {
        const items: SearchItem[] = [];
        for (const o of objs.slice(0, 100)) {
          if (++normalized > maxNormalize) break;
          const it = normalizeSearchItem(platform, o);
          if (it) items.push(it);
        }
        if (items.length > best.length) best = items;
      }
      for (const c of v) if (typeof c === "object" && c) stack.push({ v: c, d: d + 1 });
    } else if (isObj(v)) {
      for (const c of Object.values(v)) if (typeof c === "object" && c) stack.push({ v: c, d: d + 1 });
    }
  }
  return best;
}

/** サイトがページに埋め込む状態変数の名前 (公開情報からの推測。実サイトで変わる可能性がある) */
const STATE_NAMES: Record<SearchPlatform, string[]> = {
  ALIBABA: ["__page__data_sse10", "__page__data__", "_PAGE_DATA_", "__INIT_DATA__", "pageData"],
  ALIEXPRESS: ["_init_data_", "runParams", "__INIT_DATA__", "__AER_DATA__"],
  ALI1688: ["window.data", "__INIT_DATA", "__GLOBAL_DATA", "pageData"],
};

/** `<script type="application/json">` (Next.js の __NEXT_DATA__ 等) の中身。線形時間のタグ走査 + indexOf で切り出す */
function jsonScriptBlocks(html: string, max = 10): Json[] {
  const out: Json[] = [];
  const lower = html.toLowerCase();
  let closeAt = -1;
  for (const { tag, end } of scanTags(html, "script")) {
    const type = (tagAttr(tag, "type") ?? "").trim().toLowerCase();
    if (type !== "application/json") continue;
    if (closeAt < end) {
      closeAt = lower.indexOf("</script", end);
      if (closeAt === -1) break;
    }
    try {
      out.push(JSON.parse(html.slice(end, closeAt).trim()));
    } catch {
      /* skip */
    }
    if (out.length >= max) break;
  }
  return out;
}

/** 埋め込みデータが無い場合: 商品ページへのリンク (<a href>) から ID・商品名 (title 属性等)・data-price を拾う */
function parseDom(platform: SearchPlatform, html: string): SearchItem[] {
  const seen = new Map<string, SearchItem>();
  for (const { tag } of scanTags(html, "a")) {
    const href = absUrl(tagAttr(tag, "href"));
    if (!href) continue;
    const a = analyzeProductUrl(href);
    if (!a || a.platform !== platform || !a.externalId || seen.has(a.externalId)) continue;
    const title = titleOf(tagAttr(tag, "title") ?? tagAttr(tag, "aria-label") ?? tagAttr(tag, "data-title"));
    if (!title) continue;
    const priceRaw = tagAttr(tag, "data-price");
    const price = priceRaw ? priceFromText(cleanTitle(priceRaw)) : null;
    const moq = intFromText(tagAttr(tag, "data-moq"));
    seen.set(a.externalId, {
      externalId: a.externalId,
      url: a.canonicalUrl,
      title,
      imageUrl: null,
      currency: price ? (currencyFromText(cleanTitle(priceRaw!), platform) ?? (platform === "ALI1688" ? "CNY" : "USD")) : null,
      unitPrice: price,
      priceTiers: price ? [{ minQty: moq ?? 1, unitPrice: price }] : [],
      moq,
      supplierName: null,
      supplierExternalId: null,
      shopUrl: null,
    });
    if (seen.size >= MAX_ITEMS_PER_PAGE) break;
  }
  return [...seen.values()];
}

function dedupe(items: SearchItem[]): SearchItem[] {
  const map = new Map<string, SearchItem>();
  for (const it of items) if (!map.has(it.externalId)) map.set(it.externalId, it);
  return [...map.values()].slice(0, MAX_ITEMS_PER_PAGE);
}

/**
 * 検索結果ページの HTML から商品一覧を取り出す。
 * 1. ページに埋め込まれた状態 JSON (変数代入 / application/json の script) から商品配列を探す
 * 2. 取れなければ商品ページへのリンクから拾う (DOM フォールバック。価格は data-price がある場合のみ)
 * 正規表現は長さ制限付き・タグ走査は線形時間のものを使う (ReDoS 対策)。最大 MAX_ITEMS_PER_PAGE 件。
 */
export function parseSearchResults(platform: SearchPlatform, html: string): SearchParseResult {
  let best: SearchItem[] = [];
  let source = "none";
  for (const root of extractAssignedJson(html, STATE_NAMES[platform])) {
    const items = bestItemArray(platform, root);
    if (items.length > best.length) {
      best = items;
      source = "embedded-json";
    }
  }
  if (!best.length) {
    for (const root of jsonScriptBlocks(html)) {
      const items = bestItemArray(platform, root);
      if (items.length > best.length) {
        best = items;
        source = "json-script";
      }
    }
  }
  if (!best.length) {
    best = parseDom(platform, html);
    if (best.length) source = "dom";
  }
  return { items: dedupe(best), source };
}
