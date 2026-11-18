import { describe, expect, it } from "vitest";
import { canonicalFromHtml, isAllowedFetchHost, isPrivateOrLocalHost, shouldAllowBrowserRequest } from "@/lib/scraper/url";
import { parseProductPage } from "@/lib/scraper/parse";
import { scanTags, tagAttr } from "@/lib/scraper/html";
import { currencyMismatchNote } from "@/lib/jobs/common";

describe("isAllowedFetchHost: 取得 (リダイレクト各段) を許可するホスト", () => {
  it.each([
    "https://www.alibaba.com/product-detail/x_1600123456789.html",
    "https://m.alibaba.com/product/1600123456789.html",
    "https://sale.alibaba.com/p/x",
    "https://detail.1688.com/offer/123456789.html",
    "https://qr.1688.com/s/abc",
    "https://www.aliexpress.com/item/1005001234567890.html",
    "https://a.aliexpress.com/_mKabc",
    "https://s.click.aliexpress.com/e/_abc",
    "https://www.aliexpress.us/item/1.html",
    "https://aliexpress.ru/item/1.html",
    "https://login.aliexpress.com/?return=x",
    "https://passport.alibaba.com/ac/password_reset.htm",
    "https://login.taobao.com/member/login.jhtml",
    "http://www.alibaba.com/",
    "https://WWW.ALIBABA.COM./x",
    "https://www.alibaba.com:443/x",
  ])("許可: %s", (url) => {
    expect(isAllowedFetchHost(url)).toBe(true);
  });

  it.each([
    "https://evil.example.com/",
    "https://alibaba.com.evil.example/",
    "https://notalibaba.com/",
    "https://www.alibaba.com.cn/", // 別ドメイン
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://localhost:3000/",
    "http://foo.localhost/",
    "file:///etc/passwd",
    "ftp://www.alibaba.com/",
    "javascript:alert(1)",
    "https://user:pass@www.alibaba.com/",
    "https://www.alibaba.com:8080/",
    "not a url",
  ])("拒否: %s", (url) => {
    expect(isAllowedFetchHost(url)).toBe(false);
  });

  it("プライベート/ループバックの判定", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "[::1]", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "metadata.google.internal"]) {
      expect(isPrivateOrLocalHost(h), h).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "www.alibaba.com", "ae01.alicdn.com"]) {
      expect(isPrivateOrLocalHost(h), h).toBe(false);
    }
  });
});

describe("shouldAllowBrowserRequest: Playwright のリクエスト制御", () => {
  it("対応サイトへのページ遷移は許可、それ以外のページ遷移は遮断", () => {
    expect(shouldAllowBrowserRequest("https://detail.1688.com/offer/1.html", "document")).toBe(true);
    expect(shouldAllowBrowserRequest("https://evil.example.com/", "document")).toBe(false);
  });
  it("サブリソースは任意の公開ホストから許可 (描画のため)", () => {
    expect(shouldAllowBrowserRequest("https://ae01.alicdn.com/kf/x.jpg", "image")).toBe(true);
    expect(shouldAllowBrowserRequest("https://g.alicdn.com/x.js", "script")).toBe(true);
  });
  it("localhost・プライベート IP へは種類を問わず遮断", () => {
    expect(shouldAllowBrowserRequest("http://127.0.0.1:6379/", "xhr")).toBe(false);
    expect(shouldAllowBrowserRequest("http://169.254.169.254/latest/meta-data/", "fetch")).toBe(false);
    expect(shouldAllowBrowserRequest("http://localhost:3000/api/x", "image")).toBe(false);
    expect(shouldAllowBrowserRequest("file:///etc/passwd", "document")).toBe(false);
  });
});

describe("タグ走査 (ReDoS 対策)", () => {
  it("開始タグと属性を取り出す", () => {
    const html = `<head><LINK rel="canonical" href="https://x/1"><link rel='icon' href=/f.ico><meta property="og:url" content="https://y/2"></head>`;
    const tags = [...scanTags(html, "link")].map((t) => t.tag);
    expect(tags).toHaveLength(2);
    expect(tagAttr(tags[0], "href")).toBe("https://x/1");
    expect(tagAttr(tags[1], "href")).toBe("/f.ico");
    expect(tagAttr(tags[1], "rel")).toBe("icon");
    expect([...scanTags("<linkfoo><link>", "link")].map((t) => t.tag)).toEqual(["<link>"]);
  });

  it("2MB の悪意ある入力 (閉じ > の無い <link / <meta / <script の繰り返し) も 1 秒未満で処理する", () => {
    const size = 2 * 1024 * 1024;
    const inputs = [
      "<link ".repeat(size / 6),
      "<link rel='canonical' ".repeat(size / 22),
      "<meta property=\"og:url\" content=\"".repeat(size / 34),
      "<meta property='og:title' ".repeat(size / 26),
      "<script type=\"application/ld+json\">{".repeat(size / 36),
      `"ladderPrice":[`.repeat(size / 15),
      "window.detailData = {".repeat(size / 21),
      `"moq":${" ".repeat(size)}`,
    ];
    for (const html of inputs) {
      const t0 = performance.now();
      canonicalFromHtml(html);
      parseProductPage(html, "ALIBABA");
      parseProductPage(html, "ALI1688");
      parseProductPage(html, "ALIEXPRESS");
      const ms = performance.now() - t0;
      expect(ms, `${html.slice(0, 30)}... took ${ms}ms`).toBeLessThan(1000);
    }
  });

  it("従来どおり canonical / og:url / og:title / JSON-LD を抽出できる", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.aliexpress.com/item/1005001234567890.html">
      <meta property="og:title" content="LED Light">
      <script type="application/ld+json">{"@type":"Product","name":"LED","offers":{"price":"1.50","priceCurrency":"USD"}}</script>
    </head></html>`;
    expect(canonicalFromHtml(html)).toBe("https://www.aliexpress.com/item/1005001234567890.html");
    const p = parseProductPage(html);
    expect(p.priceTiers).toEqual([{ minQty: 1, unitPrice: "1.50" }]);
    expect(p.currency).toBe("USD");
    expect(p.title).toBe("LED");
    expect(parseProductPage(`<meta property="og:title"><meta content="Lamp" property="og:title">`).title).toBe("Lamp");
    expect(canonicalFromHtml(`<meta property="og:url" content="https://detail.1688.com/offer/123456789.html">`)).toBe("https://detail.1688.com/offer/123456789.html");
  });
});

describe("currencyMismatchNote: 再取得時の通貨の食い違い", () => {
  const tiers = [{ minQty: 1, unitPrice: "1.00" }];
  it("価格がある商品で通貨が変わったら理由を返す (価格は更新しない)", () => {
    expect(currencyMismatchNote({ currency: "USD", priceTiers: tiers }, "JPY")).toBe("ページの通貨が JPY になっていました (登録時 USD)。価格は更新していません。");
  });
  it("同じ通貨・通貨不明・未取得 (価格なし) の商品は対象外", () => {
    expect(currencyMismatchNote({ currency: "USD", priceTiers: tiers }, "usd")).toBeNull();
    expect(currencyMismatchNote({ currency: "USD", priceTiers: tiers }, null)).toBeNull();
    expect(currencyMismatchNote({ currency: "USD", priceTiers: [] }, "CNY")).toBeNull();
    expect(currencyMismatchNote({ currency: "USD", priceTiers: null }, "CNY")).toBeNull();
  });
});
