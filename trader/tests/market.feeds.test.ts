import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CcxtFeed, marketToInstrument, precisionToStep, PRECISION, type CcxtLike } from "../src/market/feeds/ccxt";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/market/${n}.json`, import.meta.url), "utf8"));

function mockExchange(mode: number): CcxtLike {
  return {
    id: "mock",
    precisionMode: mode,
    loadMarkets: vi.fn(async () => fx("ccxt_markets")),
    fetchOHLCV: vi.fn(async () => [[2000, 2, 3, 1, 2.5, 10], [1000, 1, 2, 0.5, 1.5, 5]]),
    fetchTicker: vi.fn(async () => ({ timestamp: 5, bid: 99, ask: 101, last: 100, bidVolume: 1, askVolume: 2 })),
    fetchOrderBook: vi.fn(async () => ({ timestamp: 6, bids: [[99, 1]], asks: [[101, 2]] })),
    fetchTrades: vi.fn(async () => [{ timestamp: 9, price: 100, amount: 1, side: "sell" }, { timestamp: 8, price: 100, amount: 2, side: "buy" }]),
  };
}

describe("ccxt feed", () => {
  it("TICK_SIZE モードで Instrument へ変換", async () => {
    const feed = new CcxtFeed(mockExchange(PRECISION.TICK_SIZE));
    const list = await feed.listInstruments();
    expect(list.map((i) => i.symbol)).toEqual(["BTC/USDT", "PEPE/USDT", "ETH/USDT:USDT"]);
    const btc = list[0];
    expect(btc).toMatchObject({ venue: "ccxt:mock", assetClass: "crypto", tickSize: 0.01, lotSize: 0.00001, minQty: 0.0001, minNotional: 5, takerFeeRate: 0.001, makerFeeRate: 0.0008, allowShort: false });
    // DOGE・SHIB・PEPE なども自動では meme に分けない (crypto の戦略で扱う。meme は WATCHLIST で明示する)
    expect(list[1].assetClass).toBe("crypto");
    expect(list[2]).toMatchObject({ allowShort: true, contractSize: 0.01 });
  });
  it("DECIMAL_PLACES モード (桁数) を刻みへ", () => {
    expect(precisionToStep(2, PRECISION.DECIMAL_PLACES)).toBeCloseTo(0.01);
    expect(precisionToStep(0, PRECISION.DECIMAL_PLACES)).toBe(1);
    expect(precisionToStep(8, PRECISION.DECIMAL_PLACES)).toBeCloseTo(1e-8);
    expect(precisionToStep(0.5, PRECISION.TICK_SIZE)).toBe(0.5);
    const inst = marketToInstrument({ symbol: "DOGE/JPY", base: "DOGE", quote: "JPY", spot: true, precision: { amount: 0, price: 3 }, limits: {} }, PRECISION.DECIMAL_PLACES, "v", { taker: 0.002, maker: 0.001 })!;
    expect(inst).toMatchObject({ tickSize: 0.001, lotSize: 1, assetClass: "crypto", takerFeeRate: 0.002 });
  });
  it("足・quote・板・約定の変換", async () => {
    const feed = new CcxtFeed(mockExchange(PRECISION.TICK_SIZE));
    const c = await feed.fetchCandles("BTC/USDT", "1m", 2);
    expect(c.map((x) => x.ts)).toEqual([1000, 2000]);
    expect(c[1]).toEqual({ ts: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 10 });
    expect(await feed.fetchQuote("BTC/USDT")).toMatchObject({ bid: 99, ask: 101, last: 100, bidSize: 1 });
    expect((await feed.fetchOrderBook("BTC/USDT")).asks[0]).toEqual([101, 2]);
    const prints = await feed.fetchPrints("BTC/USDT");
    expect(prints.map((p) => p.ts)).toEqual([8, 9]);
    expect(prints[1].side).toBe("sell");
    await expect(feed.fetchCandles("BTC/USDT", "1s", 1)).resolves.toBeDefined(); // ccxt 側に委ねる
  });
});
