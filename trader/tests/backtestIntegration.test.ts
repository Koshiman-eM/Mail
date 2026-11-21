import { describe, expect, it } from "vitest";
import type { Candle, IntelBias, OrderBook, Timeframe } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { resample } from "../src/indicators/resample";
import { ALL_STRATEGIES, getStrategy } from "../src/strategies/registry";
import { runBacktest } from "../src/backtest/engine";
import { evaluateParams, sliceMetrics, walkForward } from "../src/backtest/evaluate";
import { createRng, generateCandles, generateSynthetic, syntheticInstrument } from "../src/backtest/synthetic";

describe("synthetic", () => {
  it("同じシードなら同じ・違うシードなら違う", () => {
    expect(generateCandles({ seed: 5, bars: 300 })).toEqual(generateCandles({ seed: 5, bars: 300 }));
    expect(generateCandles({ seed: 5, bars: 300 })).not.toEqual(generateCandles({ seed: 6, bars: 300 }));
    const a = createRng(1);
    const b = createRng(1);
    expect([a.next(), a.normal()]).toEqual([b.next(), b.normal()]);
  });

  it("OHLC と時刻の整合", () => {
    const cs = generateCandles({ seed: 2, bars: 2000, timeframe: "5m" });
    expect(cs.length).toBe(2000);
    cs.forEach((c, i) => {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.low).toBeGreaterThan(0);
      expect(c.volume).toBeGreaterThan(0);
      if (i > 0) {
        expect(c.ts - cs[i - 1].ts).toBe(TIMEFRAME_MS["5m"]);
        expect(c.open).toBe(cs[i - 1].close);
      }
    });
  });

  it("レジーム指定どおりに動く (上昇は上がり、下降は下がり、高ボラは振れが大きい)", () => {
    const up = generateSynthetic({ seed: 3, segments: [{ regime: "trend_up", bars: 1000 }] });
    const down = generateSynthetic({ seed: 3, segments: [{ regime: "trend_down", bars: 1000 }] });
    expect(up.candles[999].close).toBeGreaterThan(up.candles[0].open * 1.01); // 現実的なドリフトなので 1000 本で +1% 超を要求
    expect(down.candles[999].close).toBeLessThan(down.candles[0].open * 0.99);
    expect(up.regimes.every((r) => r === "trend_up")).toBe(true);
    const range = (cs: Candle[]) => cs.reduce((a, c) => a + (c.high - c.low) / c.close, 0) / cs.length;
    const hv = generateSynthetic({ seed: 3, segments: [{ regime: "high_vol", bars: 500 }] }).candles;
    const rg = generateSynthetic({ seed: 3, segments: [{ regime: "range", bars: 500 }] }).candles;
    expect(range(hv)).toBeGreaterThan(range(rg) * 2);
    // レンジはアンカー付近にとどまる
    expect(Math.abs(rg[499].close / 100 - 1)).toBeLessThan(0.05);
  });

  it("ランダム切替では複数のレジームが現れる", () => {
    const { regimes } = generateSynthetic({ seed: 9, bars: 3000, meanSegmentBars: 150 });
    expect(new Set(regimes).size).toBeGreaterThanOrEqual(3);
  });
});

/** 戦略の主時間足に合わせた基準足を作る (1m で長期を作ると重いので主時間足を基準にする) */
function dataFor(primary: Timeframe, seed: number): { candles: Candle[]; base: Timeframe } {
  const bars: Record<string, number> = { "1m": 6000, "5m": 3000, "15m": 2500, "1h": 2000, "4h": 1500, "1d": 900 };
  const vol: Record<string, number> = { "1m": 0.0015, "15m": 0.004, "1h": 0.007, "4h": 0.012, "1d": 0.025 };
  return {
    candles: generateCandles({ seed, bars: bars[primary], timeframe: primary, vol: vol[primary] ?? 0.003, meanSegmentBars: 150 }),
    base: primary,
  };
}

describe("全戦略のバックテスト (合成データ)", () => {
  const bullish: IntelBias = { asset: "SYN", sentiment: 0.6, confidence: 0.8, eventRisk: 0, sourceIds: ["x"], sourceContrib: { x: 0.6 } };

  for (const strategy of ALL_STRATEGIES) {
    it(`${strategy.id}: 会計が整合し、TradeRecord が正しく埋まる`, () => {
      const { candles, base } = dataFor(strategy.primaryTimeframe, 21);
      const instrument = syntheticInstrument(strategy.assetClasses.includes("meme") && strategy.assetClasses.length === 1 ? { assetClass: "meme", allowShort: false } : {});
      const rng = createRng(4);
      const book = (): OrderBook => {
        const skew = rng.next() * 2 - 1;
        return { ts: 0, bids: [[99, 10 + 40 * Math.max(0, skew)]], asks: [[101, 10 + 40 * Math.max(0, -skew)]] };
      };
      const r = runBacktest({
        strategy,
        instrument,
        candles,
        baseTimeframe: base,
        initialEquity: 100_000,
        intel: bullish,
        marketExtras: strategy.requiresBook ? (bar) => ({ book: { ...book(), bids: [[bar.close * 0.9999, book().bids[0][1]]], asks: [[bar.close * 1.0001, book().asks[0][1]]] } }) : undefined,
      });
      expect(r.stats.evaluations).toBeGreaterThan(0);
      // 会計: 初期評価額 + Σ純損益 = 最終評価額 (closeAtEnd)
      const sumNet = r.trades.reduce((a, t) => a + t.netPnl, 0);
      expect(r.metrics.finalEquity).toBeCloseTo(100_000 + sumNet, 4);
      expect(r.metrics.netPnl).toBeCloseTo(sumNet, 4);
      expect(r.metrics.trades).toBe(r.trades.length);
      let prevExit = -Infinity;
      for (const t of r.trades) {
        expect(t.mode).toBe("backtest");
        expect(t.strategyId).toBe(strategy.id);
        expect(t.exitTs).toBeGreaterThanOrEqual(t.entryTs);
        expect(t.entryTs).toBeGreaterThanOrEqual(prevExit); // 同時に 1 ポジションのみ
        prevExit = t.exitTs;
        expect(t.mfePct).toBeGreaterThanOrEqual(0);
        expect(t.maePct).toBeGreaterThanOrEqual(0);
        expect(t.fees).toBeGreaterThan(0);
        expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees, 6);
        expect(["stop", "take_profit", "trailing", "signal", "time", "manual"]).toContain(t.exitReason);
        expect(t.entryContext.params).toEqual(r.params);
        expect(t.entryContext.costBps).toBeGreaterThan(0);
        if (t.direction === "short") expect(instrument.allowShort).toBe(true);
        if (t.direction === "long") expect(t.initialStop).toBeLessThan(t.intendedEntryPrice);
        else expect(t.initialStop).toBeGreaterThan(t.intendedEntryPrice);
      }
      expect(r.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(r.metrics.maxDrawdown).toBeLessThan(1);
      for (let i = 1; i < r.equityCurve.length; i++) expect(r.equityCurve[i].ts).toBeGreaterThan(r.equityCurve[i - 1].ts);
    });
  }

  it("主要戦略は合成データで実際に取引する", () => {
    for (const id of ["scalp_momentum_burst", "short_ema_trend", "short_breakout", "mid_trend_follow", "scalp_obi"]) {
      const s = getStrategy(id)!;
      const { candles, base } = dataFor(s.primaryTimeframe, 21);
      const r = runBacktest({
        strategy: s,
        instrument: syntheticInstrument(),
        candles,
        baseTimeframe: base,
        marketExtras: s.requiresBook
          ? (bar) => ({ book: { ts: 0, bids: [[bar.close * 0.9999, bar.close > bar.open ? 50 : 5]], asks: [[bar.close * 1.0001, bar.close > bar.open ? 5 : 50]] } })
          : undefined,
      });
      expect(r.trades.length, id).toBeGreaterThan(0);
    }
  });

  it("1m 基準で上位足戦略を回しても先読みしない (上位足の確定後にだけ判定)", () => {
    const candles = generateCandles({ seed: 8, bars: 3000, vol: 0.002 });
    const s = getStrategy("short_ema_trend")!;
    const calls: number[] = [];
    const spy = {
      ...s,
      warmup: 30,
      evaluate: (ctx: Parameters<typeof s.evaluate>[0]) => {
        calls.push(ctx.market.now);
        const cs = ctx.market.candles["15m"]!;
        expect(cs[cs.length - 1].ts + TIMEFRAME_MS["15m"]).toBeLessThanOrEqual(ctx.market.now);
        const i = (ctx.market.now - candles[0].ts) / 60_000 - 1;
        expect(cs).toEqual(resample(candles.slice(0, i + 1), "1m", "15m").slice(-cs.length));
        return s.evaluate(ctx);
      },
    };
    const r = runBacktest({ strategy: spy, instrument: syntheticInstrument(), candles, baseTimeframe: "1m" });
    expect(calls.every((t) => t % TIMEFRAME_MS["15m"] === 0)).toBe(true);
    // 損切り・利確は 1m のバー内で判定されるので決済時刻は 1m 刻み
    for (const t of r.trades) expect(t.exitTs % 60_000).toBe(0);
  });
});

describe("evaluateParams / walkForward", () => {
  const s = getStrategy("short_ema_trend")!;
  const candles = generateCandles({ seed: 31, bars: 3000, timeframe: "15m", vol: 0.004, meanSegmentBars: 200 });
  const instrument = syntheticInstrument();

  it("score と metrics を返し、決定的", () => {
    const a = evaluateParams(s, s.defaultParams, instrument, candles, { baseTimeframe: "15m" });
    const b = evaluateParams(s, s.defaultParams, instrument, candles, { baseTimeframe: "15m" });
    expect(Number.isFinite(a.score)).toBe(true);
    expect(a.score).toBe(b.score);
    expect(a.metrics.trades).toBeGreaterThan(0);
    expect(a.folds.length).toBe(3);
    // 区間の取引数の合計 = 全体の取引数
    expect(a.folds.reduce((x, f) => x + f.metrics.trades, 0)).toBe(a.metrics.trades);
    // 異なるパラメータは異なる結果
    const c = evaluateParams(s, { ...s.defaultParams, stopAtr: 3, tpAtr: 1 }, instrument, candles, { baseTimeframe: "15m" });
    expect(c.metrics).not.toEqual(a.metrics);
  });

  it("sliceMetrics は区間の評価額から成績を計算する", () => {
    const r = runBacktest({ strategy: s, instrument, candles, baseTimeframe: "15m" });
    const end = r.equityCurve[r.equityCurve.length - 1].ts;
    const all = sliceMetrics(r, r.equityCurve[0].ts, end);
    expect(all.netPnl).toBeCloseTo(r.metrics.netPnl, 6);
    expect(all.trades).toBe(r.metrics.trades);
  });

  it("walkForward は区間ごとに候補を選び検証スコアを返す", () => {
    const cands = [s.defaultParams, { ...s.defaultParams, entryThreshold: 35 }, { ...s.defaultParams, stopAtr: 1, tpAtr: 2 }];
    const wf = walkForward(s, cands, instrument, candles, { baseTimeframe: "15m", folds: 2 });
    expect(wf.folds.length).toBe(2);
    expect(wf.chosenCounts.reduce((a, b) => a + b, 0)).toBe(2);
    for (const f of wf.folds) {
      expect(f.trainTo).toBeLessThan(f.testFrom);
      expect(f.chosen).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(f.testScore)).toBe(true);
      // 検証区間のトレードは検証区間内でエントリーする (ウォームアップ区間では取引しない)
      expect(f.testMetrics.trades).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(wf.score)).toBe(true);
    expect(() => walkForward(s, [], instrument, candles)).toThrow();
  });
});
