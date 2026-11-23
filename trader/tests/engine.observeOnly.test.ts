/** エンジン統合: 観測専用の戦略 (OBSERVE_ONLY_STRATEGIES) は発注せず、仮想トレード (observe_only) だけを記録する (合成データ、オフライン) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import { createLogger } from "../src/core/logger";
import type { Clock, RegimeLabel, Signal, Strategy, StrategyContext } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { armKey, armStateKey, type ArmState } from "../src/learning/allocator";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const LABELS: RegimeLabel[] = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];
const SYMBOL = "BTC/USDT";

/** BTC/USDT にだけ、建玉が無ければ毎回買いのシグナルを出す戦略 (stop/tp は ±pct) */
function buyer(id: string, pct = 0.05, holdMin = 60): Strategy {
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

async function setup(
  strategies: Strategy[], env: Record<string, string>, seed?: (store: MemoryStore) => void, o: { store?: MemoryStore; start?: number } = {},
) {
  const clock: Clock & { t: number } = { t: o.start ?? START, now() { return this.t; } };
  const store = o.store ?? new MemoryStore();
  seed?.(store);
  let rngCalls = 0;
  const base = mulberry32(7);
  const rng = () => { rngCalls++; return base(); };
  const rt = await buildRuntime(
    loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", ...env }),
    { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng, strategies },
  );
  let riskCalls = 0;
  const orig = rt.risk.evaluateEntry.bind(rt.risk);
  rt.risk.evaluateEntry = ((...a: Parameters<typeof orig>) => { riskCalls++; return orig(...a); }) as typeof rt.risk.evaluateEntry;
  const run = async (from: number, to: number) => {
    let entries = 0;
    for (let now = from; now <= to; now += 15_000) {
      clock.t = now;
      entries += (await rt.engine.tick(now)).entries;
    }
    return entries;
  };
  return { rt, store, run, rngCalls: () => rngCalls, riskCalls: () => riskCalls };
}

describe("エンジン: 観測専用の戦略", () => {
  it("OBSERVE_ONLY_STRATEGIES に含まれる戦略は発注 0 件・RiskManager と腕の乱数に触れず、observe_only の仮想トレードを 1 件記録する", async () => {
    const { rt, store, run, rngCalls, riskCalls } = await setup([buyer("obs")], { OBSERVE_ONLY_STRATEGIES: "obs" });
    const entries = await run(START, START + 3 * MIN);
    expect(entries).toBe(0);
    expect(store.listTrades()).toHaveLength(0);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    expect(riskCalls()).toBe(0);
    expect(rngCalls()).toBe(0);
    const open = rt.engine.shadow!.list();
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("observe_only");
    expect(open[0].strategyId).toBe("obs");
    expect(open[0].symbol).toBe(SYMBOL);
    expect(open[0].direction).toBe("long");
  });

  it("含まれないときは通常の経路 (RiskManager → 発注) に乗り、observe_only は記録しない", async () => {
    const { rt, store, run, riskCalls } = await setup([buyer("obs")], { OBSERVE_ONLY_STRATEGIES: "" });
    const entries = await run(START, START + 3 * MIN);
    expect(entries).toBeGreaterThanOrEqual(1);
    expect(riskCalls()).toBeGreaterThanOrEqual(1);
    expect(store.listAudit({ type: "engine.entry" }).length).toBeGreaterThanOrEqual(1);
    expect(rt.engine.shadow!.list().some((o) => o.reason === "observe_only")).toBe(false);
  });

  it("別の戦略だけが観測専用なら、この戦略は通常どおり発注する", async () => {
    const { run } = await setup([buyer("obs")], { OBSERVE_ONLY_STRATEGIES: "other" });
    expect(await run(START, START + 3 * MIN)).toBeGreaterThanOrEqual(1);
  });

  it("既定 (未設定) では scalp_rebound だけが観測専用", async () => {
    const { rt, run } = await setup([buyer("scalp_rebound")], {});
    expect(await run(START, START + 3 * MIN)).toBe(0);
    const open = rt.engine.shadow!.list();
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("observe_only");
    // 観測専用でない戦略は通常どおり発注する (廃止した中長期の戦略の id も既定では特別扱いしない)
    for (const id of ["short_ema_trend", "mid_trend_follow"]) {
      const { run: r } = await setup([buyer(id)], {});
      expect(await r(START, START + 3 * MIN), id).toBeGreaterThanOrEqual(1);
    }
  });

  it("起動時: OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があれば警告をログに出して無視する (既定なら出さない)", async () => {
    for (const [env, expected] of [[{ OBSERVE_ONLY_STRATEGIES: "scalp_rebound,mid_trend_follow,long_momentum" }, true], [{}, false]] as const) {
      const logs: string[] = [];
      const base = createLogger("test");
      const logger = { ...base, warn: (m: string) => void logs.push(m) };
      const rt = await buildRuntime(
        loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", ...env }),
        { clock: { now: () => START }, store: new MemoryStore(), intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 86_400_000, strategies: [], logger },
      );
      expect(logs.includes("OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): mid_trend_follow, long_momentum"), JSON.stringify(env)).toBe(expected);
      rt.close();
    }
  });

  it("観測専用にした戦略の保有中の建玉は、従来どおり管理・決済する (新規だけ止める)", async () => {
    const store = new MemoryStore();
    // 観測専用でないときに建てた scalp_rebound の建玉 (損切り・利確 ±5%・最大保有 2 分)
    const first = await setup([buyer("scalp_rebound", 0.05, 2)], { OBSERVE_ONLY_STRATEGIES: "" }, undefined, { store });
    let t = START;
    for (; t <= START + 3 * MIN && first.rt.engine.positions.list().length === 0; t += 15_000) await first.run(t, t);
    const held = first.rt.engine.positions.list();
    expect(held).toHaveLength(1);
    await first.rt.engine.stop();
    // 既定 (scalp_rebound は観測専用) で再起動: 建玉を復元して管理し、損切り・利確・時間切れのどれかで決済する
    const second = await setup([buyer("scalp_rebound", 0.05, 2)], {}, undefined, { store, start: t });
    await second.rt.engine.init();
    expect(second.rt.engine.positions.list().map((p) => p.id)).toEqual([held[0].id]);
    expect(await second.run(t, t + 8 * MIN)).toBe(0);
    expect(second.rt.engine.positions.list()).toHaveLength(0);
    const closed = store.listTrades().filter((t) => t.id === held[0].id);
    expect(closed).toHaveLength(1);
    // 決済は通常の管理 (損切り・利確・時間切れ・読みの管理・転換で決済など)。手動・キルスイッチではない
    expect(closed[0].exitReason).not.toMatch(/manual|kill/);
    // 決済した後の新規は発注せず、observe_only の仮想トレードとして記録する
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(1);
    expect([...second.rt.engine.shadow!.list(), ...store.listShadowTrades()].some((t) => t.reason === "observe_only")).toBe(true);
    await second.rt.engine.stop();
  }, 60_000);

  it("腕が止まっていても arm_disabled ではなく observe_only として記録する (判定は腕・計画より前)", async () => {
    const { rt, run } = await setup([buyer("obs")], { OBSERVE_ONLY_STRATEGIES: "obs" }, (store) => {
      for (const label of LABELS) {
        const key = armKey("obs", label, "crypto");
        store.kvSet(armStateKey("paper", key), {
          key, alpha: 2, beta: 30, n: 60, sumR: -60, sumR2: 60, ewmaR: -1, ewmaVarR: 0, updatedAt: START - 1,
          realN: 60, realMeanR: -1, realVarR: 0, disabled: true, recMeanR: -50, recW: 1e6, disabledAt: START - 1, disableCount: 1,
        });
      }
    });
    await run(START, START + 3 * MIN);
    const open = rt.engine.shadow!.list();
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("observe_only");
  });

  it("決済した observe_only の仮想トレードは腕の配分に重み 0.25 で入り、実取引の統計 (腕を止める判定) には入らない", async () => {
    // 損切り・利確を近くして、時間切れ (2 分) までに必ず決済させる
    const { store, run } = await setup([buyer("obs", 0.0005, 2)], { OBSERVE_ONLY_STRATEGIES: "obs" });
    await run(START, START + 6 * MIN);
    const closed = store.listShadowTrades();
    const mine = closed.filter((t) => t.strategyId === "obs");
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((t) => t.reason === "observe_only")).toBe(true);
    const arms = LABELS.map((l) => store.kvGet<ArmState>(armStateKey("paper", armKey("obs", l, "crypto")))).filter((a): a is ArmState => !!a);
    expect(arms.length).toBeGreaterThanOrEqual(1);
    const shadowN = arms.reduce((s, a) => s + (a.shadowN ?? 0), 0);
    expect(shadowN).toBe(mine.length);
    for (const a of arms) {
      expect(a.realN ?? 0).toBe(0);
      expect(a.n).toBe(0);
      expect(a.disabled).toBe(false);
      expect(a.wN).toBeCloseTo(0.25 * (a.shadowN ?? 0), 9);
    }
  });
});

describe("エンジン: 資産クラスごとの観測専用 (<id>:<資産クラス>)", () => {
  /** 建玉が無ければ毎回買う (crypto・meme の両方) */
  function anyBuyer(id: string): Strategy {
    return {
      id, horizon: "scalp", assetClasses: ["crypto", "meme"], regimes: [...LABELS], primaryTimeframe: "1m", timeframes: ["1m", "1h"],
      warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
      evaluate(ctx: StrategyContext): Signal | null {
        if (ctx.position) return null;
        const px = ctx.market.quote.ask;
        return {
          strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 500,
          entry: { type: "market" }, stopLoss: px * 0.95, takeProfit: px * 1.05, maxHoldMs: 60 * MIN, reason: `test ${id}`, features: {},
        };
      },
    };
  }
  const WATCH = { WATCHLIST: "synthetic|BTC/USDT,synthetic|PEPE/USDT|meme" };
  const observed = (rt: Awaited<ReturnType<typeof setup>>["rt"], store: MemoryStore) =>
    [...rt.engine.shadow!.list(), ...store.listShadowTrades()].filter((t) => t.reason === "observe_only").map((t) => t.symbol);
  const entered = (store: MemoryStore) => store.listAudit({ type: "engine.entry" }).map((a) => a.data.symbol);

  it("short_ema_trend:meme は meme の銘柄だけ発注せず observe_only にし、crypto は通常どおり発注する", async () => {
    const { rt, store, run } = await setup([anyBuyer("short_ema_trend")], { ...WATCH, OBSERVE_ONLY_STRATEGIES: "short_ema_trend:meme" });
    expect(rt.instruments.map((i) => [i.symbol, i.assetClass])).toEqual([["BTC/USDT", "crypto"], ["PEPE/USDT", "meme"]]);
    await run(START, START + 3 * MIN);
    expect(entered(store)).toContain("BTC/USDT");
    expect(entered(store)).not.toContain("PEPE/USDT");
    expect(observed(rt, store)).toContain("PEPE/USDT");
    expect(observed(rt, store)).not.toContain("BTC/USDT");
  });

  it("既定 (未設定) でも short_ema_trend は meme だけ観測専用", async () => {
    const { rt, store, run } = await setup([anyBuyer("short_ema_trend")], WATCH);
    await run(START, START + 3 * MIN);
    expect(entered(store)).toContain("BTC/USDT");
    expect(observed(rt, store)).toEqual(["PEPE/USDT"]);
  });

  it("id だけの指定は従来どおり全クラスを観測専用にする", async () => {
    const { rt, store, run } = await setup([anyBuyer("short_ema_trend")], { ...WATCH, OBSERVE_ONLY_STRATEGIES: "short_ema_trend" });
    await run(START, START + 3 * MIN);
    expect(entered(store)).toEqual([]);
    expect(new Set(observed(rt, store))).toEqual(new Set(["BTC/USDT", "PEPE/USDT"]));
  });

  it("空文字を明示すれば既定の short_ema_trend:meme も無効 (meme でも observe_only にしない)", async () => {
    const { rt, store, run } = await setup([anyBuyer("short_ema_trend")], { ...WATCH, OBSERVE_ONLY_STRATEGIES: "" });
    await run(START, START + 3 * MIN);
    expect(observed(rt, store)).toEqual([]);
  });

  it("使えない資産クラスの指定は起動時に警告して無視する (起動は止めない)", async () => {
    const logs: string[] = [];
    const logger = { ...createLogger("test"), warn: (m: string) => void logs.push(m) };
    const rt = await buildRuntime(
      loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", OBSERVE_ONLY_STRATEGIES: "short_ema_trend:fx,short_ema_trend:meme" }),
      { clock: { now: () => START }, store: new MemoryStore(), intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 86_400_000, strategies: [], logger },
    );
    expect(logs).toContain("OBSERVE_ONLY_STRATEGIES に使えない資産クラスの指定があります (無視されます。使えるのは crypto / meme): short_ema_trend:fx");
    rt.close();
  });
});
