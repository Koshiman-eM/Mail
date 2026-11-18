import { describe, expect, it } from "vitest";
import { detectBlock } from "@/lib/scraper/detect";
import { diffSnapshots } from "@/lib/scraper/diff";
import { parseProductPage } from "@/lib/scraper/parse";
import { jitterMs } from "@/lib/scraper/policy";

describe("異常検知 (CAPTCHA / セッション切れ)", () => {
  it("スライダー CAPTCHA を検知", () => {
    expect(detectBlock({ url: "https://detail.1688.com/offer/1.html", html: '<div id="nc_1_n1z">请按住滑块</div>' })).toBe("captcha");
    expect(detectBlock({ url: "https://www.alibaba.com/_____tmd_____/punish?x5secdata=abc", html: "" })).toBe("captcha");
  });
  it("ログインページへのリダイレクトを検知", () => {
    expect(detectBlock({ url: "https://login.1688.com/member/signin.htm", html: "<html/>" })).toBe("login");
  });
  it("403/429 はブロック扱い", () => {
    expect(detectBlock({ url: "https://www.aliexpress.com/item/1.html", html: "", status: 429 })).toBe("blocked");
  });
  it("通常ページは null", () => {
    expect(detectBlock({ url: "https://www.alibaba.com/product-detail/x.html", html: "<h1>Product</h1>", status: 200 })).toBeNull();
  });
});

describe("商品ページ解析", () => {
  it("JSON-LD の offers から段階単価を抽出", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Silicone Kitchen Spatula",
      offers: [
        { "@type": "Offer", priceCurrency: "USD", price: "1.20", eligibleQuantity: { minValue: 500 } },
        { "@type": "Offer", priceCurrency: "USD", price: "1.50", eligibleQuantity: { minValue: 100 } },
      ],
    })}</script>`;
    const p = parseProductPage(html);
    expect(p.title).toBe("Silicone Kitchen Spatula");
    expect(p.currency).toBe("USD");
    expect(p.priceTiers).toEqual([
      { minQty: 100, unitPrice: "1.50" },
      { minQty: 500, unitPrice: "1.20" },
    ]);
    expect(p.moq).toBe(100);
  });

  it("埋め込み ladderPrice と在庫数を抽出", () => {
    const html = `<script>var d={"ladderPrices":[{"beginAmount":2,"price":"12.50"},{"beginAmount":50,"price":"11.00"}],"canBookCount":"0"}</script>`;
    const p = parseProductPage(html);
    expect(p.priceTiers).toEqual([
      { minQty: 2, unitPrice: "12.50" },
      { minQty: 50, unitPrice: "11.00" },
    ]);
    expect(p.inStock).toBe(false);
  });
});

describe("変動検知", () => {
  const prev = { priceTiers: [{ minQty: 1, unitPrice: "10.00" }], moq: 1, inStock: true };
  it("閾値未満の変動は通知しない", () => {
    expect(diffSnapshots(prev, { ...prev, priceTiers: [{ minQty: 1, unitPrice: "10.20" }] }, "A")).toEqual([]);
  });
  it("10%以上の値上がりは CRITICAL", () => {
    const [e] = diffSnapshots(prev, { ...prev, priceTiers: [{ minQty: 1, unitPrice: "11.50" }] }, "A");
    expect(e).toMatchObject({ kind: "PRICE_CHANGE", severity: "CRITICAL" });
  });
  it("値下がりは INFO", () => {
    const [e] = diffSnapshots(prev, { ...prev, priceTiers: [{ minQty: 1, unitPrice: "9.00" }] }, "A");
    expect(e).toMatchObject({ severity: "INFO" });
  });
  it("在庫切れは CRITICAL", () => {
    const [e] = diffSnapshots(prev, { ...prev, inStock: false }, "A");
    expect(e).toMatchObject({ kind: "STOCK_CHANGE", severity: "CRITICAL" });
  });
  it("初回スナップショットは通知なし", () => {
    expect(diffSnapshots(null, prev, "A")).toEqual([]);
  });
});

describe("ジッター", () => {
  it("0 以上 max 未満", () => {
    expect(jitterMs(1000, () => 0)).toBe(0);
    expect(jitterMs(1000, () => 0.999)).toBe(999);
  });
});
