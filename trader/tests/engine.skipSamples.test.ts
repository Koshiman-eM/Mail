/** 見送り理由の実例 (samples): 集計キーは # のまま、数字入りの元の文字列を skip_summary に載せる */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Clock, Signal, Strategy, StrategyContext } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { routeDashboard, type DashboardDeps } from "../src/dashboard/server";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);

function cheapStrategy(): Strategy {
  return {
    id: "cheap", horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m", "1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: "cheap", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 0.5,
        entry: { type: "market" }, stopLoss: px * 0.998, takeProfit: px * 1.004, maxHoldMs: 10 * MIN, reason: "test", features: { x: 1 },
      };
    },
  };
}

describe("skip_summary の samples", () => {
  it("キーは # のまま、samples に数字入りの実例 (160 文字以内) が入り、ダッシュボードの API が実例を返す", async () => {
    const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
    const store = new MemoryStore();
    const cfg = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY" });
    const rt = await buildRuntime(cfg, { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), strategies: [cheapStrategy()] });
    for (let now = START; now <= START + 5 * MIN; now += 15_000) {
      clock.t = now;
      await rt.engine.tick(now);
    }
    await rt.engine.stop();
    const logs = store.listAudit({ type: "engine.skip_summary" });
    const keys = logs.flatMap((a) => Object.keys((a.data as { reasons: object }).reasons)).filter((k) => k.startsWith("risk: 期待値幅"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toContain("#");
    const withSamples = logs.map((a) => a.data as { samples?: Record<string, string> }).filter((d) => d.samples);
    const key = keys[0];
    const sample = withSamples.map((d) => d.samples![key]).find(Boolean)!;
    expect(sample).toMatch(/期待値幅 \d/);
    for (const d of withSamples) for (const v of Object.values(d.samples!)) expect(v.length).toBeLessThanOrEqual(160);

    const d = { status: () => ({}), store, learning: { snapshot: () => ({}) } } as unknown as DashboardDeps;
    const r = JSON.parse((await routeDashboard(d, "GET", "/api/events?limit=50")).body);
    const reasons = r.events.filter((e: { type: string }) => e.type === "engine.skip_summary").map((e: { data: { reason: string } }) => e.data.reason).join("\n");
    expect(reasons).toMatch(/期待値幅 \d/);
  }, 60_000);

  it("実例の無い古いログは従来どおりキーを表示する", async () => {
    const store = new MemoryStore();
    store.audit({ ts: 1000, type: "engine.skip_summary", data: { since: 0, reasons: { "risk: 期待値幅 #bps": { count: 3, sample: "x" } } } });
    const d = { status: () => ({}), store, learning: { snapshot: () => ({}) } } as unknown as DashboardDeps;
    const r = JSON.parse((await routeDashboard(d, "GET", "/api/events?limit=10")).body);
    expect(r.events[0].data.reason).toBe("risk: 期待値幅 #bps×3");
  });
});
