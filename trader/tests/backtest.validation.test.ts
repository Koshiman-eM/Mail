/**
 * 実データの長期の検証のための backtest の追加 (--exchange / --symbols / --tokens / --cost-model / --folds / 保有との比較)。
 * 完全オフライン: ccxt の取引所はモックの CcxtLike、GeckoTerminal はモックの fetch
 */
import { describe, expect, it, vi } from "vitest";
import { cmdBacktest, parseBacktestArgs } from "../src/cli";
import { loadConfig } from "../src/appConfig";
import { CcxtFeed, ccxtExchangeIds, type CcxtLike } from "../src/market/feeds/ccxt";
import { describeInstrumentCosts, jupiterCostInstrument } from "../src/engine/backtestCosts";
import { fallbackBps, jupiterInstrument } from "../src/market/feeds/jupiter";
import { runBacktestCommand } from "../src/engine/backtestCommand";
import { GeckoHistoryFeed } from "../src/market/feeds/geckoHistory";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { TIMEFRAME_MS, type Instrument } from "../src/core/types";
import { createMockFetch, fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, poolOf } from "./helpers/jupiterMock";

const NOW = Date.UTC(2026, 10, 24);
const DAY = 86_400_000;

const market = (symbol: string) => {
  const [base, quote] = symbol.split("/");
  return { symbol, base, quote, spot: true, active: true, precision: { price: 0.01, amount: 0.001 }, limits: { amount: { min: 0.001 } }, taker: 0.001, maker: 0.001 };
};

/** 公開 API の足だけを返すモックの取引所。1 回の上限 maxPerCall を超える limit は拒否する (実際の取引所の 400 のかわり) */
function mockExchange(id: string, maxPerCall: number, opts: { firstTs?: number } = {}) {
  const calls: { symbol: string; tf: string; since?: number; limit?: number }[] = [];
  const price = (i: number, sym: string) => {
    const k = sym.startsWith("BTC") ? 300 : sym.startsWith("SOL") ? 100 : 1;
    return k * Math.exp(0.6 * Math.sin(i / 500) + 0.02 * Math.sin(i / 5.3) + 0.03 * Math.sin(i / 17.1));
  };
  const ex: CcxtLike = {
    id,
    rateLimit: 0,
    has: { fetchOHLCV: true },
    loadMarkets: vi.fn(async () => Object.fromEntries(["SOL/USDT", "BTC/USDT", "BTC/JPY"].map((s) => [s, market(s)]))),
    fetchOHLCV: vi.fn(async (symbol: string, tf: string, since?: number, limit?: number) => {
      calls.push({ symbol, tf, since, limit });
      if (limit !== undefined && limit > maxPerCall) throw new Error(`limit ${limit} > ${maxPerCall}`);
      const ms = TIMEFRAME_MS[tf as keyof typeof TIMEFRAME_MS];
      const start = Math.max(opts.firstTs ?? 0, Math.ceil((since ?? NOW - 300 * ms) / ms) * ms);
      const rows: number[][] = [];
      for (let ts = start; rows.length < (limit ?? maxPerCall) && ts + ms <= NOW; ts += ms) {
        const i = ts / ms;
        const o = price(i, symbol);
        const c = price(i + 1, symbol);
        rows.push([ts, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, 10]);
      }
      return rows;
    }),
    fetchTicker: vi.fn(async () => { throw new Error("使わない"); }),
    fetchOrderBook: vi.fn(async () => { throw new Error("使わない"); }),
    fetchTrades: vi.fn(async () => []),
  };
  return { ex, calls };
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

const config = () => loadConfig({ NODE_ENV: "test", DB_PATH: "memory", CCXT_EXCHANGE: "bitbank" });

describe("backtest の引数 (--exchange / --symbols / --tokens / --cost-model / --folds)", () => {
  it("--exchange は ccxt の取引所の id だけ (--source ccxt と一緒に)", () => {
    expect(ccxtExchangeIds()).toEqual(expect.arrayContaining(["binance", "bybit", "okx", "kraken", "coinbase", "bitbank"]));
    expect(parseBacktestArgs({ strategy: "all", source: "ccxt", exchange: "Binance" }).exchange).toBe("binance");
    expect(() => parseBacktestArgs({ strategy: "all", source: "ccxt", exchange: "nope" })).toThrow(/未知の取引所: nope/);
    expect(() => parseBacktestArgs({ strategy: "all", exchange: "binance" })).toThrow(/--source ccxt/);
    expect(() => CcxtFeed.create("nope")).toThrow(/ccxt に取引所 nope がありません/);
  });

  it("--symbols / --tokens / --cost-model / --folds", () => {
    expect(parseBacktestArgs({ strategy: "all", source: "ccxt", symbols: "SOL/USDT, BTC/USDT,SOL/USDT" }).symbols).toEqual(["SOL/USDT", "BTC/USDT"]);
    expect(parseBacktestArgs({ strategy: "all", source: "jupiter", tokens: "SOL,JUP" }).tokens).toEqual(["SOL", "JUP"]);
    expect(() => parseBacktestArgs({ strategy: "all", source: "jupiter", symbols: "SOL/USDT" })).toThrow(/--tokens/);
    expect(() => parseBacktestArgs({ strategy: "all", source: "ccxt", tokens: "SOL" })).toThrow(/--source jupiter/);
    expect(() => parseBacktestArgs({ strategy: "all", source: "ccxt", symbol: "A/USDT", symbols: "B/USDT" })).toThrow(/同時に/);
    expect(() => parseBacktestArgs({ "structure-compare": true, source: "ccxt", symbols: "A/USDT,B/USDT" })).toThrow(/1 銘柄だけ/);
    expect(() => parseBacktestArgs({ strategy: "all", symbols: "," })).toThrow(/1 つ以上/);
    expect(parseBacktestArgs({ strategy: "all", "cost-model": "jupiter" }).costModel).toBe("jupiter");
    expect(() => parseBacktestArgs({ strategy: "all", "cost-model": "cex" })).toThrow(/native \/ jupiter/);
    expect(parseBacktestArgs({ strategy: "all", folds: "5" }).folds).toBe(5);
    expect(parseBacktestArgs({ strategy: "all", folds: "0" })).not.toHaveProperty("folds");
    expect(() => parseBacktestArgs({ strategy: "all", folds: "1" })).toThrow(/2 以上/);
    // 比較の区間数は従来どおり (既定 5、2 以上)
    expect(parseBacktestArgs({ "structure-compare": true }).folds).toBe(5);
  });
});

describe("ccxt の取引所の上書きと長期の足", () => {
  it("CcxtFeed は取引所の 1 回の上限 (okx 300) に limit を切り詰める", async () => {
    const m = mockExchange("okx", 300);
    const feed = new CcxtFeed(m.ex, { now: () => NOW });
    const rows = await feed.fetchCandles("SOL/USDT", "4h", 1000, NOW - 2000 * TIMEFRAME_MS["4h"]);
    expect(rows).toHaveLength(300);
    expect(m.calls[0].limit).toBe(300);
  });

  it("--exchange はこの実行だけ CCXT_EXCHANGE を上書きし、複数銘柄・Jupiter のコスト・区間別・保有との比較を表示する", async () => {
    const m = mockExchange("okx", 300);
    const created: string[] = [];
    const o = io();
    const code = await cmdBacktest(
      { strategy: "short_ema_trend", source: "ccxt", exchange: "okx", symbols: "SOL/USDT,BTC/USDT", days: "20", "cost-model": "jupiter", folds: "3" },
      o.io,
      { config: config(), now: NOW, ccxtFeed: (id) => (created.push(id), new CcxtFeed(m.ex, { now: () => NOW })) },
    );
    expect(code).toBe(0);
    // 取引所は 1 回だけ作る (銘柄一覧を取り直さない)
    expect(created).toEqual(["okx"]);
    expect(m.ex.loadMarkets).toHaveBeenCalledTimes(1);
    // 15m の戦略なので 15m だけ。1 回の上限 300 を超えない
    expect(new Set(m.calls.map((c) => c.tf))).toEqual(new Set(["15m"]));
    expect(Math.max(...m.calls.map((c) => c.limit ?? 0))).toBeLessThanOrEqual(300);
    expect(new Set(m.calls.map((c) => c.symbol))).toEqual(new Set(["SOL/USDT", "BTC/USDT"]));
    const text = o.out.join("\n");
    expect(text).toContain("ccxt okx");
    expect(text).toContain("公開 API の足だけ");
    expect(text).toContain("コストの前提: Jupiter 相当");
    expect(text).toMatch(/■ SOL\/USDT {2}期間 \d{4}-\d\d-\d\d 〜 2026-11-24 \(20\.0 日\) {2}保有 \(buy & hold\): [+-]\d+\.\d\d% \/ 最大DD \d+\.\d\d%/);
    expect(text).toContain("■ BTC/USDT");
    expect(text).toContain("手数料 taker 0.000% / maker 0.000% / 固定 0.02 USDT/約定 / スプレッド 10.2bps (往復) / スリッページ 0.0bps (片道)");
    expect(text).toContain("保有リターン");
    expect(text).toContain("区間別 (3 区間");
    expect(text).toContain("2 銘柄の合計");
    expect(text).toContain("最大DD(合成)");
    expect(o.err.join("\n")).not.toContain("より短い");
  }, 60_000);

  it("--exchange が無ければ CCXT_EXCHANGE (bitbank → 既定の銘柄 BTC/JPY)。円建てに --cost-model jupiter は足を取る前に拒否", async () => {
    const m = mockExchange("bitbank-mock", 1000);
    const created: string[] = [];
    const o = io();
    const deps = { config: config(), now: NOW, ccxtFeed: (id: string) => (created.push(id), new CcxtFeed(m.ex, { now: () => NOW })) };
    expect(await cmdBacktest({ strategy: "short_ema_trend", source: "ccxt", days: "3" }, o.io, deps)).toBe(0);
    expect(created).toEqual(["bitbank"]);
    expect(o.out.join("\n")).toContain("ccxt bitbank");
    expect(o.out.join("\n")).toContain("■ BTC/JPY");
    expect(o.out.join("\n")).toContain("コストの前提: 取得元の銘柄定義 (--cost-model native)");
    m.calls.length = 0;
    await expect(cmdBacktest({ strategy: "short_ema_trend", source: "ccxt", symbol: "BTC/JPY", days: "3", "cost-model": "jupiter" }, io().io, deps))
      .rejects.toThrow(/USD 建て/);
    expect(m.calls).toHaveLength(0);
  }, 60_000);

  it("上場が新しい銘柄は取れた期間で計算し、実際の期間を警告する", async () => {
    const m = mockExchange("binance", 1000, { firstTs: NOW - 10 * DAY });
    const o = io();
    const code = await cmdBacktest(
      { strategy: "short_ema_trend", source: "ccxt", exchange: "binance", symbol: "SOL/USDT", days: "30" },
      o.io,
      { config: config(), now: NOW, ccxtFeed: () => new CcxtFeed(m.ex, { now: () => NOW }) },
    );
    expect(code).toBe(0);
    expect(o.err.join("\n")).toMatch(/警告: SOL\/USDT \(15m\): 実際の期間は .*要求の 30\.0 日より短いです/);
    expect(o.out.join("\n")).toContain("取れた分だけで計算しています");
  }, 60_000);
});

describe("--cost-model jupiter の銘柄定義", () => {
  const ccxtInst: Instrument = {
    symbol: "SOL/USDT", venue: "ccxt:binance", assetClass: "crypto", baseCurrency: "SOL", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
    takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: true, contractSize: 1, simulatedShort: true,
  };
  const s = { quoteSizeUsd: 50, networkFeeUsd: 0.02 };

  it("手数料率 0・ネットワーク手数料・主要銘柄の代わりのモデルのスプレッド (運用の jupiterInstrument と同じ数値)・空売りなし", () => {
    const j = jupiterCostInstrument(ccxtInst, s);
    expect(j).toMatchObject({ symbol: "SOL/USDT", venue: "ccxt:binance", takerFeeRate: 0, makerFeeRate: 0, fixedFeePerOrder: 0.02, allowShort: false, assetClass: "crypto" });
    expect(j.contractSize).toBeUndefined();
    expect(j.simulatedShort).toBeUndefined();
    expect(j.costModel!.refNotional).toBe(50);
    expect(j.costModel!.slippageBps).toBe(0);
    expect(j.costModel!.spreadBps).toBeCloseTo(2 * fallbackBps("crypto", 50, 10_000_000), 4);
    expect(j.costModel!.spreadBps).toBeCloseTo(10.2, 4);
    expect(describeInstrumentCosts(j)).toContain("固定 0.02 USDT/約定");
    // USDC・USD も可。円建ては拒否
    expect(() => jupiterCostInstrument({ ...ccxtInst, symbol: "SOL/USDC", quoteCurrency: "USDC" }, s)).not.toThrow();
    expect(() => jupiterCostInstrument({ ...ccxtInst, symbol: "BTC/JPY", quoteCurrency: "JPY" }, s)).toThrow(/USD 建て/);
    // Jupiter の銘柄 (--source jupiter) はそのまま
    const jup = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
    expect(jupiterCostInstrument(jup, s)).toBe(jup);
  });

  it("バックテストでは約定ごとに固定手数料だけを計上する (手数料率 0)", async () => {
    const m = mockExchange("binance", 1000);
    const feed = new CcxtFeed(m.ex, { now: () => NOW });
    const rows = await runBacktestCommand({
      strategy: "short_ema_trend", days: 20, source: "ccxt", seed: 1, feed, symbol: "SOL/USDT", now: NOW,
      adjustInstrument: (i) => jupiterCostInstrument(i, s),
    });
    const trades = rows[0].trades!;
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) expect(t.fees).toBeCloseTo(0.04, 8);
    const native = await runBacktestCommand({ strategy: "short_ema_trend", days: 20, source: "ccxt", seed: 1, feed, symbol: "SOL/USDT", now: NOW });
    expect(native[0].trades!.every((t) => t.fees > 0.04)).toBe(true);
  }, 60_000);
});

describe("--source jupiter --tokens (GeckoTerminal の履歴が短いとき)", () => {
  it("例外にせず警告して、取れた期間で回す", async () => {
    const T0 = Date.UTC(2026, 10, 20);
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now });
    const short = createMockFetch(async (call) => {
      const r = await mock.fetchImpl(call.url);
      const body = (await r.json()) as { data: { attributes: { ohlcv_list: number[][] } } };
      body.data.attributes.ohlcv_list = body.data.attributes.ohlcv_list.filter((row) => row[0] * 1000 >= T0 - 2 * DAY);
      return { body };
    }, clock.now);
    const gecko = new GeckoTerminalClient({ fetchImpl: short.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 6000, burst: 100, retries: 0 });
    const inst = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
    const tokens: string[] = [];
    const o = io();
    const code = await cmdBacktest({ strategy: "scalp_pullback", source: "jupiter", tokens: "BONK", days: "5", "cost-model": "jupiter" }, o.io, {
      config: config(), now: T0,
      jupiterFeed: async (token, onWarn) => {
        tokens.push(token);
        return { feed: new GeckoHistoryFeed(gecko, inst, poolOf(BONK), clock.now, undefined, onWarn), symbol: inst.symbol };
      },
    });
    expect(code).toBe(0);
    expect(tokens).toEqual(["BONK"]);
    const err = o.err.join("\n");
    expect(err).toContain("GeckoTerminal の 1m の履歴が要求より短いです");
    expect(err).toMatch(/要求の 5\.0 日より短いです/);
    const text = o.out.join("\n");
    expect(text).toContain("■ BONK/USDC");
    expect(text).toContain("--source jupiter の銘柄は運用と同じ銘柄定義のまま");
  }, 60_000);
});
