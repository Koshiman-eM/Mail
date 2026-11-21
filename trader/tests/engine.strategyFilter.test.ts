/** 戦略が見送ったシグナル (onFiltered) は仮想トレードとしてだけ記録され、発注されない */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Clock, Signal, Strategy, StrategyContext } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);

/** 毎回 onFiltered("cost") を呼んで null を返す戦略 */
function filteringStrategy(id: string): Strategy {
  return {
    id, horizon: "scalp", assetClasses: ["crypto"],
    regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m", "1h"], warmup: 1,
    defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      ctx.onFiltered?.({
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 50,
        entry: { type: "market" }, stopLoss: px * 0.998, takeProfit: px * 1.004, maxHoldMs: 8 * MIN, reason: "filtered", features: {},
      }, "cost");
      return null;
    },
  };
}

describe("エンジン: strategy_filter の仮想トレード", () => {
  it("発注 0 件、strategy_filter:cost の未決済が記録される", async () => {
    const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
    const store = new MemoryStore();
    const rt = await buildRuntime(
      loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY" }),
      { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), strategies: [filteringStrategy("filt")] },
    );
    let entries = 0;
    for (let now = START; now <= START + 3 * MIN; now += 15_000) {
      clock.t = now;
      entries += (await rt.engine.tick(now)).entries;
    }
    expect(entries).toBe(0);
    expect(store.listTrades()).toHaveLength(0);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    const open = rt.engine.shadow!.list();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.reason === "strategy_filter:cost" && o.strategyId === "filt")).toBe(true);
  });
});
