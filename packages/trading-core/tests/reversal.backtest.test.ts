/**
 * 転換で決済 (REVERSAL_*) のバックテスト・パラメータ検証。バー i の終値で判定し、バー i+1 の始値で決済する (戦略の決済シグナルと同じ)。
 * すべて合成データ (オフライン)
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { TIMEFRAME_MS, type Candle, type Signal, type Strategy, type StrategyContext } from "../src/core/types";
import { createParamValidator, HistoryCache } from "../src/engine/learningHooks";
import { DEFAULT_REVERSAL_SETTINGS, type ReversalSettings } from "../src/engine/reversalExit";
import {
  barTs, H, INST, LONG_LOSS, LONG_LOSS_BREAK, LONG_PROFIT, LONG_PROFIT_BREAK, M, probe, scenarioBars,
} from "./helpers/reversalScenario";

/** 転換で決済を無効にした設定 (従来どおり) */
const REVERSAL_DISABLED: Readonly<ReversalSettings> = { ...DEFAULT_REVERSAL_SETTINGS, enabled: false };

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

  it("REVERSAL_EXIT_TF=same: 主時間足 (5m) が基準足 (1m) と違っても、主時間足の確定足で判定する。lower なら 1m 足で判定する", () => {
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
    const SAME: ReversalSettings = { ...ON, timeframe: "same" };
    const r = runBacktest({ strategy: p5, instrument: INST, candles: ones, baseTimeframe: "1m", ...COSTS, reversal: SAME });
    expect(r.trades[0]).toMatchObject({ exitReason: "reversal", entryTs: barTs(0) + H * 5 * M, exitTs: barTs(0) + (H + LONG_PROFIT_BREAK + 1) * 5 * M });
    // 1m 足のスイングでは判定しない (1m の主時間足なら別の足で決済する)
    const p1 = probe({ at: barTs(0) + H * 5 * M });
    const r1 = runBacktest({ strategy: p1, instrument: INST, candles: ones, baseTimeframe: "1m", ...COSTS, reversal: SAME });
    expect(r1.trades[0].exitTs).not.toBe(r.trades[0].exitTs);
    // lower (既定): 5m の戦略も 1m 足 (主時間足の 1 つ下) で判定する = 1m の戦略と同じ足・同じ理由で決済する
    // (probe は 1 回だけエントリーするので、実行ごとに作り直す)
    const p5b: Strategy = { ...probe({ at: barTs(0) + H * 5 * M }), primaryTimeframe: "5m", timeframes: ["5m"] };
    const lo = runBacktest({ strategy: p5b, instrument: INST, candles: ones, baseTimeframe: "1m", ...COSTS, reversal: ON });
    expect(lo.trades[0]).toMatchObject({ entryTs: r.trades[0].entryTs, exitTs: r1.trades[0].exitTs, exitReason: r1.trades[0].exitReason });
  });

  it("REVERSAL_EXIT_TF=lower: 5m の戦略の建玉を 1m 足の押し安値割れで決済する (5m の確定を待たない)", () => {
    const candles = scenarioBars(LONG_PROFIT, TAIL);
    const p5 = (): Strategy => ({ ...probe({ at: barTs(H) }), primaryTimeframe: "5m", timeframes: ["5m"] });
    const lo = runBacktest({ strategy: p5(), instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: ON });
    // 1m の r12 の終値 102.4 が 1m の押し安値 102.55 を割る → 次の 1m 足 (5m の途中) の始値で決済
    expect(lo.trades[0]).toMatchObject({ entryTs: barTs(H), exitReason: "reversal", exitTs: barTs(H + LONG_PROFIT_BREAK + 1), intendedExitPrice: 102.4 });
    expect((lo.trades[0].exitTs - barTs(0)) % (5 * M)).not.toBe(0);
    expect(lo.stats.reversalExits).toBe(1);
    // same なら 5m 足で判定する (別の時刻・別の理由)
    const same = runBacktest({ strategy: p5(), instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: { ...ON, timeframe: "same" } });
    expect(same.trades[0].exitTs).not.toBe(lo.trades[0].exitTs);
  });

  it("lower でも基準足が粗くて 1 つ下の時間足を作れなければ same (主時間足) で判定する", () => {
    const five = scenarioBars(LONG_PROFIT, TAIL).map((b, i) => ({ ...b, ts: barTs(0) + i * 5 * M }));
    // probe は 1 回だけエントリーするので、実行ごとに作り直す
    const p5 = (): Strategy => ({ ...probe({ at: barTs(0) + H * 5 * M }), primaryTimeframe: "5m", timeframes: ["5m"] });
    const opts = { instrument: INST, candles: five, baseTimeframe: "5m" as const, ...COSTS };
    const lo = runBacktest({ ...opts, strategy: p5(), reversal: ON });
    const same = runBacktest({ ...opts, strategy: p5(), reversal: { ...ON, timeframe: "same" } });
    expect(lo.trades[0]).toMatchObject({ exitReason: "reversal", exitTs: barTs(0) + (H + LONG_PROFIT_BREAK + 1) * 5 * M });
    expect(lo.trades).toEqual(same.trades);
  });
});

describe("バックテスト: フォールバック (REVERSAL_EXIT_FALLBACK)", () => {
  it("既定 (false) はスイングの確定を待ち、true ならエントリーした足の安値割れで決済する", () => {
    const candles = scenarioBars(LONG_LOSS, [99.3, 99.0, 98.5, 98.0]);
    const run = (fallback: boolean) =>
      runBacktest({ strategy: probe({ at: barTs(H) }), instrument: INST, candles, baseTimeframe: "1m", ...COSTS, reversal: { ...ON, fallback } });
    // 既定: r5 のスイングロー 99.55 を r10 の終値 99.4 が割る → r11 の始値で決済
    expect(run(false).trades[0]).toMatchObject({ exitReason: "reversal", exitTs: barTs(H + LONG_LOSS_BREAK + 1) });
    // フォールバック: エントリーした足の安値 99.95 を r5 の終値 99.6 が割る → r6 の始値で決済
    expect(run(true).trades[0]).toMatchObject({ exitReason: "reversal", exitTs: barTs(H + 6) });
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
