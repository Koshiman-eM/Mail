/**
 * 転換で決済 (REVERSAL_*) のバックテスト・パラメータ検証。バー i の終値で判定し、バー i+1 の始値で決済する (戦略の決済シグナルと同じ)。
 * すべて合成データ (オフライン)
 */
import { describe, expect, it } from "vitest";
import { generateCandles, runBacktest, syntheticInstrument } from "../src/backtest";
import { TIMEFRAME_MS, type Candle, type Signal, type Strategy, type StrategyContext } from "../src/core/types";
import { createParamValidator, HistoryCache } from "../src/engine/learningHooks";
import { DEFAULT_REVERSAL_SETTINGS, REVERSAL_DISABLED, type ReversalSettings } from "../src/engine/reversalExit";
import {
  barTs, H, INST, LONG_PROFIT, LONG_PROFIT_BREAK, M, probe, scenarioBars,
} from "./helpers/reversalScenario";

const ON: ReversalSettings = { ...DEFAULT_REVERSAL_SETTINGS, strategies: [] };
const COSTS = { spreadBps: 2, slippageBps: 1 };
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0, 97.5, 96.5, 96.0, 96.0, 96.0];

/**
 * 30 分ごと (主時間足が 30 分より長ければ毎足) に、建玉が無ければ買い / 売り (60 分ごとに売り) を出す台本の戦略
 * (損切り ∓pct・利確 ±2pct・最大保有 1000 分。合成データで転換で決済が起きやすい)
 */
function periodic(id = "periodic", pct = 0.006, tf: "1m" | "1h" = "1m"): Strategy {
  return {
    id, horizon: tf === "1m" ? "scalp" : "short", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: tf, timeframes: [tf], warmup: 20, defaultParams: {}, paramBounds: {},
    evaluate(ctx: StrategyContext): Signal | null {
      const k = Math.floor(ctx.market.now / M);
      if (ctx.position || k % 30 !== 0) return null;
      const short = k % 60 === 0;
      const px = short ? ctx.market.quote.bid : ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: short ? "short" : "long", confidence: 0.6,
        expectedEdgeBps: 100, entry: { type: "market" }, stopLoss: short ? px * (1 + pct) : px * (1 - pct),
        takeProfit: short ? px * (1 - 2 * pct) : px * (1 + 2 * pct), maxHoldMs: 1_000 * M, reason: "periodic", features: {},
      };
    },
  };
}

describe("バックテスト: 転換で決済", () => {
  it("押し安値割れの足の終値で判定し、次の足の始値で reversal (stats.reversalExits)", () => {
    const candles = scenarioBars(LONG_PROFIT, TAIL);
    const r = runBacktest({ strategy: probe({ at: barTs(H) }), instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryTs).toBe(barTs(H));
    expect(t.exitReason).toBe("reversal");
    // 判定した足 (r12) の次の足の始値 = 102.4 を成行 (売り) で約定
    expect(t.exitTs).toBe(barTs(H + LONG_PROFIT_BREAK + 1));
    expect(t.intendedExitPrice).toBe(102.4);
    expect(t.exitPrice).toBeCloseTo(102.4 * (1 - 0.0001 - 0.0001), 9);
    expect(t.netPnl).toBeGreaterThan(0);
    expect(r.stats).toMatchObject({ reversalExits: 1, signalExits: 0 });
  });

  it("売り (鏡像): 戻り高値超えで reversal", () => {
    const candles = scenarioBars(LONG_PROFIT.map((x) => 200 - x), TAIL.map((x) => 200 - x));
    const r = runBacktest({ strategy: probe({ at: barTs(H), direction: "short" }), instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(r.trades[0]).toMatchObject({ direction: "short", exitReason: "reversal", exitTs: barTs(H + LONG_PROFIT_BREAK + 1), intendedExitPrice: 97.6 });
  });

  it("同じ足で戦略の決済シグナルも出たら signal を優先する", () => {
    const candles = scenarioBars(LONG_PROFIT, TAIL);
    const strategy = probe({ at: barTs(H), flatFrom: barTs(H + LONG_PROFIT_BREAK + 1) });
    const r = runBacktest({ strategy, instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(r.trades[0]).toMatchObject({ exitReason: "signal", exitTs: barTs(H + LONG_PROFIT_BREAK + 1) });
    expect(r.stats).toMatchObject({ reversalExits: 0, signalExits: 1 });
  });

  it("無効・省略・対象外の戦略なら従来と同じ取引 (合成データの多数の取引で一致)", () => {
    const candles = generateCandles({ seed: 5, bars: 3000, timeframe: "1m", startTs: Date.UTC(2025, 0, 1), vol: 0.002 });
    const inst = syntheticInstrument();
    const opts = { strategy: periodic(), instrument: inst, candles, baseTimeframe: "1m" as const };
    const base = runBacktest(opts);
    expect(base.trades.length).toBeGreaterThan(20);
    expect(runBacktest({ ...opts, reversal: REVERSAL_DISABLED }).trades).toEqual(base.trades);
    expect(runBacktest({ ...opts, reversal: { ...ON, strategies: ["other"] } }).trades).toEqual(base.trades);
    expect(base.stats.reversalExits).toBeUndefined();
    // 有効なら一部の取引が転換で決済になる (決済は足の始値の時刻)
    const on = runBacktest({ ...opts, reversal: ON });
    const rev = on.trades.filter((t) => t.exitReason === "reversal");
    expect(rev.length).toBeGreaterThan(0);
    expect(on.stats.reversalExits).toBe(rev.length);
    const tsSet = new Set(candles.map((c) => c.ts));
    for (const t of rev) {
      expect(tsSet.has(t.exitTs)).toBe(true);
      expect(t.intendedExitPrice).toBe(candles.find((c) => c.ts === t.exitTs - M)!.close);
    }
    // 対象に入れれば同じ結果
    expect(runBacktest({ ...opts, reversal: { ...ON, strategies: ["periodic"] } }).trades).toEqual(on.trades);
  });

  it("主時間足 (5m) が基準足 (1m) と違っても、主時間足の確定足で判定する", () => {
    // 5m 足の台本 (LONG_PROFIT) を 1m 足 5 本ずつに分ける (5m に集約すると元の足に戻る)
    const five = scenarioBars(LONG_PROFIT, TAIL).map((b, i) => ({ ...b, ts: barTs(0) + i * 5 * M }));
    const ones: Candle[] = [];
    for (const b of five) {
      ones.push({ ts: b.ts, open: b.open, high: b.open, low: b.low, close: b.open, volume: 20 });
      ones.push({ ts: b.ts + M, open: b.open, high: b.high, low: b.open, close: b.open, volume: 20 });
      ones.push({ ts: b.ts + 2 * M, open: b.open, high: b.open, low: b.open, close: b.open, volume: 20 });
      ones.push({ ts: b.ts + 3 * M, open: b.open, high: b.open, low: b.open, close: b.open, volume: 20 });
      ones.push({ ts: b.ts + 4 * M, open: b.open, high: Math.max(b.open, b.close), low: Math.min(b.open, b.close), close: b.close, volume: 20 });
    }
    const p5: Strategy = { ...probe({ at: barTs(0) + H * 5 * M }), primaryTimeframe: "5m", timeframes: ["5m"] };
    const r = runBacktest({ strategy: p5, instrument: INST, candles: ones, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(r.trades[0]).toMatchObject({ exitReason: "reversal", entryTs: barTs(0) + H * 5 * M, exitTs: barTs(0) + (H + LONG_PROFIT_BREAK + 1) * 5 * M });
    // 1m 足のスイングでは判定しない (1m の主時間足なら別の足で決済する)
    const p1 = probe({ at: barTs(0) + H * 5 * M });
    const r1 = runBacktest({ strategy: p1, instrument: INST, candles: ones, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(r1.trades[0].exitTs).not.toBe(r.trades[0].exitTs);
  });
});

describe("パラメータ検証 (createParamValidator) にも転換で決済を渡す", () => {
  it("reversal を渡すと検証のバックテストでも reversal の決済が出る (渡さなければ出ない)", async () => {
    const s = periodic("periodic_1h", 0.02, "1h");
    const HMS = TIMEFRAME_MS["1h"];
    const START = Date.UTC(2025, 0, 1);
    const candles = generateCandles({ seed: 11, bars: 3200, timeframe: "1h", startTs: START, vol: 0.004 });
    const end = candles[candles.length - 1].ts + HMS;
    const feed = { async fetchCandles(_s: string, _tf: string, limit: number, since?: number) { return candles.filter((c) => since === undefined || c.ts >= since).slice(0, limit); } };
    const inst = syntheticInstrument({ symbol: "SYN/USDT" });
    const mk = (reversal?: ReversalSettings) =>
      createParamValidator({
        hub: { watched: () => [inst] }, strategies: [s], clock: { now: () => end }, feedFor: () => feed, pageLimit: 500,
        cache: new HistoryCache({ ttlMs: 6 * 3_600_000, failureTtlMs: 60_000 }), ...(reversal ? { reversal } : {}),
      });
    const off = (await mk()(s.id, "crypto", s.defaultParams))!;
    const on = (await mk(ON)(s.id, "crypto", s.defaultParams))!;
    expect(off.trades.some((t) => t.exitReason === "reversal")).toBe(false);
    expect(on.trades.some((t) => t.exitReason === "reversal")).toBe(true);
    expect(on.dataKey).toBe(off.dataKey);
  }, 60_000);
});
