import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Candle } from "../src/core/types";
import { createParamValidator, createPriceAt, pickValidationData } from "../src/engine/learningHooks";
import { brokerVenues, buildRuntime, hubTimeframesFor, parseVenues, parseWatchlist } from "../src/engine/setup";
import { ClosedCandleCacheFeed } from "../src/engine/feedCache";
import { CcxtFeed, PRECISION, type CcxtLike } from "../src/market/feeds/ccxt";
import { PaperBroker } from "../src/execution/paper";
import { MarketHub } from "../src/market/hub";
import { MemoryStore } from "../src/storage/memory";
import { ALL_STRATEGIES, getStrategy } from "../src/strategies/registry";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";

const START = Date.UTC(2026, 0, 5);
const mkClock = (t = START) => ({ t, now() { return this.t; } });
const cfg = (env: Record<string, string>) => loadConfig({ NODE_ENV: "test", DB_PATH: "memory", ...env });

describe("設定の解析", () => {
  it("WATCHLIST", () => {
    expect(parseWatchlist("ccxt|BTC/JPY|crypto, oanda|USD/JPY|fx ,alpaca|AAPL,dex|solana:PAIR|meme")).toEqual([
      { venue: "ccxt", symbol: "BTC/JPY", assetClass: "crypto" },
      { venue: "oanda", symbol: "USD/JPY", assetClass: "fx" },
      { venue: "alpaca", symbol: "AAPL" },
      { venue: "dex", symbol: "solana:PAIR", assetClass: "meme" },
    ]);
    expect(parseWatchlist("")).toEqual([]);
    expect(() => parseWatchlist("ccxt")).toThrow(/形式/);
    expect(() => parseWatchlist("ccxt|BTC/JPY|bond")).toThrow(/資産クラス/);
  });

  it("VENUES と broker 用の表記", () => {
    expect(parseVenues("synthetic, CCXT ,ccxt:binance,dex")).toEqual(["synthetic", "ccxt", "ccxt:binance", "dex"]);
    expect(() => parseVenues("nasdaq")).toThrow(/未知/);
    expect(brokerVenues(["ccxt", "oanda", "ccxt:binance"], "bitflyer")).toBe("ccxt:bitflyer,oanda,ccxt:binance");
  });

  it("hub の時間足 = 資産クラスに合う戦略の時間足の和集合 + 1m", () => {
    expect(hubTimeframesFor([{ assetClass: "meme" }], ALL_STRATEGIES)).toEqual(["1m", "5m"]);
    expect(hubTimeframesFor([{ assetClass: "fx" }], ALL_STRATEGIES)).toEqual(["1m", "15m", "1h", "4h", "1d"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }, { assetClass: "meme" }], ALL_STRATEGIES)).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
  });
});

describe("buildRuntime", () => {
  it("synthetic: WATCHLIST で銘柄を絞り、資産クラスを上書きできる", async () => {
    const rt = await buildRuntime(cfg({ VENUES: "synthetic", WATCHLIST: "synthetic|BTC/USDT|crypto,synthetic|PEPE/USDT|meme,synthetic|NOPE|crypto" }), {
      clock: mkClock(), store: new MemoryStore(), intelSources: [], ai: null, syntheticHistoryMs: 86_400_000,
    });
    expect(rt.instruments.map((i) => i.symbol)).toEqual(["BTC/USDT", "PEPE/USDT"]);
    expect(rt.feeds).toHaveLength(1);
    expect(rt.feeds[0]).toBeInstanceOf(ClosedCandleCacheFeed);
    expect(rt.timeframes).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
    expect(rt.brokerSet.paper).toBeInstanceOf(PaperBroker);
    expect(rt.ai).toBeUndefined();
  });

  it("ccxt: 注入した exchange (モック) から WATCHLIST の銘柄を作る。venue は ccxt:<id>", async () => {
    const markets = JSON.parse(readFileSync(new URL("./fixtures/market/ccxt_markets.json", import.meta.url), "utf8"));
    const ex: CcxtLike = {
      id: "mockex", precisionMode: PRECISION.TICK_SIZE,
      loadMarkets: vi.fn(async () => markets), fetchOHLCV: vi.fn(async () => []), fetchTicker: vi.fn(), fetchOrderBook: vi.fn(), fetchTrades: vi.fn(async () => []),
    };
    const create = vi.fn(() => new CcxtFeed(ex, { venue: "ccxt:mockex" }));
    const rt = await buildRuntime(cfg({ VENUES: "ccxt", CCXT_EXCHANGE: "mockex", WATCHLIST: "ccxt|BTC/USDT|crypto,ccxt|PEPE/USDT|meme" }), {
      clock: mkClock(), store: new MemoryStore(), intelSources: [], ai: null, createCcxtFeed: create,
    });
    expect(create).toHaveBeenCalledWith("mockex");
    expect(rt.instruments.map((i) => [i.symbol, i.venue, i.assetClass])).toEqual([
      ["BTC/USDT", "ccxt:mockex", "crypto"],
      ["PEPE/USDT", "ccxt:mockex", "meme"],
    ]);
    // paper では実口座アダプターを作らない
    expect(rt.brokerSet.mode).toBe("paper");
    expect([...rt.brokerSet.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
    expect(ex.fetchTicker).not.toHaveBeenCalled();
  });

  it("oanda / alpaca はキーが必要。監視銘柄が無ければエラー", async () => {
    await expect(buildRuntime(cfg({ VENUES: "oanda" }), { store: new MemoryStore(), intelSources: [] })).rejects.toThrow(/OANDA_API_TOKEN/);
    await expect(buildRuntime(cfg({ VENUES: "alpaca" }), { store: new MemoryStore(), intelSources: [] })).rejects.toThrow(/ALPACA_KEY_ID/);
    await expect(buildRuntime(cfg({ VENUES: "dex" }), { store: new MemoryStore(), intelSources: [] })).rejects.toThrow(/監視銘柄がありません/);
  });
});

describe("学習フック", () => {
  /** 1m 足だけを返す簡易 feed の hub (足は事前に用意) */
  async function hubWith(candles: Candle[], now: number) {
    const inst = syntheticInstrument({ symbol: "SYN/USDT" });
    const feed = {
      venue: "paper",
      listInstruments: async () => [inst],
      fetchCandles: async (_s: string, tf: string) => (tf === "1m" ? candles : []),
      fetchQuote: async () => ({ ts: now, bid: 99.99, ask: 100.01 }),
    };
    const clock = mkClock(now);
    const hub = new MarketHub({ feeds: [feed], clock, timeframes: ["1m", "15m"], historyLimit: 3000, withBook: false });
    hub.watch(inst);
    await hub.poll();
    return { hub, clock };
  }

  it("validate: 履歴で evaluateParams を実行。板必須・データ不足は undefined", async () => {
    const candles = generateCandles({ seed: 4, bars: 1500, timeframe: "1m", startTs: START, vol: 0.0006 });
    const now = candles[candles.length - 1].ts + 60_000;
    const { hub, clock } = await hubWith(candles, now);
    const validate = createParamValidator({ hub, strategies: ALL_STRATEGIES, clock, minEdgeToCostRatio: 0 });
    const s = getStrategy("scalp_momentum_burst")!;
    expect(pickValidationData(s, "crypto", hub, now)?.baseTimeframe).toBe("1m");
    const r = await validate("scalp_momentum_burst", "crypto", s.defaultParams);
    expect(r).toBeDefined();
    expect(Number.isFinite(r!.score)).toBe(true);
    expect(r!.trades).toBeGreaterThanOrEqual(0);
    expect(await validate("scalp_obi", "crypto", getStrategy("scalp_obi")!.defaultParams)).toBeUndefined();
    expect(await validate("scalp_momentum_burst", "fx", s.defaultParams)).toBeUndefined();
    expect(await validate("long_momentum", "crypto", getStrategy("long_momentum")!.defaultParams)).toBeUndefined();
    expect(await validate("unknown", "crypto", {})).toBeUndefined();
  });

  it("priceAt: ts を含む 1m 足の終値。範囲外は undefined", async () => {
    const candles = generateCandles({ seed: 4, bars: 100, timeframe: "1m", startTs: START, vol: 0.0006 });
    const now = candles[candles.length - 1].ts + 60_000;
    const { hub, clock } = await hubWith(candles, now);
    const priceAt = createPriceAt(hub, clock);
    expect(priceAt("SYN/USDT", candles[10].ts + 30_000)).toBe(candles[10].close);
    expect(priceAt("SYN/USDT", candles[0].ts - 1)).toBeUndefined();
    expect(priceAt("SYN/USDT", now + 60_000)).toBeUndefined();
    expect(priceAt("NOPE", candles[10].ts)).toBeUndefined();
  });
});
