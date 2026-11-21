import { describe, expect, it } from "vitest";
import { tagAssets } from "../src/intel/assetTagger";
import { applyFallbackSentiment, estimateSentiment } from "../src/intel/sentiment";

describe("assetTagger", () => {
  it("暗号資産・ミームを正規化", () => {
    expect(tagAssets("Bitcoin and Ether climb")).toEqual(expect.arrayContaining(["BTC", "ETH", "CRYPTO"]));
    expect(tagAssets("ビットコインが上昇")).toContain("BTC");
    const meme = tagAssets("Dogecoin and PEPE rally, BONK too");
    expect(meme).toEqual(expect.arrayContaining(["DOGE", "PEPE", "BONK", "MEME", "CRYPTO"]));
    expect(tagAssets("Solana ecosystem")).toContain("SOL");
    expect(tagAssets("hold SOL")).toContain("SOL");
  });
  it("単語境界: 部分文字列では反応しない", () => {
    expect(tagAssets("Ethiopia and the ethical debate")).not.toContain("ETH");
    expect(tagAssets("Fedex earnings")).not.toContain("USD");
    expect(tagAssets("the solution is simple")).not.toContain("SOL");
  });
  it("マクロ・通貨", () => {
    expect(tagAssets("FOMC and CPI data")).toEqual(["USD"]); // FX の擬似資産は付けない (FX は廃止)
    expect(tagAssets("日銀が円買い介入")).toEqual(["JPY"]);
    expect(tagAssets("Wall Street rallies, S&P 500 record")).toEqual(["STOCKS"]); // 株式市場全体 (リスクオンの材料)
    expect(tagAssets("ECB holds rates")).toContain("EUR");
    const aud = tagAssets("Australian dollar firms");
    expect(aud).toContain("AUD");
    expect(aud).not.toContain("USD");
  });
  it("追加辞書", () => {
    expect(tagAssets("Toyota news", { extra: { toyota: ["7203"] } })).toContain("7203");
    expect(tagAssets("dogwifhat pumps", { extra: { dogwifhat: ["WIF"] } })).toContain("WIF");
  });
});

describe("sentiment", () => {
  it("英語・日本語の方向", () => {
    expect(estimateSentiment("Bitcoin surges to record high").sentiment).toBeGreaterThan(0.5);
    expect(estimateSentiment("Exchange hacked, funds drained").sentiment).toBeLessThan(-0.5);
    expect(estimateSentiment("SEC sues exchange").sentiment).toBeLessThan(-0.5);
    expect(estimateSentiment("ビットコイン最高値を更新").sentiment).toBeGreaterThan(0.4);
    expect(estimateSentiment("急落で破綻懸念").sentiment).toBeLessThan(-0.7);
    expect(estimateSentiment("Quarterly update").sentiment).toBe(0);
  });
  it("否定語で反転・減衰", () => {
    const pos = estimateSentiment("Regulator bans token").sentiment;
    const neg = estimateSentiment("Regulator does not ban token").sentiment;
    expect(pos).toBeLessThan(0);
    expect(neg).toBeGreaterThan(pos);
    expect(estimateSentiment("価格は急落しない見通し").sentiment).toBeGreaterThan(0);
  });
  it("重要度: 重大語で上がる / 範囲内", () => {
    const hi = estimateSentiment("SEC sues Binance after hack").importance;
    const lo = estimateSentiment("Weekly column").importance;
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
  it("fallback は既存値を保持し calendar/metric には付けない", () => {
    const base = { source: "s", publishedAt: 0, fetchedAt: 0, assets: [] as string[] };
    const [a, b, c] = applyFallbackSentiment([
      { ...base, id: "1", kind: "news", title: "BTC surges", sentiment: -0.2 },
      { ...base, id: "2", kind: "news", title: "BTC surges" },
      { ...base, id: "3", kind: "calendar", title: "NFP" },
    ]);
    expect(a.sentiment).toBe(-0.2);
    expect(a.importance).toBeDefined();
    expect(b.sentiment!).toBeGreaterThan(0);
    expect(c.sentiment).toBeUndefined();
  });
});
