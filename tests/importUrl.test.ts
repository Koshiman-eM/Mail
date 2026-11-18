import { describe, expect, it } from "vitest";
import { analyzeProductUrl, canonicalFromHtml, extractUrlFromText, extractUrls, findProductUrl } from "@/lib/scraper/url";
import { UnsupportedUrlError, resolveImportUrl } from "@/lib/jobs/importProduct";
import { blockNote, classifyStatus, isPlaceholderSupplier, isPlaceholderTitle, isTransientError, placeholderSupplierId } from "@/lib/jobs/common";

describe("商品 URL の解析", () => {
  it("Alibaba.com の商品詳細 (クエリ除去・www に正規化)", () => {
    expect(analyzeProductUrl("https://www.alibaba.com/product-detail/Silicone-Kitchen-Spatula_1600123456789.html?spm=a2700.galleryofferlist&s=p")).toEqual({
      platform: "ALIBABA",
      externalId: "1600123456789",
      canonicalUrl: "https://www.alibaba.com/product-detail/Silicone-Kitchen-Spatula_1600123456789.html",
    });
    expect(analyzeProductUrl("https://japanese.alibaba.com/product-detail/Spatula_1600123456789.html")?.canonicalUrl).toBe(
      "https://www.alibaba.com/product-detail/Spatula_1600123456789.html",
    );
  });
  it("Alibaba.com のモバイル版", () => {
    expect(analyzeProductUrl("https://m.alibaba.com/product/1600123456789/Silicone-Spatula.html?x=1")).toEqual({
      platform: "ALIBABA",
      externalId: "1600123456789",
      canonicalUrl: "https://m.alibaba.com/product/1600123456789/Silicone-Spatula.html",
    });
    expect(analyzeProductUrl("https://m.alibaba.com/product-detail/Spatula_1600123456789.html")?.externalId).toBe("1600123456789");
  });
  it("1688 (PC・モバイル・短縮リンク)", () => {
    expect(analyzeProductUrl("https://detail.1688.com/offer/712345678901.html?spm=abc")).toEqual({
      platform: "ALI1688",
      externalId: "712345678901",
      canonicalUrl: "https://detail.1688.com/offer/712345678901.html",
    });
    expect(analyzeProductUrl("https://m.1688.com/offer/712345678901.html")?.canonicalUrl).toBe("https://detail.1688.com/offer/712345678901.html");
    expect(analyzeProductUrl("https://qr.1688.com/s/AbCdEf")).toEqual({ platform: "ALI1688", externalId: null, canonicalUrl: "https://qr.1688.com/s/AbCdEf" });
  });
  it("AliExpress (各ドメイン・短縮リンク)", () => {
    const want = { platform: "ALIEXPRESS", externalId: "1005001234567890", canonicalUrl: "https://www.aliexpress.com/item/1005001234567890.html" };
    expect(analyzeProductUrl("https://www.aliexpress.com/item/1005001234567890.html?spm=a2g0o&gatewayAdapt=glo2jpn")).toEqual(want);
    expect(analyzeProductUrl("https://ja.aliexpress.com/item/1005001234567890.html")).toEqual(want);
    expect(analyzeProductUrl("https://m.aliexpress.com/item/1005001234567890.html")).toEqual(want);
    expect(analyzeProductUrl("https://www.aliexpress.us/item/1005001234567890.html")?.canonicalUrl).toBe("https://www.aliexpress.us/item/1005001234567890.html");
    expect(analyzeProductUrl("https://a.aliexpress.com/_mKabcde")).toMatchObject({ platform: "ALIEXPRESS", externalId: null });
    expect(analyzeProductUrl("https://s.click.aliexpress.com/e/_DlXyz12")).toMatchObject({ platform: "ALIEXPRESS", externalId: null });
  });
  it("対応外・商品ページ以外は null", () => {
    expect(analyzeProductUrl("https://www.amazon.co.jp/dp/B000000000")).toBeNull();
    expect(analyzeProductUrl("https://www.alibaba.com/")).toBeNull();
    expect(analyzeProductUrl("https://www.aliexpress.com/store/1100000001")).toBeNull();
    expect(analyzeProductUrl("https://evil-alibaba.com/product-detail/x_1600123456789.html")).toBeNull();
    expect(analyzeProductUrl("javascript:alert(1)")).toBeNull();
    expect(analyzeProductUrl("not a url")).toBeNull();
  });
});

describe("共有テキストからの URL 抽出", () => {
  it("Android アプリの共有文から商品 URL を取り出す", () => {
    const text = "【AliExpress】シリコンヘラ 5本セット 耐熱 https://a.aliexpress.com/_mKabcde 今すぐチェック！";
    expect(extractUrlFromText(text)).toBe("https://a.aliexpress.com/_mKabcde");
  });
  it("全角の括弧・句読点で区切る", () => {
    expect(extractUrls("見て（https://detail.1688.com/offer/712345678901.html）。")).toEqual(["https://detail.1688.com/offer/712345678901.html"]);
    expect(extractUrls("see https://www.alibaba.com/product-detail/x_1600123456789.html.")).toEqual(["https://www.alibaba.com/product-detail/x_1600123456789.html"]);
  });
  it("対応サイトの URL を優先し、無ければ最初の URL", () => {
    expect(extractUrlFromText("https://example.com/a and https://detail.1688.com/offer/712345678901.html")).toBe("https://detail.1688.com/offer/712345678901.html");
    expect(extractUrlFromText("https://example.com/a")).toBe("https://example.com/a");
    expect(extractUrlFromText("URL なし")).toBeNull();
    expect(extractUrlFromText(undefined)).toBeNull();
  });
  it("findProductUrl は url → text → title の順に探す", () => {
    expect(findProductUrl(null, "商品 https://www.aliexpress.com/item/1005001234567890.html", "x")).toBe("https://www.aliexpress.com/item/1005001234567890.html");
    expect(findProductUrl("https://example.com", "こんにちは")).toBeNull();
  });
  it("canonical / og:url から商品 URL を得る (短縮リンクのソース貼り付け用)", () => {
    expect(canonicalFromHtml('<link rel="canonical" href="https://www.aliexpress.com/item/1005001234567890.html">')).toBe("https://www.aliexpress.com/item/1005001234567890.html");
    expect(canonicalFromHtml('<meta property="og:url" content="//detail.1688.com/offer/712345678901.html">')).toBe("https://detail.1688.com/offer/712345678901.html");
    expect(canonicalFromHtml("<html></html>")).toBeNull();
  });
});

describe("取り込み URL の解決", () => {
  it("url 優先、空なら text から", () => {
    expect(resolveImportUrl({ url: "", text: "x https://detail.1688.com/offer/712345678901.html" }).analyzed.externalId).toBe("712345678901");
    expect(resolveImportUrl({ url: "商品 https://m.1688.com/offer/712345678901.html" }).analyzed.platform).toBe("ALI1688");
  });
  it("対応外や URL なしは UnsupportedUrlError (422)", () => {
    expect(() => resolveImportUrl({ url: "https://www.amazon.co.jp/dp/B000000000" })).toThrow(UnsupportedUrlError);
    expect(() => resolveImportUrl({ text: "URL がありません" })).toThrow(/商品 URL が見つかりません/);
  });
});

describe("取得まわりの補助関数", () => {
  it("仮の業者・商品名の判定", () => {
    expect(placeholderSupplierId("ALI1688", "1")).toBe("unknown:ALI1688:1");
    expect(isPlaceholderSupplier({ externalId: "unknown:ALI1688:1", name: "X" })).toBe(true);
    expect(isPlaceholderSupplier({ externalId: "b2b-1", name: "業者未設定" })).toBe(true);
    expect(isPlaceholderSupplier({ externalId: "b2b-1", name: "示例" })).toBe(false);
    expect(isPlaceholderTitle({ title: "https://x/y", url: "https://x/y" })).toBe(true);
    expect(isPlaceholderTitle({ title: "Spatula", url: "https://x/y" })).toBe(false);
  });
  it("HTTP ステータスの分類", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(404)).toBe("fail");
  });
  it("一時的なエラーの判定", () => {
    const t = new Error("x");
    t.name = "FetchTimeoutError";
    expect(isTransientError(t)).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("Product x not found"))).toBe(false);
  });
  it("CAPTCHA の理由は手動対応を案内する", () => {
    expect(blockNote("captcha", "ALIBABA")).toBe("CAPTCHA のため取得できませんでした。ページのソースを貼り付けるか、手入力してください");
    expect(blockNote("paused", "ALI1688")).toContain("一時停止中");
  });
});
