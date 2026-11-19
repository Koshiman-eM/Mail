import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type { AssetClass, AuditEvent, Clock, Signal, Strategy, StrategyContext } from "../src/core/types";
import { routeDashboard } from "../src/dashboard/server";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { MAX_RISK_MULTIPLIER } from "../src/intel/planner";
import { forecastModelKey, forecastStatsKey } from "../src/learning/forecast";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5);

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });
const testConfig = () => loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", INTEL_LOOP_MS: String(30 * MIN), LEARN_LOOP_MS: String(HOUR) });

/** 常に同じ向きのシグナルを出すテスト用戦略 (scalp。保有中は何もしない) */
function fixedStrategy(id: string, direction: "long" | "short", classes: AssetClass[] = ["crypto", "meme", "fx", "stock"]): Strategy {
  return {
    id, horizon: "scalp", assetClasses: classes, regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m", "1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = direction === "long" ? ctx.market.quote.ask : ctx.market.quote.bid;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction, confidence: 0.8, expectedEdgeBps: 300,
        entry: { type: "market" }, stopLoss: direction === "long" ? px * 0.98 : px * 1.02, maxHoldMs: 20 * MIN, reason: `test ${id}`, features: {},
      };
    },
  };
}

async function runtime(opts: RuntimeOptions = {}) {
  const clock = mkClock();
  const store = new MemoryStore();
  const rt = await buildRuntime(testConfig(), {
    clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), ...opts,
  });
  return { rt, clock, store };
}

async function runFor(rt: Awaited<ReturnType<typeof runtime>>["rt"], clock: Clock & { t: number }, ms: number, stepMs = 30_000) {
  for (let now = START; now <= START + ms; now += stepMs) {
    clock.t = now;
    await rt.engine.advance(now);
  }
}

/** 発注・約定の記録 (乱数の id・時刻以外) */
function orderTrail(store: MemoryStore) {
  const strip = (a: AuditEvent) => {
    const { clientId: _c, orderId: _o, tradeId: _t, id: _i, ...rest } = a.data as Record<string, unknown>;
    return { ts: a.ts, type: a.type, ...rest };
  };
  return {
    audits: store.listAudit({}).filter((a) => a.type === "engine.entry" || a.type === "engine.exit").map(strip),
    trades: store.listTrades().map(({ id: _id, ...t }) => t),
    equity: store.listEquity({ mode: "paper" }),
  };
}

/** 全資産クラス・全予想時間を「実力あり」にした集計と、バイアスだけのモデル (pUp = sigmoid(b)) */
function injectLive(store: MemoryStore, bias: number) {
  const day = String(Math.floor(START / 86_400_000) * 86_400_000);
  const counts = { n: 200, hits: 140, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 40, brierN: 200 };
  // LIVE の判定に使う基礎モデル (consensus を除く) の集計: クラスタ 3,000 個・的中の割合 70% (4 時間の重複補正 √48 の後も z ≈ 3.2)
  const base = { n: 3000, hits: 2100, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 600, brierN: 3000, cn: 3000, cs: 2100 };
  const groups: Record<string, typeof counts> = {};
  const models: Record<string, unknown> = {};
  for (const h of ["15m", "1h", "4h"]) {
    for (const c of ["crypto", "meme", "fx", "stock"]) {
      groups[`c|${h}|${c}`] = counts;
      groups[`b|${h}|${c}`] = base;
      models[`${h}|${c}`] = { w: { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 0 }, b: bias, updates: 0 };
    }
  }
  store.kvSet(forecastStatsKey("paper"), { days: { [day]: groups }, recorded: 0, droppedCap: 0, droppedUnwatched: 0, learned: 0, sinceAudit: { judged: 0, hits: 0, n: 0, noise: 0, expired: 0 }, live: [] });
  store.kvSet(forecastModelKey("paper"), models);
}

describe("エンジンの値動きの予想", () => {
  it("実力が確かめられる前は倍率 1.0: 発注・約定の記録が予想なしのときと完全に同じ", async () => {
    const strategies = [fixedStrategy("t_long", "long"), fixedStrategy("t_short", "short", ["crypto"])];
    const a = await runtime({ strategies, engine: { forecast: { enabled: false } } });
    const b = await runtime({ strategies });
    await runFor(a.rt, a.clock, 6 * HOUR);
    await runFor(b.rt, b.clock, 6 * HOUR);
    const ta = orderTrail(a.store);
    const tb = orderTrail(b.store);
    expect(ta.audits.length).toBeGreaterThan(5);
    expect(tb).toEqual(ta);
    // 予想は出ており、判定もしている
    expect(b.rt.engine.forecast).toBeDefined();
    const s = b.rt.learning.snapshot({ now: b.clock.t }).forecast;
    expect(s.recorded).toBeGreaterThan(0);
    expect(s.byHorizon.find((g) => g.horizon === "15m")!.brierN + s.byHorizon.find((g) => g.horizon === "15m")!.noise).toBeGreaterThan(0);
    expect(s.byClass.every((g) => !g.live)).toBe(true);
    expect(tb.audits.every((x) => !("forecast" in x))).toBe(true);
    // 監査ログに毎件は残さない
    expect(b.store.listAudit({}).filter((x) => x.type.startsWith("learning.forecast_")).length).toBeLessThan(10);
    expect(a.rt.engine.forecast).toBeUndefined();
  }, 60_000);

  it("確かめられた後は、一致で上乗せ (最大 1.2 倍)・逆で削減 (最大 0.7 倍)。RiskManager を必ず通る", async () => {
    const clock = mkClock();
    const store = new MemoryStore();
    injectLive(store, 1); // pUp = sigmoid(1) ≈ 0.731 → up (起動前に kv へ入れる = 再起動後も続くことの確認を兼ねる)
    const rt2 = await buildRuntime(testConfig(), {
      clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7),
      strategies: [fixedStrategy("t_long", "long", ["crypto"]), fixedStrategy("t_short", "short", ["fx"])],
    });
    const calls: { symbol: string; dir: string; rm: number }[] = [];
    const orig = rt2.risk.evaluateEntry.bind(rt2.risk);
    const spy = vi.spyOn(rt2.risk, "evaluateEntry").mockImplementation((p) => {
      calls.push({ symbol: p.instrument.symbol, dir: p.signal.direction, rm: p.riskMultiplier });
      return orig(p);
    });
    await runFor(rt2, clock, 3 * HOUR);
    const entries = store.listAudit({ type: "engine.entry" });
    const withF = entries.filter((e) => (e.data as { forecast?: unknown }).forecast);
    expect(withF.length).toBeGreaterThan(0);
    const strength = (1 / (1 + Math.exp(-1)) - 0.5) * 2;
    for (const e of withF) {
      const d = e.data as { direction: string; riskMultiplier: number; forecast: { mult: number; pUp: number; baseRiskMultiplier: number; direction: string; horizon: string } };
      expect(d.forecast.direction).toBe("up");
      expect(d.forecast.horizon).toBe("15m");
      // 判定のたびに学習してバイアスが少し動くので、記録された pUp から期待値を出す (はじめは sigmoid(1))
      expect(Math.abs(d.forecast.pUp - (0.5 + strength / 2))).toBeLessThan(0.08);
      const st = (d.forecast.pUp - 0.5) * 2;
      const expected = d.direction === "long" ? 1 + 0.2 * st : 1 - 0.3 * st;
      expect(expected).toBeLessThanOrEqual(1.2);
      expect(expected).toBeGreaterThanOrEqual(0.7);
      expect(d.forecast.mult).toBeCloseTo(expected, 2);
      expect(d.riskMultiplier).toBeCloseTo(Math.min(MAX_RISK_MULTIPLIER, d.forecast.baseRiskMultiplier * expected), 2);
    }
    expect(withF.some((e) => (e.data as { direction: string }).direction === "long")).toBe(true);
    expect(withF.some((e) => (e.data as { direction: string }).direction === "short")).toBe(true);
    // すべてのエントリーは RiskManager を通っている
    expect(spy).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThanOrEqual(entries.length);
    const boosted = calls.filter((c) => c.dir === "long" && c.rm > 0);
    expect(boosted.length).toBeGreaterThan(0);
    // 状態 API: 反映中 (LIVE) と的中率・件数
    const st = await rt2.engine.status();
    const w = st.watched.find((x) => x.assetClass === "crypto")!;
    expect(w.forecast).toBeDefined();
    expect(w.forecast!.live).toBe(true);
    expect(w.forecast!.horizons.map((h) => h.horizon)).toEqual(["15m", "1h", "4h"]);
    // 注入した 200 件に、実行中の判定が加わる
    expect(w.forecast!.horizons[0]).toMatchObject({ direction: "up", live: true });
    expect(w.forecast!.horizons[0].n).toBeGreaterThanOrEqual(200);
    expect(w.forecast!.horizons[0].hitRate).toBeGreaterThan(0.5);
    expect(w.forecast!.horizons[0].rangePct).toBeGreaterThan(0);
    expect(w.forecast!.accuracy.n).toBeGreaterThanOrEqual(600);
    expect(w.forecast!.madeAt).toBeLessThanOrEqual(clock.t);
  }, 60_000);

  it("RiskManager が拒否すれば、予想が反映中でも発注しない", async () => {
    const clock = mkClock();
    const store = new MemoryStore();
    injectLive(store, 1);
    const rt = await buildRuntime(testConfig(), {
      clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7),
      strategies: [fixedStrategy("t_long", "long", ["crypto"])],
    });
    const spy = vi.spyOn(rt.risk, "evaluateEntry").mockReturnValue({ ok: false, reason: "テストで拒否" });
    const place = vi.spyOn(rt.brokerSet.paper!, "placeOrder");
    await runFor(rt, clock, HOUR);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([p]) => p.riskMultiplier !== 1)).toBe(true);
    expect(place).not.toHaveBeenCalled();
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
  }, 60_000);

  it("予想の処理が例外を投げても tick は止まらない", async () => {
    const { rt, clock } = await runtime({ strategies: [fixedStrategy("t_long", "long", ["crypto"])] });
    vi.spyOn(rt.engine.forecast!, "evaluate").mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(rt.engine.forecast!, "multiplierFor").mockImplementation(() => {
      throw new Error("boom2");
    });
    await runFor(rt, clock, HOUR);
    expect(rt.store.listAudit({ type: "engine.entry" }).length).toBeGreaterThan(0);
  }, 60_000);

  it("/api/status の watched[].forecast と /api/learning の forecast", async () => {
    const { rt, clock, store } = await runtime();
    await runFor(rt, clock, 2 * HOUR, 60_000);
    const deps = { status: () => rt.engine.status(), store, learning: rt.learning, clock };
    const st = JSON.parse((await routeDashboard(deps, "GET", "/api/status")).body);
    const f = st.watched[0].forecast;
    expect(f).toBeDefined();
    expect(f.horizons).toHaveLength(3);
    for (const h of f.horizons) {
      expect(["up", "down", "flat"]).toContain(h.direction);
      expect(h.pUp).toBeGreaterThan(0);
      expect(h.pUp).toBeLessThan(1);
      expect(h).toHaveProperty("rangePct");
      expect(h).toHaveProperty("hitRate");
      expect(h).toHaveProperty("n");
      expect(h.live).toBe(false);
      expect(Object.keys(h.contributions)).toEqual(["trend", "momentum", "meanRevert", "news", "consensus", "bias"]);
    }
    expect(f.accuracy).toMatchObject({ minSamples: 100 });
    expect(typeof f.madeAt).toBe("number");
    const le = JSON.parse((await routeDashboard(deps, "GET", "/api/learning")).body);
    expect(le.forecast).toBeDefined();
    expect(le.forecast.horizons).toEqual(["15m", "1h", "4h"]);
    expect(le.forecast.recorded).toBeGreaterThan(0);
    expect(le.forecast.byHorizon).toHaveLength(3);
    expect(le.forecast.calibration[0].bins).toHaveLength(10);
    expect(le.forecast.models.length).toBeGreaterThan(0);
    expect(le.forecast.options.minSamples).toBe(100);
  }, 60_000);
});
