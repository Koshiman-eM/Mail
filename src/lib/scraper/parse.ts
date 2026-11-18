import type { PriceTier } from "../profit/types";

export interface ParsedProduct {
  title: string | null;
  currency: string | null;
  priceTiers: PriceTier[];
  moq: number | null;
  inStock: boolean;
  stockQty: number | null;
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip */
    }
  }
  return out;
}

const decimalStr = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
};

/**
 * 商品ページ HTML から価格情報を抽出する汎用パーサー。
 * 1. schema.org Product (JSON-LD) の offers
 * 2. ページ内に埋め込まれた ladder price (例: "ladderPrice":[{"min":2,"price":"12.5"}])
 * プラットフォームの DOM 変更に追随するため、個別パーサーはこの関数を拡張して実装する。
 */
export function parseProductPage(html: string): ParsedProduct {
  const result: ParsedProduct = { title: null, currency: null, priceTiers: [], moq: null, inStock: true, stockQty: null };

  for (const block of jsonLdBlocks(html)) {
    const items = Array.isArray(block) ? block : [block];
    for (const item of items as Record<string, unknown>[]) {
      if (!item || (item["@type"] !== "Product" && !String(item["@type"]).includes("Product"))) continue;
      result.title ??= typeof item.name === "string" ? item.name : null;
      const offers = (Array.isArray(item.offers) ? item.offers : [item.offers]).filter(Boolean) as Record<string, unknown>[];
      for (const o of offers) {
        result.currency ??= typeof o.priceCurrency === "string" ? o.priceCurrency : null;
        const price = decimalStr(o.price ?? o.lowPrice);
        const minQty = Number((o.eligibleQuantity as Record<string, unknown> | undefined)?.minValue ?? 1);
        if (price) result.priceTiers.push({ minQty: Number.isFinite(minQty) && minQty > 0 ? minQty : 1, unitPrice: price });
        if (typeof o.availability === "string" && /OutOfStock|SoldOut/i.test(o.availability)) result.inStock = false;
      }
    }
  }

  if (result.priceTiers.length === 0) {
    const ladder = html.match(/"ladderPrices?"\s*:\s*(\[[^\]]*\])/);
    if (ladder) {
      try {
        const arr = JSON.parse(ladder[1]) as Record<string, unknown>[];
        for (const t of arr) {
          const price = decimalStr(t.price ?? t.dollarPrice);
          const min = Number(t.min ?? t.beginAmount ?? t.minQuantity ?? 1);
          if (price) result.priceTiers.push({ minQty: min > 0 ? min : 1, unitPrice: price });
        }
      } catch {
        /* skip */
      }
    }
  }

  const moq = html.match(/"(?:moq|minOrderQuantity|beginAmount)"\s*:\s*"?(\d+)/i);
  if (moq) result.moq = Number(moq[1]);
  else if (result.priceTiers.length) result.moq = Math.min(...result.priceTiers.map((t) => t.minQty));

  const stock = html.match(/"(?:canBookCount|stockQuantity|totalAvailQuantity)"\s*:\s*"?(\d+)/i);
  if (stock) {
    result.stockQty = Number(stock[1]);
    if (result.stockQty === 0) result.inStock = false;
  }

  if (!result.title) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    result.title = og?.[1] ?? null;
  }

  result.priceTiers.sort((a, b) => a.minQty - b.minQty);
  return result;
}
