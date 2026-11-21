/**
 * 廃止した戦略 (mid_trend_follow・long_momentum・meme_momentum) の建玉を DB から復元したときの扱い (合成データ、オフライン)。
 * - 戦略が registry に無くても起動・復元は例外にならない
 * - 損切り・利確・読みの管理・転換で決済は続く (転換で決済は src/strategies/retired.ts の主時間足で判定する)。持ち主の戦略の決済シグナルだけは出ない
 * - 学習データ (腕の kv) は消さない
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Clock, RegimeLabel, Signal, Strategy, StrategyContext } from "../src/core/types";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { armKey, armStateKey } from "../src/learning/allocator";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { getStrategy } from "../src/strategies/registry";
import { RETIRED_STRATEGIES } from "../src/strategies/retired";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const LABELS: RegimeLabel[] = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];
const SYMBOL = "BTC/USDT";

/** 廃止前の戦略の代わり: BTC/USDT に建玉が無ければ買いのシグナルを出す (id だけ廃止した戦略と同じにする) */
function buyer(id: string, pct: number, holdMin: number): Strategy {
  return {
    id, horizon: "scalp", assetClasses: ["crypto"], regimes: [...LABELS], primaryTimeframe: "1m", timeframes: ["1m", "1h"],
    warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position || ctx.market.instrument.symbol !== SYMBOL) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "scalp", symbol: SYMBOL, direction: "long", confidence: 0.8, expectedEdgeBps: 500,
        entry: { type: "market" }, stopLoss: px * (1 - pct), takeProfit: px * (1 + pct), maxHoldMs: holdMin * MIN, reason: `test ${id}`, features: {},
      };
    },
  };
}

async function runtime(store: MemoryStore, start: number, env: Record<string, string>, strategies?: Strategy[]) {
  const clock: Clock & { t: number } = { t: start, now() { return this.t; } };
  const opts: RuntimeOptions = {
    clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...(strategies ? { strategies } : {}),
  };
  const rt = await buildRuntime(
    loadConfig({ NODE_ENV: "test", VENUES: "synthetic", WATCHLIST: `synthetic|${SYMBOL}`, DB_PATH: "memory", BASE_CURRENCY: "JPY", LIMIT_ENTRY: "false", ...env }),
    opts,
  );
  const run = async (from: number, to: number, until?: () => boolean) => {
    let t = from;
    for (; t <= to; t += 15_000) {
      clock.t = t;
      await rt.engine.tick(t);
      if (until?.()) break;
    }
    return t;
  };
  return { rt, run };
}

/** 廃止前に建てた建玉を作り、廃止後の registry (opts.strategies なし) で復元する */
async function openThenRestore(id: string, pct: number, holdMin: number, env: Record<string, string> = {}) {
  const store = new MemoryStore();
  const first = await runtime(store, START, env, [buyer(id, pct, holdMin)]);
  const t = await first.run(START, START + 5 * MIN, () => first.rt.engine.positions.list().length > 0);
  const held = first.rt.engine.positions.list();
  expect(held).toHaveLength(1);
  expect(held[0].strategyId).toBe(id);
  await first.rt.engine.stop();
  // 廃止した戦略の腕の学習データ (例) を置いておく
  const arm = armStateKey("paper", armKey(id, "range", "crypto"));
  const armState = store.kvGet(arm) ?? { key: armKey(id, "range", "crypto"), alpha: 3, beta: 2, n: 4, sumR: 1, sumR2: 2, ewmaR: 0.2, ewmaVarR: 0.5, updatedAt: START };
  store.kvSet(arm, armState);

  const second = await runtime(store, t + 15_000, env);
  expect(getStrategy(id)).toBeUndefined();
  await second.rt.engine.init();
  expect(second.rt.engine.positions.list().map((p) => [p.id, p.strategyId])).toEqual([[held[0].id, id]]);
  return { store, held: held[0], second, t: t + 15_000, arm };
}

describe("廃止した戦略の建玉の復元", () => {
  it("registry に無い戦略の建玉も復元して管理し、損切り・利確・読みの管理で決済する (起動・決済で例外にならない)", async () => {
    const { store, held, second, t, arm } = await openThenRestore("mid_trend_follow", 0.003, 2);
    await second.run(t, t + 4 * 60 * MIN, () => second.rt.engine.positions.list().length === 0);
    expect(second.rt.engine.positions.list()).toHaveLength(0);
    const closed = store.listTrades().filter((x) => x.id === held.id);
    expect(closed).toHaveLength(1);
    expect(closed[0].strategyId).toBe("mid_trend_follow");
    // 通常の管理で決済した (手動・キルスイッチではない。戦略が無いので signal でもない)
    expect(closed[0].exitReason).toMatch(/^(stop|take_profit|trailing|time|thesis_failed|thesis_timeout|thesis_cap|reversal)$/);
    // 新規エントリーは registry の戦略だけ (廃止した戦略では建てない)
    for (const e of store.listAudit({ type: "engine.entry" }).slice(1)) expect(e.data.strategyId).not.toBe("mid_trend_follow");
    // 学習データは消さない
    expect(store.kvGet(arm)).toBeDefined();
    await second.rt.engine.stop();
  }, 120_000);

  it("転換で決済は廃止した戦略の主時間足 (RETIRED_STRATEGIES) の 1 つ下で判定する", async () => {
    expect(RETIRED_STRATEGIES.meme_momentum.primaryTimeframe).toBe("1m");
    // 損切り・利確を遠く、保有を長くして、転換で決済が先に効くようにする (読みの管理は無効)
    const { store, held, second, t } = await openThenRestore("meme_momentum", 0.2, 24 * 60, { THESIS_EXIT: "false" });
    await second.run(t, t + 6 * 60 * MIN, () => second.rt.engine.positions.list().length === 0);
    const closed = store.listTrades().filter((x) => x.id === held.id);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe("reversal");
    const audit = store.listAudit({ type: "position.reversal_exit" }).find((a) => a.data.tradeId === held.id);
    expect(audit?.data).toMatchObject({ strategyId: "meme_momentum", primaryTimeframe: "1m", timeframe: "1m" });
    await second.rt.engine.stop();
  }, 120_000);
});
