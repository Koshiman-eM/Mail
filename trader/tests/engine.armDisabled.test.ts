/** エンジン統合: 無効化された腕の計画・探索・仮想トレード、direction_bias の答え合わせ (合成データ + 仮想時計 + MemoryStore、オフライン) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { AssetClass, Clock, RegimeLabel, Signal, Strategy, StrategyContext } from "../src/core/types";
import { emptyBrief } from "../src/engine/context";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { armKey, armStateKey } from "../src/learning/allocator";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const LABELS: RegimeLabel[] = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });
const testConfig = (extra: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", ...extra });

function fixedStrategy(id: string, o: { classes?: AssetClass[]; direction?: "long" | "short" } = {}): Strategy {
  return {
    id, horizon: "scalp", assetClasses: o.classes ?? ["crypto"], regimes: [...LABELS], primaryTimeframe: "1m", timeframes: ["1m", "1h"],
    warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const dir = o.direction ?? "long";
      const px = dir === "long" ? ctx.market.quote.ask : ctx.market.quote.bid;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: dir, confidence: 0.8, expectedEdgeBps: 200,
        entry: { type: "market" }, stopLoss: dir === "long" ? px * 0.998 : px * 1.002, takeProfit: dir === "long" ? px * 1.004 : px * 0.996,
        maxHoldMs: 10 * MIN, reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

/** 戦略 id の腕 (全レジーム × crypto) を無効化状態にしておく (回復判定の推定を大きく負にして、テスト中は戻らない) */
function seedDisabled(store: MemoryStore, id: string) {
  for (const label of LABELS) {
    const key = armKey(id, label, "crypto");
    store.kvSet(armStateKey("paper", key), {
      key, alpha: 2, beta: 30, n: 60, sumR: -60, sumR2: 60, ewmaR: -1, ewmaVarR: 0, updatedAt: START - 1,
      realN: 60, realMeanR: -1, realVarR: 0, disabled: true, recMeanR: -50, recW: 1e6, disabledAt: START - 1, disableCount: 1,
    });
  }
}

async function runtime(opts: RuntimeOptions & { rng: () => number }, env: Record<string, string> = {}) {
  const clock = mkClock();
  const store = new MemoryStore();
  seedDisabled(store, "off");
  const rt = await buildRuntime(testConfig(env), { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, ...opts });
  return { rt, clock, store };
}

async function run(rt: Awaited<ReturnType<typeof runtime>>["rt"], clock: Clock & { t: number }, from: number, to: number, stepMs = 15_000) {
  for (let now = from; now <= to; now += stepMs) {
    clock.t = now;
    await rt.engine.tick(now);
  }
}

describe("無効化された腕 (エンジン統合)", () => {
  it("計画は決定的な重みで外し (armDisabled)、エントリー時も探索に外れたら発注せず arm_disabled の仮想トレードだけ記録する", async () => {
    const { rt, clock, store } = await runtime({ strategies: [fixedStrategy("off")], rng: () => 0.99 });
    // 計画は乱数を使わない: 何度作っても無効な腕は外れる (レジームが分かるよう 1 ティック進めてから作る)
    await rt.engine.tick(START);
    const plan = (await rt.engine.runIntel(START))!;
    const again = await rt.engine.buildPlan(emptyBrief(START), START);
    let checked = 0;
    for (const p of [plan, again]) {
      for (const sp of Object.values(p.perSymbol)) {
        if (rt.hub.instrument(sp.symbol)?.assetClass !== "crypto") continue; // 戦略 off は crypto のみ
        // レジーム不明の銘柄は腕のキーが決まらないため計画では外さない (エントリー時の腕の重みで止める)
        if (sp.notes?.includes("レジーム不明")) continue;
        expect(sp.enabledStrategies).not.toContain("off");
        if (sp.notes?.includes("低流動性")) continue;
        expect(sp.armDisabled).toContain("off");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    await run(rt, clock, START + 15_000, START + 3 * MIN);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    const open = rt.engine.shadow!.list();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.reason === "arm_disabled" && o.strategyId === "off")).toBe(true);
    await rt.engine.stop();
    const reasons = store.listAudit({ type: "engine.skip_summary" }).flatMap((a) => Object.keys((a.data as { reasons: object }).reasons));
    expect(reasons).toContain("arm_disabled");
    expect(reasons).not.toContain("plan_disabled");
  }, 60_000);

  it("探索に当たったら (乱数 < 5%) 計画で外した腕でも最小サイズ (0.25 倍) で RiskManager を通して発注する", async () => {
    const { rt, clock, store } = await runtime({ strategies: [fixedStrategy("off")], rng: () => 0.01 });
    await rt.engine.runIntel(START);
    await run(rt, clock, START, START + 2 * MIN);
    const entries = store.listAudit({ type: "engine.entry" });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect((e.data as { armWeight: number }).armWeight).toBe(0.25);
  }, 60_000);

  it("direction_bias で止めた仮想トレードは、記録時の情報バイアスを添えて情報の効き具合を更新する (再起動をまたいでも)", async () => {
    // 合成の crypto は現物 (allowShort=false)。空売りの再現を切って、従来の (再現ではない) 売りの仮想トレードとして確かめる
    const { rt, clock, store } = await runtime({ strategies: [fixedStrategy("a", { direction: "short" })], rng: () => 0.99 }, { PAPER_SIMULATE_SHORT: "false" });
    await run(rt, clock, START, START + MIN);
    const sym = rt.hub.watched().find((i) => i.assetClass === "crypto")!.symbol;
    const view = rt.hub.getView(sym, clock.t)!;
    const engine = rt.engine as unknown as {
      shadowRecord: (k: string, i: unknown, v: unknown, s: Strategy, sig: Signal, r: unknown, now: number, sent?: number) => void;
    };
    const strat = fixedStrategy("a2", { direction: "short" });
    const sig = strat.evaluate({ market: view, regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 }, params: {} })!;
    engine.shadowRecord("direction_bias", view.instrument, view, strat, sig, { label: "range" }, clock.t, 0.7);
    expect(Object.keys(store.kvGet<Record<string, unknown>>("shadowIntel:paper") ?? {})).toEqual([`${sym}|a2|short`]);
    // 決済まで進める (保有上限 10 分)
    await run(rt, clock, clock.t + 15_000, clock.t + 15 * MIN);
    const closed = store.listShadowTrades().filter((t) => t.reason === "direction_bias" && t.strategyId === "a2");
    expect(closed).toHaveLength(1);
    const st = store.kvGet<{ shadowN?: number; n: number }>("intelInfluence:paper:crypto");
    expect(st).toMatchObject({ shadowN: 1, n: 0.25 });
    expect(store.kvGet<Record<string, unknown>>("shadowIntel:paper")).toEqual({});
  }, 60_000);

  it("paper で再現した空売りの direction_bias の仮想トレードは、空売りの腕 (…|short) だけを更新し、情報の効き具合には入れない", async () => {
    const { rt, clock, store } = await runtime({ strategies: [fixedStrategy("a", { direction: "long" })], rng: () => 0.99 });
    await run(rt, clock, START, START + MIN);
    const inst = rt.hub.watched().find((i) => i.assetClass === "crypto")!;
    expect(inst.allowShort).toBe(false);
    expect(inst.simulatedShort).toBe(true);
    const view = rt.hub.getView(inst.symbol, clock.t)!;
    const engine = rt.engine as unknown as {
      shadowRecord: (k: string, i: unknown, v: unknown, s: Strategy, sig: Signal, r: unknown, now: number, sent?: number) => void;
    };
    const strat = fixedStrategy("b2", { direction: "short" });
    const sig = strat.evaluate({ market: view, regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 }, params: {} })!;
    engine.shadowRecord("direction_bias", view.instrument, view, strat, sig, { label: "range" }, clock.t, 0.7);
    await run(rt, clock, clock.t + 15_000, clock.t + 15 * MIN);
    const closed = store.listShadowTrades().filter((t) => t.strategyId === "b2");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ simulatedShort: true, direction: "short" });
    expect(closed[0].borrowRateDaily).toBeCloseTo(0.0004, 10);
    expect(store.kvGet(armStateKey("paper", armKey("b2", "range", "crypto", true)))).toMatchObject({ shadowN: 1 });
    expect(store.kvGet(armStateKey("paper", armKey("b2", "range", "crypto")))).toBeUndefined();
    expect(store.kvGet("intelInfluence:paper:crypto")).toBeUndefined();
  }, 60_000);
});
