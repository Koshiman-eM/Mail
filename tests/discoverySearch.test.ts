import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSearchUrl, encodeGbkComponent, normalizeKeyword } from "@/lib/discovery/searchUrl";
import { cleanTitle, currencyFromText, intFromText, parseSearchResults, priceFromText } from "@/lib/discovery/searchParse";
import { isAllowedFetchHost } from "@/lib/scraper/url";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("検索 URL", () => {
  it("Alibaba.com: SearchText にキーワードを入れる", () => {
    const u = buildSearchUrl("ALIBABA", "  silicone   spatula ");
    expect(u).toBe("https://www.alibaba.com/trade/search?SearchText=silicone+spatula");
    expect(new URL(u).searchParams.get("SearchText")).toBe("silicone spatula");
  });

  it("AliExpress: wholesale-<kw>.html 形式 (記号は除去・ハイフン区切り)", () => {
    const u = buildSearchUrl("ALIEXPRESS", "silicone spatula/set?#");
    expect(u.startsWith("https://www.aliexpress.com/w/wholesale-silicone-spatula-set.html?")).toBe(true);
    expect(new URL(u).searchParams.get("SearchText")).toBe("silicone spatula/set?#");
  });

  it("1688: キーワードを GBK でエンコードする", () => {
    const u = buildSearchUrl("ALI1688", "硅胶铲 a");
    expect(u).toBe("https://s.1688.com/selloffer/offer_search.htm?keywords=%B9%E8%BD%BA%B2%F9+a");
    // 復号すると元に戻る
    const enc = encodeGbkComponent("硅胶铲")!;
    const bytes = Uint8Array.from(enc.split("%").filter(Boolean).map((h) => parseInt(h, 16)));
    expect(new TextDecoder("gbk").decode(bytes)).toBe("硅胶铲");
  });

  it("1688: GBK で表せない文字は UTF-8 + charset=utf8", () => {
    const u = buildSearchUrl("ALI1688", "硅胶😀");
    expect(u).toContain("charset=utf8");
    expect(new URL(u).searchParams.get("keywords")).toBe("硅胶😀");
  });

  it("すべて取得許可ドメイン (isAllowedFetchHost) を満たす", () => {
    for (const p of ["ALIBABA", "ALIEXPRESS", "ALI1688"] as const) {
      for (const kw of ["spatula", "硅胶铲", "a/b?c#d&e=f", "..%2F..", "@evil.com"]) {
        const u = buildSearchUrl(p, kw);
        expect(isAllowedFetchHost(u)).toBe(true);
        expect(["www.alibaba.com", "www.aliexpress.com", "s.1688.com"]).toContain(new URL(u).hostname);
      }
    }
  });

  it("空のキーワードは例外・長いキーワードは切り詰める", () => {
    expect(() => buildSearchUrl("ALIBABA", "   ")).toThrow();
    expect(normalizeKeyword("a".repeat(500)).length).toBe(100);
  });
});

describe("検索結果の解析 (合成フィクスチャ)", () => {
  it("Alibaba.com: 埋め込み JSON の offerList から抽出する", () => {
    const r = parseSearchResults("ALIBABA", fixture("search-alibaba.html"));
    expect(r.source).toBe("embedded-json");
    expect(r.items).toHaveLength(3);
    const [a, b, c] = r.items;
    expect(a).toMatchObject({
      externalId: "1600111111111",
      url: "https://www.alibaba.com/product-detail/Silicone-Kitchen-Spatula_1600111111111.html",
      title: "Silicone Kitchen Spatula & Turner",
      imageUrl: "https://s.alicdn.com/@sc04/kf/demo1.jpg",
      currency: "USD",
      unitPrice: "1.20",
      moq: 1000,
      priceTiers: [{ minQty: 1000, unitPrice: "1.20" }],
      supplierName: "Demo Kitchenware Co., Ltd.",
      supplierExternalId: "200000001",
      shopUrl: "https://demokitchen.en.alibaba.com/",
    });
    expect(b).toMatchObject({ externalId: "1600222222222", moq: 500, unitPrice: "2.80", priceTiers: [{ minQty: 500, unitPrice: "3.10" }, { minQty: 2000, unitPrice: "2.80" }] });
    // 価格が無い商品も一覧には残す (判定でエラーになる)
    expect(c).toMatchObject({ externalId: "1600333333333", unitPrice: null, currency: null, priceTiers: [] });
  });

  it("AliExpress: _init_data_ の itemList.content から抽出し、通貨コードを優先する", () => {
    const r = parseSearchResults("ALIEXPRESS", fixture("search-aliexpress.html"));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      externalId: "1005001111111111",
      url: "https://www.aliexpress.com/item/1005001111111111.html",
      title: "Silicone Spatula 5pcs Set Heat Resistant",
      imageUrl: "https://ae-pic-a1.aliexpress-media.com/kf/demo1.jpg",
      currency: "USD",
      unitPrice: "3.99",
      moq: 1,
      supplierName: "Demo Kitchen Store",
      supplierExternalId: "1100000001",
      shopUrl: "https://www.aliexpress.com/store/1100000001",
    });
    expect(r.items[1]).toMatchObject({ externalId: "1005002222222222", currency: "JPY", unitPrice: "450" });
  });

  it("1688: window.data.offerList から段階単価・MOQ・業者を抽出する (通貨は CNY)", () => {
    const r = parseSearchResults("ALI1688", fixture("search-1688.html"));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      externalId: "712345678901",
      url: "https://detail.1688.com/offer/712345678901.html",
      title: "硅胶铲 食品级 耐高温",
      currency: "CNY",
      moq: 3,
      unitPrice: "11.80",
      priceTiers: [
        { minQty: 3, unitPrice: "12.50" },
        { minQty: 50, unitPrice: "11.80" },
      ],
      supplierName: "示例厨具有限公司",
      supplierExternalId: "b2b-0000000001demo",
      shopUrl: "https://shop0000demo.1688.com/",
    });
    // URL が無ければ ID から正規 URL を作る
    expect(r.items[1]).toMatchObject({ externalId: "712345678902", url: "https://detail.1688.com/offer/712345678902.html", imageUrl: "https://cbu01.alicdn.com/img/ibank/demo2.jpg", moq: 2, unitPrice: "8.8" });
  });

  it("埋め込みデータが無ければ商品リンクから拾う (他ドメイン・他プラットフォーム・重複は除外)", () => {
    const r = parseSearchResults("ALIBABA", fixture("search-dom.html"));
    expect(r.source).toBe("dom");
    expect(r.items.map((i) => i.externalId)).toEqual(["1600444444444", "1600555555555"]);
    expect(r.items[0]).toMatchObject({ title: "Demo DOM Item & Co", unitPrice: "2.30", currency: "USD", moq: 50, priceTiers: [{ minQty: 50, unitPrice: "2.30" }] });
    expect(r.items[1]).toMatchObject({ unitPrice: null, priceTiers: [] });
  });

  it("1 ページあたり最大 30 件", () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ productId: String(1005000000000000 + i), title: `item ${i}`, price: "1.00" }));
    const r = parseSearchResults("ALIEXPRESS", `<script>window.runParams = ${JSON.stringify({ items: list })};</script>`);
    expect(r.items).toHaveLength(30);
  });

  it("何も無いページは空", () => {
    expect(parseSearchResults("ALI1688", "<html><body>no results</body></html>")).toEqual({ items: [], source: "none" });
  });

  it("巨大・不正な入力でも短時間で終わる (ReDoS 対策)", () => {
    const evil = [
      "<a href=" + '"'.repeat(1) + "x".repeat(300_000),
      "window.data = {" + '"a":['.repeat(20_000),
      "<script type=application/json>" + "{".repeat(200_000),
      "1,".repeat(200_000),
      "<" + "a ".repeat(200_000),
    ];
    for (const html of evil) {
      const t = Date.now();
      parseSearchResults("ALIBABA", html);
      parseSearchResults("ALI1688", html);
      expect(Date.now() - t).toBeLessThan(2000);
    }
    const t = Date.now();
    cleanTitle("<".repeat(100_000));
    priceFromText("9".repeat(100_000));
    intFromText("1,".repeat(100_000));
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("値の正規化", () => {
  it("価格・数量・通貨", () => {
    expect(priceFromText("US $1,234.50 - 2,000.00")).toBe("1234.50");
    expect(priceFromText("¥12.5")).toBe("12.5");
    expect(priceFromText(3.99)).toBe("3.99");
    expect(priceFromText("free")).toBeNull();
    expect(priceFromText("0")).toBeNull();
    expect(intFromText("Min. order: 1,000 pieces")).toBe(1000);
    expect(intFromText("≥3件")).toBe(3);
    expect(currencyFromText("US $3.99", "ALIEXPRESS")).toBe("USD");
    expect(currencyFromText("¥12.50", "ALI1688")).toBe("CNY");
    expect(currencyFromText("￥450", "ALIEXPRESS")).toBe("JPY");
    expect(currencyFromText("CN¥ 3", "ALIBABA")).toBe("CNY");
    expect(currencyFromText("12.5 EUR", "ALIBABA")).toBe("EUR");
  });
});
