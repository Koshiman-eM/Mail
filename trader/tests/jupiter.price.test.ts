import { describe, expect, it } from "vitest";
import { JupiterClient } from "../src/market/jupiter/client";
import { JupiterShapeError } from "../src/market/jupiter/parse";
import { fetchPrices, parsePriceResponse } from "../src/market/jupiter/price";
import { createMockFetch, fakeClock, loadFixture } from "./fixtures/jupiter/mockFetch";

const A = "MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111";
const B = "MemeBBBBccccDDDDeeeeFFFFggggHHHHjjjj2222";
const C = "MemeCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333";
const D4 = "MemeDDDDeeeeFFFFggggHHHHjjjjKKKKmmmm4444";
const E = "MemeEEEEffffGGGGhhhhJJJJkkkkMMMMnnnn5555";
const SOL = "So11111111111111111111111111111111111111112";

describe("parsePriceResponse (フィクスチャ)", () => {
  const raw = loadFixture("price_v3.json");

  it("正しい要素は価格に、無い要素は missing、不正な要素は理由つきで invalid (例外にしない)", () => {
    const r = parsePriceResponse(raw, [A, B, C, D4, E, SOL], 123);
    expect(r.prices.get(A)).toEqual({ usd: 0.0000234, ts: 123, blockId: 348004023, decimals: 5, priceChange24h: -3.25 });
    expect(r.prices.get(B)).toEqual({ usd: 1.5, ts: 123, decimals: 6 }); // 文字列の数値も読む
    expect(r.prices.get(SOL)?.usd).toBe(150.25);
    expect(r.missing).toEqual([E]);
    expect(r.invalid.map((i) => i.mint)).toEqual([C, D4]);
    expect(r.invalid[0].reason).toContain("数値ではありません");
    expect(r.invalid[1].reason).toContain("正の数ではありません");
  });

  it("旧形式 { data: {...} } と price も読む", () => {
    const r = parsePriceResponse({ data: { [A]: { id: A, price: "0.5" } } }, [A], 1);
    expect(r.prices.get(A)?.usd).toBe(0.5);
  });

  it("オブジェクトでない応答は JupiterShapeError", () => {
    expect(() => parsePriceResponse([1, 2], [A], 1)).toThrow(JupiterShapeError);
    expect(() => parsePriceResponse(null, [A], 1)).toThrow(JupiterShapeError);
  });
});

describe("fetchPrices", () => {
  const mints = Array.from({ length: 120 }, (_, i) => `mint-${i}`);

  it("50 件ずつに分けて呼び、重複・空文字を除く", async () => {
    const clk = fakeClock(1000);
    const { fetchImpl, calls } = createMockFetch((c) => {
      const ids = (c.query.get("ids") ?? "").split(",");
      return { body: Object.fromEntries(ids.map((id) => [id, { usdPrice: 1 }])) };
    }, clk.now);
    const client = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    const r = await fetchPrices(client, [...mints, mints[0], " ", ""], { now: clk.now });
    expect(calls.map((c) => (c.query.get("ids") ?? "").split(",").length)).toEqual([50, 50, 20]);
    expect(calls.every((c) => c.path === "/price/v3")).toBe(true);
    expect(r.prices.size).toBe(120);
    expect(r.failedChunks).toEqual([]);
    // ts は取得した時刻 (レート制限で 2 秒ずつ進む)
    expect(r.prices.get(mints[0])?.ts).toBe(1000);
    expect(r.prices.get(mints[119])?.ts).toBe(5000);
  });

  it("一部の分割が失敗しても他は返し、失敗は報告する (伏せ字)", async () => {
    const clk = fakeClock(0);
    const { fetchImpl } = createMockFetch((_c, i) => (i === 0 ? { status: 400, text: "bad request" } : { body: {} }), clk.now);
    const client = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    const r = await fetchPrices(client, mints.slice(0, 60));
    expect(r.failedChunks).toHaveLength(1);
    expect(r.failedChunks[0].mints).toHaveLength(50);
    expect(r.failedChunks[0].error).toContain("HTTP 400");
    expect(r.missing).toHaveLength(10);
  });

  it("すべて失敗したら例外", async () => {
    const clk = fakeClock(0);
    const { fetchImpl } = createMockFetch(() => ({ status: 404, text: "nope" }), clk.now);
    const client = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    await expect(fetchPrices(client, [A, B])).rejects.toThrow(/HTTP 404/);
  });

  it("空の一覧は呼ばない", async () => {
    const { fetchImpl, calls } = createMockFetch(() => ({ body: {} }));
    const r = await fetchPrices(new JupiterClient({ fetchImpl }), []);
    expect(calls).toHaveLength(0);
    expect(r.prices.size).toBe(0);
  });
});
