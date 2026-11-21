import { describe, expect, it } from "vitest";
import { JupiterClient } from "../src/market/jupiter/client";
import { JupiterShapeError } from "../src/market/jupiter/parse";
import { fetchRecentTokens, fetchTokenCategory, fetchTokensByTag, normalizeToken, parseTokenList, searchTokens } from "../src/market/jupiter/tokens";
import { createMockFetch, fakeClock, loadFixture } from "./fixtures/jupiter/mockFetch";

const A = "MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111";
const B = "MemeBBBBccccDDDDeeeeFFFFggggHHHHjjjj2222";
const C = "MemeCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333";
const D4 = "MemeDDDDeeeeFFFFggggHHHHjjjjKKKKmmmm4444";

describe("parseTokenList (フィクスチャ)", () => {
  const r = parseTokenList(loadFixture("tokens_toptrending.json"));

  it("読めない要素は位置と理由つきで報告し、重複の mint は除く", () => {
    expect(r.tokens.map((t) => t.mint)).toEqual([A, B, C, D4]);
    expect(r.invalid.map((i) => i.index)).toEqual([4, 5, 6]);
    expect(r.invalid[0].reason).toContain("id");
    expect(r.invalid[1].reason).toContain("Solana のアドレスではありません");
    expect(r.invalid[2].reason).toContain("オブジェクトではありません");
  });

  it("完全な要素を正規化する (タグの文字列以外は捨てる・時刻はミリ秒・統計は数値だけ)", () => {
    const t = r.tokens[0];
    expect(t).toMatchObject({
      mint: A, name: "Synthetic Dog", symbol: "SDOG", decimals: 5, usdPrice: 0.0000234, liquidity: 812345.67, holderCount: 15432,
      organicScore: 78.5, organicScoreLabel: "high", isVerified: true, tags: ["verified", "community"],
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18.2, devMints: 1 },
      firstPool: { id: "PooLAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111", createdAt: Date.parse("2025-01-01T00:00:00Z") },
      updatedAt: Date.parse("2025-06-01T12:00:00Z"),
    });
    expect(t.audit.isSus).toBeUndefined();
    expect(t.stats["1h"]).toEqual({ priceChange: 2.1, volumeChange: 12.3, buyVolume: 15000, sellVolume: 14000.5, numBuys: 300, numSells: 280, numTraders: 410 });
    expect(t.stats["6h"]).toBeUndefined();
  });

  it("文字列の数値・文字列の真偽値・秒の時刻・大文字のラベルを読む。null は不明", () => {
    const t = r.tokens[1];
    expect(t).toMatchObject({
      decimals: 6, usdPrice: 1.5, liquidity: 300000, holderCount: 2500, organicScore: 65, organicScoreLabel: "medium", isVerified: false, tags: [],
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30.5 },
      firstPool: { createdAt: 1735689600000 },
    });
    expect(t.audit.isSus).toBeUndefined();
    expect(t.stats["1h"]).toBeUndefined();
  });

  it("null・NaN・数値でない文字列は undefined (例外にしない)", () => {
    const t = r.tokens[2];
    expect(t.liquidity).toBeUndefined();
    expect(t.holderCount).toBeUndefined();
    expect(t.organicScore).toBeUndefined();
    expect(t.audit).toEqual({});
    expect(t.firstPool).toBeUndefined();
    expect(t.tags).toEqual([]);
  });

  it("isSus は true のときだけ", () => {
    expect(r.tokens[3].audit.isSus).toBe(true);
  });

  it("範囲外の値は不明 (organicScore > 100・負の流動性・小数の decimals)", () => {
    const t = normalizeToken({ id: A, organicScore: 150, liquidity: -1, decimals: 2.5, usdPrice: 0 });
    expect(typeof t).toBe("object");
    if (typeof t === "string") return;
    expect(t.organicScore).toBeUndefined();
    expect(t.liquidity).toBeUndefined();
    expect(t.decimals).toBeUndefined();
    expect(t.usdPrice).toBeUndefined();
  });

  it("mint / address の別名、{ tokens } / { data } の包みも読む", () => {
    expect(parseTokenList({ tokens: [{ mint: A }] }).tokens[0].mint).toBe(A);
    expect(parseTokenList({ data: [{ address: B }] }).tokens[0].mint).toBe(B);
  });

  it("配列でない応答は JupiterShapeError", () => {
    expect(() => parseTokenList({ foo: 1 })).toThrow(JupiterShapeError);
    expect(() => parseTokenList("x")).toThrow(JupiterShapeError);
  });
});

describe("Tokens V2 の取得 (パスとクエリ)", () => {
  const setup = () => {
    const clk = fakeClock(0);
    const m = createMockFetch(() => ({ body: loadFixture("tokens_search.json") }), clk.now);
    return { ...m, client: new JupiterClient({ fetchImpl: m.fetchImpl, now: clk.now, sleep: clk.sleep }) };
  };

  it("search は 100 件ずつカンマ区切り、結果は mint で重複を除く", async () => {
    const { client, calls } = setup();
    const qs = Array.from({ length: 150 }, (_, i) => `q${i}`);
    const r = await searchTokens(client, qs);
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe("/tokens/v2/search");
    expect(calls[0].query.get("query")?.split(",")).toHaveLength(100);
    expect(calls[1].query.get("query")?.split(",")).toHaveLength(50);
    expect(r.tokens.map((t) => t.symbol)).toEqual(["SOL", "USDC"]);
  });

  it("tag / カテゴリー / recent", async () => {
    const { client, calls } = setup();
    await fetchTokensByTag(client, "verified");
    await fetchTokenCategory(client, "toptrending", "1h", 500);
    await fetchTokenCategory(client, "toporganicscore", "24h");
    await fetchRecentTokens(client);
    expect(calls.map((c) => `${c.path}${c.query.size ? `?${c.query.toString()}` : ""}`)).toEqual([
      "/tokens/v2/tag?query=verified",
      "/tokens/v2/toptrending/1h?limit=100",
      "/tokens/v2/toporganicscore/24h?limit=50",
      "/tokens/v2/recent",
    ]);
  });

  it("未知のカテゴリー・期間・タグは送信前に例外", async () => {
    const { client, calls } = setup();
    await expect(fetchTokenCategory(client, "hot" as never, "1h")).rejects.toThrow();
    await expect(fetchTokenCategory(client, "toptraded", "2h" as never)).rejects.toThrow();
    await expect(fetchTokensByTag(client, "meme" as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
