/** コアの組み立て (assembleRuntime / buildTestRuntime / liveBrokerSet) とカレンダーでの新規エントリーの停止 */
import { describe, expect, it } from "vitest";
import type { MarketCalendar } from "../src/core/calendar";
import type { Signal, Strategy, StrategyContext } from "../src/core/types";
import { liveBrokerSet } from "../src/execution/brokerSet";
import { assembleRuntime, NO_LIVE_BROKERS_MESSAGE } from "../src/engine/runtime";
import { buildTestRuntime, testConfig } from "../src/testing/runtime";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

const MIN = 60_000;

/** 保有していなければ毎回買いのシグナルを出す戦略 */
const alwaysLong: Strategy = {
  id: "always_long", horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
  primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
  evaluate(ctx: StrategyContext): Signal | null {
    if (ctx.position) return null;
    const px = ctx.market.quote.ask;
    return {
      strategyId: "always_long", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 300,
      entry: { type: "market" }, stopLoss: px * 0.98, maxHoldMs: 30 * MIN, reason: "test", features: {},
    };
  },
};
const NEVER_OPEN: MarketCalendar = {
  isOpen: () => false, nextOpen: () => Infinity, nextClose: () => Infinity, tradingDayKey: () => "closed", nextTradingDayStart: (ts) => ts + 86_400_000,
};

async function run(calendar?: MarketCalendar) {
  const { runtime, clock, store } = await buildTestRuntime({ opts: { strategies: [alwaysLong] }, ...(calendar ? { assembly: { calendar } } : {}) });
  let entries = 0;
  const start = clock.t;
  for (let t = start; t <= start + 5 * MIN; t += 15_000) {
    clock.t = t;
    entries += (await runtime.engine.tick(t)).entries;
  }
  await runtime.engine.stop();
  return { entries, store, runtime };
}

describe("assembleRuntime / buildTestRuntime", () => {
  it("合成フィード + paper で新規エントリーが RiskManager を通って建つ", async () => {
    const { entries, runtime, store } = await run();
    expect(runtime.brokerSet.mode).toBe("paper");
    expect(entries).toBeGreaterThan(0);
    expect(store.listAudit({ type: "engine.entry" }).length).toBe(entries);
  });
  it("カレンダーが閉じている間は新規エントリーしない (見送り market_closed)", async () => {
    const { entries, store } = await run(NEVER_OPEN);
    expect(entries).toBe(0);
    await Promise.resolve();
    const reasons = store.listAudit({ type: "engine.skip_summary" }).flatMap((a) => Object.keys((a.data as { reasons: object }).reasons));
    expect(reasons).toContain("market_closed");
  });
  it("live の発注先 (createLiveBrokers) が無ければ起動しない", async () => {
    const config = { ...testConfig(), mode: "live" as const };
    await expect(assembleRuntime(config, { markets: [] })).rejects.toThrow(NO_LIVE_BROKERS_MESSAGE);
  });
});

describe("liveBrokerSet", () => {
  it("銘柄の venue のアダプターを引き、アダプターの無い venue があれば例外", () => {
    const inst = { symbol: "BTC/USDT", venue: "x", assetClass: "crypto" as const, baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 1, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: false };
    const b = new FakeLiveBroker();
    const set = liveBrokerSet({ x: b }, [inst]);
    expect(set.mode).toBe("live");
    expect(set.brokerFor("BTC/USDT")).toBe(b);
    expect(() => set.brokerFor("ETH/USDT")).toThrow(/未知の銘柄/);
    expect(() => liveBrokerSet({ y: b }, [inst])).toThrow(/実口座アダプター/);
  });
});
