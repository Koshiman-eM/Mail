import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RAKUTEN_ITEM_SEARCH_URL,
  createRakutenProvider,
  isAllowedRakutenEndpoint,
  parseRakutenItems,
  rakutenErrorNote,
  resetRakutenThrottle,
} from "@/lib/discovery/domestic/rakuten";
import { createAmazonProvider } from "@/lib/discovery/domestic/amazon";
import { aggregateDomesticPrices, quantile } from "@/lib/discovery/domestic/aggregate";
import { domesticProviderStatus } from "@/lib/discovery/domestic";
import { D } from "@/lib/decimal";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const V2 = {
  count: 2,
  Items: [
    { itemName: "シリコン ヘラ 耐熱", itemPrice: 1280, itemUrl: "https://item.rakuten.co.jp/shop-a/1/", shopName: "ショップA" },
    { itemName: "ヘラ セット", itemPrice: "2,000", itemUrl: "https://item.rakuten.co.jp/shop-b/2/" },
    { itemName: "価格なし", itemUrl: "https://item.rakuten.co.jp/shop-c/3/" },
    { itemName: "危険な URL", itemPrice: 100, itemUrl: "javascript:alert(1)" },
  ],
};
const V1 = { Items: [{ Item: { itemName: "旧形式 ヘラ", itemPrice: 980, itemUrl: "https://item.rakuten.co.jp/shop-d/4/", shopName: "ショップD" } }] };

describe("楽天市場 API クライアント (fetch をモック)", () => {
  beforeEach(() => resetRakutenThrottle());

  const base = { applicationId: "app-id", accessKey: "secret-key", referer: "https://sedori.onrender.com/" };

  it("Referer ヘッダー・必須パラメーター・accessKey (クエリ + ヘッダー) を送り、formatVersion 2 の応答を解析する", async () => {
    const fetchImpl = vi.fn(async () => json(V2));
    const p = createRakutenProvider({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.isConfigured()).toBe(true);
    const r = await p.search("  シリコン   ヘラ ");
    expect(r.items).toEqual([
      { title: "シリコン ヘラ 耐熱", priceJpy: "1280", url: "https://item.rakuten.co.jp/shop-a/1/", shop: "ショップA" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(DEFAULT_RAKUTEN_ITEM_SEARCH_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      applicationId: "app-id",
      accessKey: "secret-key",
      format: "json",
      formatVersion: "2",
      keyword: "シリコン ヘラ",
      hits: "30",
      sort: "standard",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Referer).toBe("https://sedori.onrender.com/");
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(init.redirect).toBe("error");
  });

  it("価格が文字列 (カンマ付き) でも数値化できないものは除外し、旧形式 (Items[].Item) も読める", () => {
    expect(parseRakutenItems(V1)).toEqual([{ title: "旧形式 ヘラ", priceJpy: "980", url: "https://item.rakuten.co.jp/shop-d/4/", shop: "ショップD" }]);
    expect(parseRakutenItems(null)).toEqual([]);
    expect(parseRakutenItems({ Items: "x" })).toEqual([]);
  });

  it("accessKey の渡し方を切り替えられる", async () => {
    const fetchImpl = vi.fn(async () => json(V1));
    await createRakutenProvider({ ...base, accessKeyMode: "header", fetchImpl: fetchImpl as unknown as typeof fetch }).search("x");
    let [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has("accessKey")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");

    resetRakutenThrottle();
    await createRakutenProvider({ ...base, accessKeyMode: "param", fetchImpl: fetchImpl as unknown as typeof fetch }).search("x");
    [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("accessKey")).toBe("secret-key");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("呼び出し間隔を 1 秒以上空ける", async () => {
    let t = 10_000;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const fetchImpl = vi.fn(async () => json(V2));
    const p = createRakutenProvider({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t, sleep });
    await p.search("a");
    t += 300;
    await p.search("b");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(700);
  });

  it("429・認証エラー・エラー本文は日本語の理由で例外にする", async () => {
    const p429 = createRakutenProvider({ ...base, fetchImpl: (async () => json({ error: "too_many_requests" }, 429)) as unknown as typeof fetch });
    await expect(p429.search("x")).rejects.toMatchObject({ name: "DomesticProviderError", retryable: true, message: expect.stringContaining("上限") });
    resetRakutenThrottle();
    const p403 = createRakutenProvider({ ...base, fetchImpl: (async () => json({ errors: { errorCode: 403, errorMessage: "Referer not allowed" } }, 403)) as unknown as typeof fetch });
    await expect(p403.search("x")).rejects.toThrow(/Referer.*Referer not allowed/);
    resetRakutenThrottle();
    const pBody = createRakutenProvider({ ...base, fetchImpl: (async () => json({ error: "wrong_parameter", error_description: "keyword is not valid" })) as unknown as typeof fetch });
    await expect(pBody.search("x")).rejects.toThrow(/keyword is not valid/);
    resetRakutenThrottle();
    const pNet = createRakutenProvider({ ...base, fetchImpl: (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    await expect(pNet.search("x")).rejects.toMatchObject({ retryable: true });
    expect(rakutenErrorNote(500, null)).toContain("一時的");
  });

  it("未設定 (applicationId / accessKey / Referer の欠落) なら通信しない", async () => {
    const fetchImpl = vi.fn();
    const p = createRakutenProvider({ applicationId: "a", accessKey: "", referer: "", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.isConfigured()).toBe(false);
    expect(p.statusNote()).toMatch(/RAKUTEN_ACCESS_KEY.*RAKUTEN_REFERER/);
    await expect(p.search("x")).rejects.toThrow(/未設定/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("上書きエンドポイントは https の rakuten.co.jp のみ (キーを他所へ送らない)", async () => {
    expect(isAllowedRakutenEndpoint("https://openapi.rakuten.co.jp/x")).toBe(true);
    expect(isAllowedRakutenEndpoint("https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601")).toBe(true);
    expect(isAllowedRakutenEndpoint("http://openapi.rakuten.co.jp/x")).toBe(false);
    expect(isAllowedRakutenEndpoint("https://rakuten.co.jp.evil.com/x")).toBe(false);
    expect(isAllowedRakutenEndpoint("https://user:pw@openapi.rakuten.co.jp/x")).toBe(false);
    const fetchImpl = vi.fn();
    const p = createRakutenProvider({ ...base, endpoint: "https://evil.example.com/api", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.isConfigured()).toBe(false);
    await expect(p.search("x")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("環境変数から設定を読む", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });
    it("RAKUTEN_REFERER 未設定なら APP_URL を Referer にする / 状態一覧にキーの値を含めない", () => {
      process.env.RAKUTEN_APPLICATION_ID = "env-app";
      process.env.RAKUTEN_ACCESS_KEY = "env-secret";
      delete process.env.RAKUTEN_REFERER;
      process.env.APP_URL = "https://sedori.onrender.com";
      const p = createRakutenProvider();
      expect(p.isConfigured()).toBe(true);
      const status = domesticProviderStatus();
      expect(status.map((s) => s.id)).toEqual(["rakuten", "amazon", "kakaku"]);
      expect(status[0].configured).toBe(true);
      expect(JSON.stringify(status)).not.toContain("env-secret");
      expect(status[1]).toMatchObject({ configured: false, note: expect.stringContaining("未対応") });
    });
  });
});

describe("Amazon (未対応のスタブ)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("設定済みにならず、通信もしない", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const p = createAmazonProvider();
    expect(p.isConfigured()).toBe(false);
    expect(p.statusNote()).toContain("Creators API");
    await expect(p.search("x")).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("国内価格の集計", () => {
  const s = (...prices: number[]) => prices.map((p, i) => ({ title: `item ${i}`, priceJpy: String(p), url: `https://item.rakuten.co.jp/x/${i}/` }));

  it("分位点 (線形補間)", () => {
    const v = [1, 2, 3, 4].map((x) => new D(x));
    expect(quantile(v, 0.5).toString()).toBe("2.5");
    expect(quantile(v, 0.25).toString()).toBe("1.75");
  });

  it("外れ値 (付属品・まとめ売り) を除き、下位 25% 点を採用する", () => {
    const r = aggregateDomesticPrices(s(1000, 1100, 1200, 1300, 1400, 200, 9800));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 200 (中央値の 30% 未満) と 9800 (300% 超) を除外
    expect(r.used).toBe(5);
    expect(r.dropped).toBe(2);
    expect(r.medianJpy).toBe("1200");
    expect(r.lowerQuartileJpy).toBe("1100");
    expect(r.priceJpy).toBe("1100");
    expect(r.samples[0].priceJpy).toBe("1100");
    expect(r.samples.length).toBeLessThanOrEqual(5);
  });

  it("IQR の外側も除外する", () => {
    const r = aggregateDomesticPrices(s(1000, 1000, 1010, 1020, 1030, 1040, 2900));
    expect(r.ok && r.used).toBe(6);
  });

  it("3 件未満なら採用しない", () => {
    expect(aggregateDomesticPrices(s(1000, 1200))).toMatchObject({ ok: false, reason: expect.stringContaining("2 件") });
    expect(aggregateDomesticPrices([])).toMatchObject({ ok: false });
    expect(aggregateDomesticPrices([...s(1000, 1100), { title: "x", priceJpy: "abc", url: "u" }, { title: "y", priceJpy: "0", url: "u" }])).toMatchObject({ ok: false });
  });

  it("ばらつきが大きく 3 件未満しか残らなければ採用しない", () => {
    const r = aggregateDomesticPrices(s(100, 1000, 10_000));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("ばらつき") });
  });
});
