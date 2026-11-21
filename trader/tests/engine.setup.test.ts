import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Candle } from "../src/core/types";
import { createParamValidator, createPriceAt } from "../src/engine/learningHooks";
import {
  assertLiveSupported, buildRuntime, effectiveVenues, hubTimeframesFor, parseVenues, parseWatchlist, resolveDbPath, syntheticDbPath,
} from "../src/engine/setup";
import { LIVE_UNSUPPORTED_MESSAGE } from "../src/execution/router";
import { assertSimulationDb } from "../src/engine/simulate";
import { DEFAULT_REVERSAL_SETTINGS, type ReversalSettings } from "../src/engine/reversalExit";
import { ClosedCandleCacheFeed } from "../src/engine/feedCache";
import { CcxtFeed, PRECISION, type CcxtLike } from "../src/market/feeds/ccxt";
import { PaperBroker } from "../src/execution/paper";
import { MarketHub } from "../src/market/hub";
import { MemoryStore } from "../src/storage/memory";
import { ALL_STRATEGIES, getStrategy } from "../src/strategies/registry";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";

/** 転換で決済を無効にした設定 (従来どおり) */
const REVERSAL_DISABLED: Readonly<ReversalSettings> = { ...DEFAULT_REVERSAL_SETTINGS, enabled: false };

const START = Date.UTC(2026, 0, 5);
const mkClock = (t = START) => ({ t, now() { return this.t; } });
const cfg = (env: Record<string, string>) => loadConfig({ NODE_ENV: "test", DB_PATH: "memory", ...env });

describe("設定の解析", () => {
  it("WATCHLIST: 廃止した資産クラス (fx / stock) の銘柄は警告して除く (起動は止めない)。それ以外の未知のクラスはエラー", () => {
    const warn = vi.fn();
    expect(parseWatchlist("ccxt|BTC/JPY|crypto, oanda|USD/JPY|fx ,alpaca|AAPL,alpaca|MSFT|stock,dex|solana:PAIR|meme", warn)).toEqual([
      { venue: "ccxt", symbol: "BTC/JPY", assetClass: "crypto" },
      { venue: "alpaca", symbol: "AAPL" },
      { venue: "dex", symbol: "solana:PAIR", assetClass: "meme" },
    ]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^WATCHLIST の "oanda\|USD\/JPY\|fx" は廃止した資産クラス \(fx\) のため無視します/),
      expect.stringMatching(/^WATCHLIST の "alpaca\|MSFT\|stock" は廃止した資産クラス \(stock\) のため無視します/),
    ]);
    expect(parseWatchlist("ccxt|USD/JPY|FX")).toEqual([]); // 大文字小文字は問わない
    expect(parseWatchlist("")).toEqual([]);
    expect(() => parseWatchlist("ccxt")).toThrow(/形式/);
    expect(() => parseWatchlist("ccxt|BTC/JPY|bond")).toThrow(/資産クラス/);
  });

  it("VENUES: 廃止した取引先 (gmo / oanda / alpaca / dex) は警告して除く (起動は止めない)。それ以外の未知の値はエラー", () => {
    expect(parseVenues("synthetic, CCXT ,ccxt:binance")).toEqual(["synthetic", "ccxt", "ccxt:binance"]);
    const warn = vi.fn();
    expect(parseVenues("gmo,oanda,alpaca,dex,ccxt", warn)).toEqual(["ccxt"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^VENUES の gmo, oanda, alpaca, dex は廃止した取引先のため無視します/);
    expect(parseVenues("oanda")).toEqual([]);
    expect(parseVenues("gmo")).toEqual([]);
    expect(() => parseVenues("nasdaq")).toThrow(/未知/);
  });

  it("VENUES が廃止した取引先だけなら ccxt (CCXT_EXCHANGE) の相場で動かす。空・使える取引先があればそのまま", () => {
    const warn = vi.fn();
    expect(effectiveVenues("gmo", warn)).toEqual(["ccxt"]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^VENUES の gmo は廃止した取引先/),
      expect.stringMatching(/^VENUES に使える取引先が無いため ccxt \(CCXT_EXCHANGE\) の相場で動かします/),
    ]);
    expect(effectiveVenues("gmo,oanda")).toEqual(["ccxt"]);
    expect(effectiveVenues("gmo,synthetic")).toEqual(["synthetic"]);
    expect(effectiveVenues("ccxt:bitbank,gmo")).toEqual(["ccxt:bitbank"]);
    expect(effectiveVenues("")).toEqual([]);
  });

  it("live の発注先は無い: mode が live なら必ず拒否する (paper は通す)", () => {
    expect(() => assertLiveSupported("paper")).not.toThrow();
    expect(() => assertLiveSupported("live")).toThrow(LIVE_UNSUPPORTED_MESSAGE);
    expect(LIVE_UNSUPPORTED_MESSAGE).toBe("live の発注先は未対応です (Jupiter の実弾は次の段階で実装予定)");
  });

  it("hub の時間足 = 資産クラスに合う戦略の時間足の和集合 + 1m (中長期の戦略の廃止で 1d は取らない)", () => {
    // meme (Jupiter のミームコイン): scalp_momentum_burst・scalp_pullback (1m/15m)・pullback_5m (5m/1h)・pullback_15m (15m/4h)・short_ema_trend・short_rsi_revert (15m)
    expect(hubTimeframesFor([{ assetClass: "meme" }], ALL_STRATEGIES)).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }], ALL_STRATEGIES)).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }, { assetClass: "meme" }], ALL_STRATEGIES)).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    // 廃止したクラス (古い銘柄定義) に合う戦略は無い
    expect(hubTimeframesFor([{ assetClass: "fx" as never }], ALL_STRATEGIES)).toEqual(["1m"]);
  });

  it("転換で決済 (REVERSAL_EXIT_TF=lower) の判定用に、対象の戦略の主時間足の 1 つ下の時間足も取得する", () => {
    const only = (id: string) => ALL_STRATEGIES.filter((s) => s.id === id);
    const lower = { ...DEFAULT_REVERSAL_SETTINGS };
    // short_breakout (1h) → 15m、short_ema_trend (15m) → 5m
    expect(hubTimeframesFor([{ assetClass: "crypto" }], only("short_breakout"), lower)).toEqual(["1m", "15m", "1h"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }], only("short_ema_trend"), lower)).toEqual(["1m", "5m", "15m"]);
    // meme: scalp_momentum_burst (1m) → 1m のまま。押し目の 3 戦略・short の 2 戦略も meme に掛かる
    expect(hubTimeframesFor([{ assetClass: "meme" }], only("scalp_momentum_burst"), lower)).toEqual(["1m"]);
    expect(hubTimeframesFor([{ assetClass: "meme" }], ALL_STRATEGIES, lower)).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    // same・無効・対象外なら従来どおり
    expect(hubTimeframesFor([{ assetClass: "crypto" }], only("short_breakout"), { ...lower, timeframe: "same" })).toEqual(["1m", "1h"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }], only("short_breakout"), REVERSAL_DISABLED)).toEqual(["1m", "1h"]);
    expect(hubTimeframesFor([{ assetClass: "crypto" }], only("short_breakout"), { ...lower, strategies: ["other"] })).toEqual(["1m", "1h"]);
  });
});

describe("DB の分離", () => {
  it("VENUES が synthetic だけなら <DB_PATH のベース名>-synthetic.db を使う", () => {
    expect(syntheticDbPath("./data/trader.db")).toBe("data/trader-synthetic.db");
    expect(syntheticDbPath("/var/db/x.sqlite")).toBe("/var/db/x-synthetic.db");
    expect(syntheticDbPath("memory")).toBe("memory");
    expect(resolveDbPath(cfg({ VENUES: "synthetic", DB_PATH: "./data/trader.db" }))).toBe("data/trader-synthetic.db");
    expect(resolveDbPath(cfg({ VENUES: "synthetic,ccxt", DB_PATH: "./data/trader.db" }))).toBe("./data/trader.db");
    expect(resolveDbPath(cfg({ VENUES: "ccxt", DB_PATH: "./data/trader.db" }))).toBe("./data/trader.db");
  });

  it("simulate は DB_PATH (と合成データ用の DB) を使えない。memory と別ファイルは可", () => {
    const env = { DB_PATH: "./data/trader.db" };
    expect(() => assertSimulationDb("./data/trader.db", env)).toThrow(/DB_PATH/);
    expect(() => assertSimulationDb("data/../data/trader.db", env)).toThrow(/DB_PATH/);
    expect(() => assertSimulationDb("./data/trader-synthetic.db", env)).toThrow(/DB_PATH/);
    expect(() => assertSimulationDb("./data/trader.db", {})).toThrow(/DB_PATH/); // 既定値
    expect(() => assertSimulationDb("memory", env)).not.toThrow();
    expect(() => assertSimulationDb("./data/sim.db", env)).not.toThrow();
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
    expect(rt.timeframes).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    expect(rt.brokerSet.paper).toBeInstanceOf(PaperBroker);
    expect(rt.ai).toBeUndefined();
  });

  it("ccxt: 注入した exchange (モック) から WATCHLIST の銘柄を作る。venue は ccxt:<id>。meme は WATCHLIST で明示したときだけ", async () => {
    const markets = JSON.parse(readFileSync(new URL("./fixtures/market/ccxt_markets.json", import.meta.url), "utf8"));
    const ex: CcxtLike = {
      id: "mockex", precisionMode: PRECISION.TICK_SIZE,
      loadMarkets: vi.fn(async () => markets), fetchOHLCV: vi.fn(async () => []), fetchTicker: vi.fn(), fetchOrderBook: vi.fn(), fetchTrades: vi.fn(async () => []),
    };
    const create = vi.fn(() => new CcxtFeed(ex, { venue: "ccxt:mockex" }));
    const rt = await buildRuntime(cfg({ VENUES: "ccxt", CCXT_EXCHANGE: "mockex", WATCHLIST: "ccxt|BTC/USDT|crypto,ccxt|PEPE/USDT" }), {
      clock: mkClock(), store: new MemoryStore(), intelSources: [], ai: null, createCcxtFeed: create,
    });
    expect(create).toHaveBeenCalledWith("mockex");
    expect(rt.instruments.map((i) => [i.symbol, i.venue, i.assetClass])).toEqual([
      ["BTC/USDT", "ccxt:mockex", "crypto"],
      // PEPE などは自動では meme に分けない (crypto の戦略で取引する。meme にするなら WATCHLIST の 3 つ目で明示する)
      ["PEPE/USDT", "ccxt:mockex", "crypto"],
    ]);
    // paper では実口座アダプターを作らない
    expect(rt.brokerSet.mode).toBe("paper");
    expect([...rt.brokerSet.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
    expect(ex.fetchTicker).not.toHaveBeenCalled();
  });

  it("古い .env: 廃止した取引先 (VENUES・WATCHLIST)・戦略 id は警告して無視し、残りの設定で起動する", async () => {
    const warns: string[] = [];
    const logger = { debug() {}, info() {}, warn(m: string, d?: unknown) { warns.push(d ? `${m} ${JSON.stringify(d)}` : m); }, error() {} };
    const rt = await buildRuntime(
      cfg({
        VENUES: "synthetic,gmo,oanda,alpaca,dex",
        WATCHLIST: "synthetic|BTC/USDT|crypto,synthetic|USD/JPY|fx,synthetic|AAPL|stock,gmo|BTC/JPY,oanda|USD/JPY|fx,alpaca|AAPL,dex|solana:PAIR|meme",
        OANDA_API_TOKEN: "t", AUTO_MEME_WATCH: "true",
        GMO_API_KEY: "k", GMO_API_SECRET: "s", GMO_SYMBOLS: "BTC_JPY", GMO_LEVERAGE_FEE_DAILY: "bad", GMO_MAX_EFFECTIVE_LEVERAGE: "9",
        MAX_EXPOSURE_FX: "5", MAX_EXPOSURE_STOCK: "-1",
        OBSERVE_ONLY_STRATEGIES: "scalp_rebound,mid_trend_follow,long_momentum",
        STRUCTURE_STRATEGIES: "scalp_micro,mid_trend_follow,meme_momentum",
        REVERSAL_EXIT_STRATEGIES: "short_breakout,long_momentum",
      }),
      { clock: mkClock(), store: new MemoryStore(), intelSources: [], ai: null, syntheticHistoryMs: 86_400_000, logger },
    );
    expect(rt.venues).toEqual(["synthetic"]);
    expect(rt.instruments.map((i) => i.symbol)).toEqual(["BTC/USDT"]);
    expect(warns.some((w) => w.startsWith("VENUES の gmo, oanda, alpaca, dex は廃止した取引先のため無視します"))).toBe(true);
    expect(warns.filter((w) => w.startsWith("廃止した取引先の WATCHLIST の銘柄を無視します"))).toHaveLength(3); // gmo・alpaca・dex
    expect(warns.filter((w) => /^WATCHLIST の ".*" は廃止した資産クラス/.test(w))).toHaveLength(3); // fx 2 件・stock 1 件
    expect(warns).toContain("OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): mid_trend_follow, long_momentum");
    expect(warns).toContain("STRUCTURE_STRATEGIES に廃止した戦略 id があります (無視されます): mid_trend_follow, meme_momentum");
    expect(warns).toContain("REVERSAL_EXIT_STRATEGIES に廃止した戦略 id があります (再起動前に建てたその戦略の建玉にだけ効きます): long_momentum");
  });

  it("古い .env の VENUES=gmo だけ: ccxt (CCXT_EXCHANGE、既定 bitbank) の相場の paper で起動する (gmo の WATCHLIST は無視)", async () => {
    const markets = JSON.parse(readFileSync(new URL("./fixtures/market/ccxt_markets.json", import.meta.url), "utf8"));
    const ex: CcxtLike = {
      id: "bitbank", precisionMode: PRECISION.TICK_SIZE,
      loadMarkets: vi.fn(async () => markets), fetchOHLCV: vi.fn(async () => []), fetchTicker: vi.fn(), fetchOrderBook: vi.fn(), fetchTrades: vi.fn(async () => []),
    };
    const create = vi.fn(() => new CcxtFeed(ex, { venue: "ccxt:bitbank" }));
    const warns: string[] = [];
    const logger = { debug() {}, info() {}, warn(m: string) { warns.push(m); }, error() {} };
    const rt = await buildRuntime(cfg({ VENUES: "gmo", WATCHLIST: "gmo|BTC/JPY,gmo|ETH/JPY", GMO_API_KEY: "k" }), {
      clock: mkClock(), store: new MemoryStore(), intelSources: [], ai: null, createCcxtFeed: create, logger,
    });
    expect(create).toHaveBeenCalledWith("bitbank");
    expect(rt.venues).toEqual(["ccxt"]);
    expect(rt.instruments.length).toBeGreaterThan(0);
    expect(rt.instruments.every((i) => i.venue === "ccxt:bitbank" && i.assetClass === "crypto")).toBe(true);
    expect(rt.brokerSet.mode).toBe("paper");
    expect(warns.some((w) => w.startsWith("VENUES に使える取引先が無いため ccxt (CCXT_EXCHANGE) の相場で動かします"))).toBe(true);
    // 廃止した取引先だけでも oanda / dex なら同じく ccxt にする。ccxt が使えない (初期化に失敗) なら監視銘柄が無いのでエラー
    const broken = vi.fn(() => { throw new Error("offline"); });
    await expect(buildRuntime(cfg({ VENUES: "oanda,dex" }), { store: new MemoryStore(), intelSources: [], logger, createCcxtFeed: broken })).rejects.toThrow(/監視銘柄がありません/);
  });

  it("live は発注先が無いので起動を拒否する (相場の取得・DB の前に。fail-closed)", async () => {
    const create = vi.fn();
    const store = new MemoryStore();
    const live = { ...cfg({ VENUES: "ccxt" }), mode: "live" as const };
    await expect(buildRuntime(live, { store, intelSources: [], ai: null, createCcxtFeed: create })).rejects.toThrow(LIVE_UNSUPPORTED_MESSAGE);
    await expect(buildRuntime({ ...cfg({ VENUES: "gmo" }), mode: "live" as const }, { store, intelSources: [], ai: null, createCcxtFeed: create })).rejects.toThrow(LIVE_UNSUPPORTED_MESSAGE);
    expect(create).not.toHaveBeenCalled();
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

  it("validate: hub の短い足では検証しない (feed から長い履歴を取れなければ undefined)", async () => {
    const candles = generateCandles({ seed: 4, bars: 1500, timeframe: "1m", startTs: START, vol: 0.0006 });
    const now = candles[candles.length - 1].ts + 60_000;
    const { hub, clock } = await hubWith(candles, now);
    const s = getStrategy("scalp_momentum_burst")!;
    // feed も 1500 本 (約 1 日) しか持たない: 要求 (14 日) の半分に満たないので検証しない
    const feed = { fetchCandles: async (_s: string, _tf: string, limit: number, since?: number) => candles.filter((c) => since === undefined || c.ts >= since).slice(0, limit) };
    const validate = createParamValidator({ hub, strategies: ALL_STRATEGIES, clock, minEdgeToCostRatio: 0, feedFor: () => feed });
    expect(await validate("scalp_momentum_burst", "crypto", s.defaultParams)).toBeUndefined();
    const noFeed = createParamValidator({ hub, strategies: ALL_STRATEGIES, clock, feedFor: () => undefined });
    expect(await noFeed("scalp_momentum_burst", "crypto", s.defaultParams)).toBeUndefined();
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
