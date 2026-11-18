import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CcxtFeed, marketToInstrument, precisionToStep, PRECISION, type CcxtLike } from "../src/market/feeds/ccxt";
import { OandaFeed, toOandaSymbol, fromOandaSymbol } from "../src/market/feeds/oanda";
import { AlpacaFeed } from "../src/market/feeds/alpaca";
import { DexScreenerFeed, SnapshotCandleBuilder } from "../src/market/feeds/dexscreener";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/market/${n}.json`, import.meta.url), "utf8"));
const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

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
    expect(list[1].assetClass).toBe("meme");
    expect(list[2]).toMatchObject({ allowShort: true, contractSize: 0.01 });
  });
  it("DECIMAL_PLACES モード (桁数) を刻みへ", () => {
    expect(precisionToStep(2, PRECISION.DECIMAL_PLACES)).toBeCloseTo(0.01);
    expect(precisionToStep(0, PRECISION.DECIMAL_PLACES)).toBe(1);
    expect(precisionToStep(8, PRECISION.DECIMAL_PLACES)).toBeCloseTo(1e-8);
    expect(precisionToStep(0.5, PRECISION.TICK_SIZE)).toBe(0.5);
    const inst = marketToInstrument({ symbol: "DOGE/JPY", base: "DOGE", quote: "JPY", spot: true, precision: { amount: 0, price: 3 }, limits: {} }, PRECISION.DECIMAL_PLACES, "v", new Set(["DOGE"]), { taker: 0.002, maker: 0.001 })!;
    expect(inst).toMatchObject({ tickSize: 0.001, lotSize: 1, assetClass: "meme", takerFeeRate: 0.002 });
  });
  it("追加ミーム設定", async () => {
    const feed = new CcxtFeed(mockExchange(PRECISION.TICK_SIZE), { extraMemeBases: ["btc"] });
    expect((await feed.listInstruments())[0].assetClass).toBe("meme");
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

describe("oanda feed", () => {
  const mk = (route: Record<string, unknown>) => {
    const calls: { url: string; headers: any }[] = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      const key = Object.keys(route).find((k) => String(url).includes(k))!;
      return jsonRes(route[key]);
    }) as unknown as typeof fetch;
    return { feed: new OandaFeed({ token: "tok", accountId: "101-1", fetchImpl }), calls };
  };
  it("シンボル変換", () => {
    expect(toOandaSymbol("USD/JPY")).toBe("USD_JPY");
    expect(fromOandaSymbol("USD_JPY")).toBe("USD/JPY");
  });
  it("銘柄・足・価格", async () => {
    const { feed, calls } = mk({ "/candles": fx("oanda").candles, "/pricing": fx("oanda").pricing, "/instruments": fx("oanda").instruments });
    const list = await feed.listInstruments();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ symbol: "USD/JPY", assetClass: "fx", tickSize: 0.001, lotSize: 1, allowShort: true });
    const candles = await feed.fetchCandles("USD/JPY", "1m", 10);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ ts: Date.parse("2025-01-01T00:00:00Z"), close: 150.01 });
    const q = await feed.fetchQuote("USD/JPY");
    expect(q).toMatchObject({ bid: 150.01, ask: 150.02, ts: Date.parse("2025-01-01T00:01:05.123Z") });
    expect(calls[0].url).toContain("https://api-fxpractice.oanda.com/v3/accounts/101-1/instruments");
    expect(calls[1].url).toContain("/v3/instruments/USD_JPY/candles?granularity=M1&price=MBA&count=10");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    await expect(feed.fetchCandles("USD/JPY", "1s", 1)).rejects.toThrow();
  });
});

describe("alpaca feed", () => {
  it("足は新しい順取得を昇順へ反転し、quote を変換する", async () => {
    const urls: string[] = [];
    let headers: any;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      urls.push(String(url));
      headers = init.headers;
      return jsonRes(String(url).includes("/bars") ? fx("alpaca").bars : fx("alpaca").quote);
    }) as unknown as typeof fetch;
    const feed = new AlpacaFeed({ keyId: "K", secretKey: "S", symbols: ["AAPL"], fetchImpl, clock: { now: () => Date.parse("2025-01-03T00:00:00Z") } });
    const c = await feed.fetchCandles("AAPL", "1m", 2);
    expect(c.map((x) => x.close)).toEqual([190.2, 190.4]);
    expect(urls[0]).toContain("https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Min");
    expect(urls[0]).toContain("sort=desc");
    expect(headers["APCA-API-KEY-ID"]).toBe("K");
    expect(await feed.fetchQuote("AAPL")).toMatchObject({ bid: 190.4, ask: 190.45 });
    expect((await feed.listInstruments())[0]).toMatchObject({ assetClass: "stock", allowShort: true, venue: "alpaca" });
  });
});

describe("dexscreener feed", () => {
  it("ペア登録・quote・統計・足の組み立て", async () => {
    let now = Date.parse("2025-01-01T00:00:10Z");
    const fetchImpl = vi.fn(async () => jsonRes(fx("dex_pair"))) as unknown as typeof fetch;
    const feed = new DexScreenerFeed({ fetchImpl, clock: { now: () => now }, assumedSpreadBps: 20 });
    const inst = await feed.trackPair("solana", "PAIR123");
    expect(inst).toMatchObject({ symbol: "BONK/SOL", venue: "dex:solana", assetClass: "meme", allowShort: false });
    expect(inst.meta).toMatchObject({ pairAddress: "PAIR123", liquidityUsd: 850000, pairCreatedAt: 1735689600000 });
    const q = await feed.fetchQuote("BONK/SOL");
    expect(q.ask / q.bid - 1).toBeCloseTo(0.002, 4);
    now += 70_000;
    await feed.fetchQuote("BONK/SOL");
    const c = await feed.fetchCandles("BONK/SOL", "1m", 10);
    expect(c).toHaveLength(2);
    const stats = await feed.fetchPairStats("BONK/SOL");
    expect(stats).toMatchObject({ liquidityUsd: 850000, txns24h: 3800, txns1h: 200, buys1h: 120, volume24hUsd: 1500000 });
    expect(stats.ageHours).toBeGreaterThan(0);
    await expect(feed.fetchQuote("XXX/SOL")).rejects.toThrow(/未登録/);
  });
  it("search / tokens", async () => {
    const fetchImpl = vi.fn(async (url: any) => jsonRes(String(url).includes("/tokens/") ? fx("dex_pair").pairs : fx("dex_pair"))) as unknown as typeof fetch;
    const feed = new DexScreenerFeed({ fetchImpl });
    expect((await feed.search("bonk"))[0].liquidityUsd).toBe(850000);
    expect((await feed.fetchTokenPairs("solana", ["TOK1"]))[0].symbol).toBe("BONK/SOL");
  });
  it("SnapshotCandleBuilder", () => {
    const b = new SnapshotCandleBuilder(["1m"]);
    b.push(0, 10); b.push(30_000, 12); b.push(50_000, 9); b.push(61_000, 11);
    expect(b.candles("1m", 10)).toEqual([
      { ts: 0, open: 10, high: 12, low: 9, close: 9, volume: 0 },
      { ts: 60_000, open: 11, high: 11, low: 11, close: 11, volume: 0 },
    ]);
  });
});
