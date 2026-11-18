import type { Platform } from "@prisma/client";
import type { PriceTier } from "../profit/types";
import { scanTags, tagAttr } from "./html";

export interface ParsedProduct {
  title: string | null;
  currency: string | null;
  priceTiers: PriceTier[];
  moq: number | null;
  inStock: boolean;
  stockQty: number | null;
  /** 業者 (ショップ) 名・ID・ショップ URL。取れなければ null */
  supplierName: string | null;
  supplierId: string | null;
  supplierUrl: string | null;
  /** どの抽出経路で取得できたか (デバッグ・監視用) */
  source: string[];
}

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const decimalStr = (v: Json): string | null => {
  if (isObj(v)) return decimalStr(v.value ?? v.amount ?? v.price);
  const s = String(v ?? "").replace(/[,\s]/g, "").replace(/^[^\d]+/, "");
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
};
const posInt = (v: Json): number | null => {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** JSON として解析し、失敗したら JS オブジェクトリテラルの裸キーを引用して再試行する */
function parseLooseJson(raw: string): Json | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/([{,]\s{0,50})([A-Za-z_$][\w$]{0,100})\s{0,50}:/g, '$1"$2":'));
    } catch {
      return undefined;
    }
  }
}

/**
 * `window.X = {...};` / `var X = {...}` のような埋め込み JSON を括弧の対応を見て切り出す。
 * 文字列リテラル内の括弧・エスケープも考慮する。
 */
/** 1 つの変数名について埋め込み JSON の切り出しを試す最大件数 */
const MAX_ASSIGN_MATCHES = 5;

export function extractAssignedJson(html: string, names: string[]): Json[] {
  const out: Json[] = [];
  for (const name of names) {
    const re = new RegExp(`(?:window\\.|var\\s+|let\\s+|const\\s+)?${name.replace(/[.$]/g, "\\$&")}\\s{0,20}=\\s{0,20}`, "g");
    let seen = 0;
    for (const m of html.matchAll(re)) {
      // 閉じ括弧の無い代入が大量にあると走査が O(n^2) になるため、名前ごとに試す件数を制限する
      if (++seen > MAX_ASSIGN_MATCHES) break;
      const start = (m.index ?? 0) + m[0].length;
      const open = html[start];
      if (open !== "{" && open !== "[") continue;
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let inStr: string | null = null;
      for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'") inStr = c;
        else if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            const parsed = parseLooseJson(html.slice(start, i + 1));
            if (parsed !== undefined) out.push(parsed);
            break;
          }
        }
      }
    }
  }
  return out;
}

/** ネスト位置に依存せずキー名でオブジェクトを探索する (サイトの構造変更に強くするため) */
export function findKey(root: Json, keys: string[], accept: (v: Json) => boolean = () => true, maxDepth = 12): Json | undefined {
  const seen = new Set<Json>();
  const stack: { v: Json; d: number }[] = [{ v: root, d: 0 }];
  // 幅優先で浅い位置の値を優先する
  for (let i = 0; i < stack.length; i++) {
    const { v, d } = stack[i];
    if (d > maxDepth || seen.has(v)) continue;
    seen.add(v);
    if (isObj(v)) {
      for (const k of keys) if (k in v && v[k] != null && accept(v[k])) return v[k];
      for (const child of Object.values(v)) if (typeof child === "object" && child) stack.push({ v: child, d: d + 1 });
    } else if (Array.isArray(v)) {
      for (const child of v) if (typeof child === "object" && child) stack.push({ v: child, d: d + 1 });
    }
  }
  return undefined;
}

const nonEmptyArray = (v: Json) => Array.isArray(v) && v.length > 0;
const isString = (v: Json) => typeof v === "string" && v.trim().length > 0;

function tiersFrom(arr: Json, qtyKeys: string[], priceKeys: string[]): PriceTier[] {
  if (!Array.isArray(arr)) return [];
  const tiers: PriceTier[] = [];
  for (const t of arr) {
    if (!isObj(t)) continue;
    const q = qtyKeys.map((k) => posInt(t[k])).find((n) => n !== null && n > 0);
    const p = priceKeys.map((k) => decimalStr(t[k])).find(Boolean);
    if (p) tiers.push({ minQty: q ?? 1, unitPrice: p });
  }
  return normalizeTiers(tiers);
}

function normalizeTiers(tiers: PriceTier[]): PriceTier[] {
  const byQty = new Map<number, PriceTier>();
  for (const t of tiers) if (!byQty.has(t.minQty)) byQty.set(t.minQty, t);
  return [...byQty.values()].sort((a, b) => a.minQty - b.minQty);
}

function empty(): ParsedProduct {
  return { title: null, currency: null, priceTiers: [], moq: null, inStock: true, stockQty: null, supplierName: null, supplierId: null, supplierUrl: null, source: [] };
}

/** 文字列または数値の ID を文字列化 (0 や空は除外) */
const idStr = (v: Json): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[^\s"'<>\/\\]{1,128}$/u.test(v.trim()) && v.trim() !== "0") return v.trim();
  return null;
};
const isId = (v: Json) => idStr(v) !== null;

/** ショップ URL らしい文字列を絶対 URL に正規化 (`//xxx.en.alibaba.com` → `https://...`) */
const shopUrl = (v: Json, hostRe: RegExp): string | null => {
  if (typeof v !== "string") return null;
  let u = v.trim();
  if (u.startsWith("//")) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    return hostRe.test(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
};

/** キー名で業者情報を探索し、未設定の項目だけ埋める */
function fillSupplier(
  root: Json,
  r: ParsedProduct,
  keys: { name: string[]; id: string[]; url: string[] },
  hostRe: RegExp,
  tag: string,
) {
  const before = !!(r.supplierName || r.supplierId);
  r.supplierName ??= ((findKey(root, keys.name, isString) as string | undefined) ?? null)?.trim() ?? null;
  r.supplierId ??= idStr(findKey(root, keys.id, isId));
  r.supplierUrl ??= shopUrl(findKey(root, keys.url, (v) => shopUrl(v, hostRe) !== null), hostRe);
  if (!before && (r.supplierName || r.supplierId)) r.source.push(`${tag}:supplier`);
}

/* ------------------------------------------------------------------ */
/* Alibaba.com: window.detailData / globalData.product.price.productLadderPrices */
/* ------------------------------------------------------------------ */
function parseAlibaba(html: string, r: ParsedProduct) {
  const roots = extractAssignedJson(html, ["window.detailData", "detailData", "window.__INIT_DATA__", "__INIT_DATA__"]);
  for (const root of roots) {
    const ladder = findKey(root, ["productLadderPrices", "ladderPrices", "ladderPrice"], nonEmptyArray);
    const tiers = tiersFrom(ladder, ["min", "minQuantity", "beginAmount", "startQuantity"], ["dollarPrice", "price", "formatPrice"]);
    if (tiers.length && !r.priceTiers.length) {
      r.priceTiers = tiers;
      r.source.push("alibaba:ladder");
    }
    if (!r.priceTiers.length) {
      // 価格幅のみ (range) の場合は最低価格を MOQ 段階として扱う
      const range = findKey(root, ["productRangePrices", "rangePrice"], (v) => isObj(v) || nonEmptyArray(v));
      const obj = Array.isArray(range) ? range[0] : range;
      const low = isObj(obj) ? decimalStr(obj.dollarPriceRangeLow ?? obj.priceRangeLow ?? obj.min) : null;
      if (low) {
        r.priceTiers = [{ minQty: 1, unitPrice: low }];
        r.source.push("alibaba:range");
      }
    }
    r.title ??= (findKey(root, ["subject", "productTitle", "title"], isString) as string | undefined) ?? null;
    r.moq ??= posInt(findKey(root, ["moq", "minOrderQuantity", "minOrder"], (v) => posInt(v) !== null));
    r.currency ??= (findKey(root, ["currencyCode", "currency"], (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v)) as string | undefined) ?? null;
    fillSupplier(
      root,
      r,
      { name: ["companyName", "supplierName", "companyNameEn"], id: ["companyId", "supplierId", "aliMemberId", "sellerId"], url: ["companyHomeUrl", "supplierHomeHref", "shopUrl", "homeUrl", "companyUrl"] },
      /(^|\.)alibaba\.com$/i,
      "alibaba",
    );
  }
  r.currency ??= r.priceTiers.length ? "USD" : null;
}

/* ------------------------------------------------------------------ */
/* 1688.com: window.__INIT_DATA / skuRangePrices (beginAmount, price) */
/* ------------------------------------------------------------------ */
function parse1688(html: string, r: ParsedProduct) {
  const roots = extractAssignedJson(html, ["window.__INIT_DATA", "__INIT_DATA", "window.__GLOBAL_DATA", "iDetailData", "window.iDetailConfig"]);
  for (const root of roots) {
    const ranges = findKey(root, ["skuRangePrices", "priceRanges", "currentPrices", "priceRangeList"], nonEmptyArray);
    const tiers = tiersFrom(ranges, ["beginAmount", "startQuantity", "begin", "minQuantity"], ["price", "value"]);
    if (tiers.length && !r.priceTiers.length) {
      r.priceTiers = tiers;
      r.source.push("1688:ranges");
    }
    if (!r.priceTiers.length) {
      const p = decimalStr(findKey(root, ["priceDisplay", "price"], (v) => decimalStr(v) !== null));
      if (p) {
        r.priceTiers = [{ minQty: 1, unitPrice: p }];
        r.source.push("1688:single");
      }
    }
    r.title ??= (findKey(root, ["offerTitle", "subject", "title"], isString) as string | undefined) ?? null;
    r.moq ??= posInt(findKey(root, ["beginNum", "minOrderQuantity", "moq", "beginAmount"], (v) => (posInt(v) ?? 0) > 0));

    // 在庫: SKU ごとの canBookCount を合算 (なければ単一値)
    const skuMap = findKey(root, ["skuInfoMap", "skuMap"], isObj);
    if (isObj(skuMap)) {
      const counts = Object.values(skuMap).map((s) => (isObj(s) ? posInt(s.canBookCount ?? s.stock) : null)).filter((n): n is number => n !== null);
      if (counts.length) r.stockQty = counts.reduce((a, b) => a + b, 0);
    }
    if (r.stockQty === null) r.stockQty = posInt(findKey(root, ["canBookCount", "amountOnSale"], (v) => posInt(v) !== null));
    fillSupplier(
      root,
      r,
      { name: ["companyName", "sellerName", "shopName"], id: ["memberId", "sellerMemberId", "sellerUserId", "sellerLoginId", "loginId"], url: ["sellerWinportUrl", "winportUrl", "shopUrl", "companyUrl", "storeUrl"] },
      /(^|\.)1688\.com$/i,
      "1688",
    );
  }
  if (r.priceTiers.length && r.moq && r.priceTiers[0].minQty < r.moq) r.priceTiers[0] = { ...r.priceTiers[0], minQty: r.moq };
  r.currency ??= r.priceTiers.length ? "CNY" : null;
}

/* ------------------------------------------------------------------ */
/* AliExpress: window.runParams / _init_data_ / skuPriceList           */
/* ------------------------------------------------------------------ */
function parseAliExpress(html: string, r: ParsedProduct) {
  const roots = extractAssignedJson(html, ["window.runParams", "runParams", "window._init_data_", "_init_data_", "window.__INIT_DATA__"]);
  for (const root of roots) {
    let best: { v: string; cur: string | null } | null = null;
    const consider = (amount: Json) => {
      if (!isObj(amount)) return;
      const v = decimalStr(amount.value ?? amount.amount);
      if (!v) return;
      if (!best || Number(v) < Number(best.v)) best = { v, cur: typeof amount.currency === "string" ? amount.currency : null };
    };
    const skus = findKey(root, ["skuPriceList", "skuList"], nonEmptyArray);
    if (Array.isArray(skus)) {
      let anyStock = false;
      let total = 0;
      for (const s of skus) {
        const val = isObj(s) ? (isObj(s.skuVal) ? s.skuVal : s) : null;
        if (!val) continue;
        consider(val.skuActivityAmount ?? val.skuAmount ?? val.salePrice);
        const q = posInt(val.availQuantity ?? val.inventory);
        if (q !== null) {
          anyStock = true;
          total += q;
        }
      }
      if (anyStock) r.stockQty = total;
    }
    if (!best) {
      consider(findKey(root, ["minActivityAmount", "minAmount", "salePrice"], isObj));
    }
    const b = best as { v: string; cur: string | null } | null;
    if (b && !r.priceTiers.length) {
      r.priceTiers = [{ minQty: 1, unitPrice: b.v }];
      r.currency ??= b.cur;
      r.source.push("aliexpress:sku");
    }
    r.title ??= (findKey(root, ["subject", "title"], isString) as string | undefined) ?? null;
    if (r.stockQty === null) r.stockQty = posInt(findKey(root, ["totalAvailQuantity", "availQuantity"], (v) => posInt(v) !== null));
    fillSupplier(
      root,
      r,
      { name: ["storeName", "sellerName", "shopName"], id: ["storeNum", "storeId", "sellerId", "sellerAdminSeq"], url: ["storeURL", "storeUrl", "shopUrl"] },
      /(^|\.)aliexpress\.(com|us|ru)$/i,
      "aliexpress",
    );
  }
  r.moq ??= r.priceTiers.length ? 1 : null;
  r.currency ??= r.priceTiers.length ? "USD" : null;
}

/* ------------------------------------------------------------------ */
/* 汎用: schema.org JSON-LD / 埋め込み ladderPrice                     */
/* ------------------------------------------------------------------ */
function jsonLdBlocks(html: string): Json[] {
  // 正規表現 (`<script[^>]+type=...([\s\S]*?)</script>`) は閉じタグの無い巨大入力で O(n^2) になるため、
  // 線形時間のタグ走査 + indexOf で切り出す
  const out: Json[] = [];
  const lower = html.toLowerCase();
  let closeAt = -1;
  for (const { tag, end } of scanTags(html, "script")) {
    if ((tagAttr(tag, "type") ?? "").trim().toLowerCase() !== "application/ld+json") continue;
    if (closeAt < end) {
      closeAt = lower.indexOf("</script", end);
      if (closeAt === -1) break;
    }
    try {
      out.push(JSON.parse(html.slice(end, closeAt).trim()));
    } catch {
      /* skip */
    }
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * `"ladderPrice(s)": [...]` の配列部分を切り出す。
 * `\[[^\]]*\]` のような正規表現は `]` の無い巨大な入力で O(n^2) になるため、閉じ括弧の位置を使い回して線形時間で探す。
 */
function inlineLadder(html: string, maxLen = 20_000): string | null {
  const re = /"ladderPrices?"\s{0,20}:\s{0,20}\[/g;
  let close = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const open = m.index + m[0].length - 1;
    if (close < open) {
      close = html.indexOf("]", open);
      if (close === -1) return null;
    }
    if (close - open <= maxLen) return html.slice(open, close + 1);
  }
  return null;
}

function parseGeneric(html: string, r: ParsedProduct) {
  for (const block of jsonLdBlocks(html)) {
    const items = Array.isArray(block) ? block : isObj(block) && Array.isArray(block["@graph"]) ? block["@graph"] : [block];
    for (const item of items) {
      if (!isObj(item) || !String(item["@type"]).includes("Product")) continue;
      r.title ??= typeof item.name === "string" ? item.name : null;
      const offersArr = (Array.isArray(item.offers) ? item.offers : [item.offers]).filter(isObj);
      const seller = offersArr.map((o) => o.seller).find(isObj);
      const brand = isObj(item.brand) ? item.brand : null;
      const sellerName = seller && isString(seller.name) ? String(seller.name).trim() : brand && isString(brand.name) ? String(brand.name).trim() : null;
      if (!r.supplierName && sellerName) {
        r.supplierName = sellerName;
        r.source.push("jsonld:supplier");
      }
      if (seller && typeof seller.url === "string" && /^https?:\/\//.test(seller.url)) r.supplierUrl ??= seller.url;
      const offers = (Array.isArray(item.offers) ? item.offers : [item.offers]).filter(isObj);
      const tiers: PriceTier[] = [];
      for (const o of offers) {
        r.currency ??= typeof o.priceCurrency === "string" ? o.priceCurrency : null;
        const price = decimalStr(o.price ?? o.lowPrice);
        const eq = isObj(o.eligibleQuantity) ? posInt(o.eligibleQuantity.minValue) : null;
        if (price) tiers.push({ minQty: eq && eq > 0 ? eq : 1, unitPrice: price });
        if (typeof o.availability === "string" && /OutOfStock|SoldOut/i.test(o.availability)) r.inStock = false;
      }
      if (tiers.length && !r.priceTiers.length) {
        r.priceTiers = normalizeTiers(tiers);
        r.source.push("jsonld");
      }
    }
  }
  if (!r.priceTiers.length) {
    const ladder = inlineLadder(html);
    if (ladder) {
      try {
        const tiers = tiersFrom(JSON.parse(ladder), ["min", "beginAmount", "minQuantity"], ["price", "dollarPrice"]);
        if (tiers.length) {
          r.priceTiers = tiers;
          r.source.push("inline-ladder");
        }
      } catch {
        /* skip */
      }
    }
  }
  if (r.moq === null) {
    const moq = html.match(/"(?:moq|minOrderQuantity|beginAmount)"\s{0,20}:\s{0,20}"?(\d{1,9})/i);
    if (moq) r.moq = Number(moq[1]);
  }
  if (r.stockQty === null) {
    const stock = html.match(/"(?:canBookCount|stockQuantity|totalAvailQuantity)"\s{0,20}:\s{0,20}"?(\d{1,9})/i);
    if (stock) r.stockQty = Number(stock[1]);
  }
  if (!r.title) {
    let og: string | null = null;
    for (const { tag } of scanTags(html, "meta")) {
      if ((tagAttr(tag, "property") ?? "").toLowerCase() !== "og:title") continue;
      og = tagAttr(tag, "content");
      if (og) break;
    }
    r.title = og || null;
  }
}

/**
 * 商品ページ HTML から価格・MOQ・在庫を抽出する。
 * プラットフォーム固有の埋め込みデータを優先し、取れなければ JSON-LD 等の汎用抽出にフォールバックする。
 * いずれのサイトも構造が頻繁に変わるため、キー名でネスト位置に依存せず探索している。
 */
export function parseProductPage(html: string, platform?: Platform): ParsedProduct {
  const r = empty();
  if (platform === "ALIBABA") parseAlibaba(html, r);
  else if (platform === "ALI1688") parse1688(html, r);
  else if (platform === "ALIEXPRESS") parseAliExpress(html, r);
  parseGeneric(html, r);
  if (r.moq === null && r.priceTiers.length) r.moq = r.priceTiers[0].minQty;
  if (r.stockQty === 0) r.inStock = false;
  if (r.title) r.title = r.title.trim();
  if (r.supplierName) r.supplierName = r.supplierName.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  return r;
}
