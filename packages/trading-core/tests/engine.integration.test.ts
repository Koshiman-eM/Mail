/**
 * エンジンの統合試験 (コアだけで動かす。trader の tests/engine.integration.test.ts から一部を写したもの):
 * buildTestRuntime (assembleRuntime + 合成フィード + paper + MemoryStore + 仮想時計) で動かす
 */
import { describe, expect, it } from "vitest";
import type { Signal, Strategy, StrategyContext } from "../src/core/types";
import { PAPER_SNAPSHOT_KEY } from "../src/engine/engine";
import { PaperBroker } from "../src/execution/paper";
import { defaultSyntheticSpecs, mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { buildTestRuntime, testConfig, type TestRuntimeOptions } from "../src/testing/runtime";

const MIN = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5);
/** BTC/USDT・ETH/USDT (trader の試験の既定の WATCHLIST と同じ 2 銘柄) */
const TWO = defaultSyntheticSpecs().filter((s) => s.instrument.symbol !== "PEPE/USDT");

/** 保有していなければ常に買いのシグナルを出す戦略 */
function alwaysLong(id: string): Strategy {
  return {
    id, horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m", "1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 200,
        entry: { type: "market" }, stopLoss: px * 0.98, maxHoldMs: 30 * MIN, reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

const rt = (env: Record<string, string>, o: Omit<TestRuntimeOptions, "env" | "config"> = {}) =>
  buildTestRuntime({ config: testConfig({ LIMIT_TAKE_PROFIT: "false", BASE_CURRENCY: "JPY", ...env }), specs: TWO, seed: 3, start: START, ...o, opts: { rng: mulberry32(7), ...(o.opts ?? {}) } });

describe("TradingEngine 統合 (コア: buildTestRuntime)", () => {
  it("既定の戦略で仮想 8 時間: 決済・要因分析・腕の更新・評価額の記録・paper のみ", async () => {
    const { runtime, clock, store } = await rt({ INTEL_LOOP_MS: String(30 * MIN), LEARN_LOOP_MS: String(HOUR) }, { seed: 4, specs: defaultSyntheticSpecs() });
    const { engine } = runtime;
    for (let now = START; now <= START + 8 * HOUR; now += 30_000) {
      clock.t = now;
      await engine.advance(now);
    }
    await engine.stop();
    const trades = store.listTrades();
    expect(trades.length).toBeGreaterThanOrEqual(1);
    for (const t of trades) {
      expect(store.getAttribution(t.id)?.causes.length).toBeGreaterThan(0);
      expect(t.mode).toBe("paper");
      expect(t.entryContext.costBps).toBeGreaterThan(0);
    }
    expect(runtime.learning.allocator.snapshot().reduce((s, a) => s + a.n, 0)).toBe(trades.length);
    expect(store.listEquity().length).toBeGreaterThanOrEqual(8 * 60);
    expect(store.kvGet(PAPER_SNAPSHOT_KEY)).toBeDefined();
    expect(store.listAudit({ type: "engine.entry" }).length).toBeGreaterThanOrEqual(trades.length);
    expect(runtime.brokerSet.mode).toBe("paper");
    expect([...runtime.brokerSet.brokers.values()].every((b) => b instanceof PaperBroker && b.mode === "paper")).toBe(true);
  }, 60_000);

  it("kill switch が新たに発動したら全ポジションを決済し、以後は新規エントリーしない", async () => {
    const { runtime, clock, store } = await rt({ MAX_DRAWDOWN: "0.00001" }, { opts: { strategies: [alwaysLong("always_long")] } });
    expect((await runtime.engine.tick(START)).entries).toBe(2);
    let tripped = false;
    for (let i = 1; i <= 20 && !tripped; i++) {
      clock.t = START + i * 15_000;
      tripped = (await runtime.engine.tick(clock.t)).killSwitchTripped;
    }
    expect(tripped).toBe(true);
    expect(runtime.engine.positions.list()).toHaveLength(0);
    expect(store.listTrades().map((t) => t.exitReason)).toEqual(["kill_switch", "kill_switch"]);
    for (let i = 0; i < 4; i++) {
      clock.t += MIN;
      expect((await runtime.engine.tick(clock.t)).entries).toBe(0);
    }
  });

  it("再起動: PaperBroker の snapshot と保有中ポジションを復元する", async () => {
    const store = new MemoryStore();
    const s = alwaysLong("always_long");
    const first = await rt({}, { opts: { strategies: [s], store } });
    await first.runtime.engine.tick(START);
    await first.runtime.engine.stop();
    const before = await first.runtime.brokerSet.paper!.getPositions();
    expect(before).toHaveLength(2);
    const second = await rt({}, { start: START + MIN, opts: { strategies: [s], store } });
    await second.runtime.engine.init();
    expect(await second.runtime.brokerSet.paper!.getPositions()).toEqual(before);
    expect(second.runtime.engine.positions.list().map((p) => p.symbol).sort()).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect((await second.runtime.engine.tick(START + MIN)).entries).toBe(0);
  });
});
