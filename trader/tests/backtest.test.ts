import { describe, expect, it } from "vitest";
import type { Candle, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { resample } from "../src/indicators/resample";
import { runBacktest, syntheticInstrument, generateCandles, inferTimeframe } from "../src/backtest";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);
/** バー i の終了時刻 (= そのバーで判定するときの now) */
const closeOf = (i: number) => T0 + (i + 1) * M;

/** 1m 足を明示的に作る ([open, high, low, close]) */
function bars(rows: [number, number, number, number][]): Candle[] {
  return rows.map(([o, h, l, c], i) => ({ ts: T0 + i * M, open: o, high: h, low: l, close: c, volume: 100 }));
}
const flatRows = (n: number, p = 100): [number, number, number, number][] => Array.from({ length: n }, () => [p, p + 0.2, p - 0.2, p]);

function entrySignal(dir: "long" | "short", stopLoss: number, takeProfit?: number, extra: Partial<Signal> = {}): Signal {
  return {
    strategyId: "scripted",
    horizon: "scalp",
    symbol: "SYN/USDT",
    direction: dir,
    confidence: 0.7,
    expectedEdgeBps: 100,
    entry: { type: "market" },
    stopLoss,
    takeProfit,
    maxHoldMs: 1_000 * M,
    reason: "scripted",
    features: { k: 1 },
    ...extra,
  };
}

/** 判定時刻 (now) → シグナル を返す台本どおりの戦略 */
function scripted(decide: (ctx: StrategyContext) => Signal | null, opts: Partial<Strategy> = {}): Strategy {
  return {
    id: "scripted",
    horizon: "scalp",
    assetClasses: ["crypto"],
    regimes: ["range"],
    primaryTimeframe: "1m",
    timeframes: ["1m"],
    warmup: 1,
    defaultParams: { stopAtr: 1, tpAtr: 1, trailAtr: 0, entryThreshold: 0, maxHoldBars: 10 },
    paramBounds: {},
    evaluate: decide,
    ...opts,
  };
}

const NO_COST = { spreadBps: 0, slippageBps: 0 };
const inst = syntheticInstrument({ takerFeeRate: 0, tickSize: 0, lotSize: 0, minQty: 0 });

describe("先読み禁止", () => {
  it("evaluate に渡る足は全て now までに確定しており、上位足は resample の確定足と一致する", () => {
    const candles = generateCandles({ seed: 11, bars: 400 });
    const seen: { now: number; view: StrategyContext["market"] }[] = [];
    const spy = scripted(
      (ctx) => {
        seen.push({ now: ctx.market.now, view: ctx.market });
        return null;
      },
      { primaryTimeframe: "5m", timeframes: ["1m", "5m", "15m"], warmup: 3 },
    );
    runBacktest({ strategy: spy, instrument: inst, candles, baseTimeframe: "1m", historyBars: 1000 });
    expect(seen.length).toBeGreaterThan(50);
    for (const { now, view } of seen) {
      const i = (now - T0) / M - 1; // 現在バー
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeLessThan(candles.length - 1);
      // 主時間足 (5m) の確定直後にだけ判定される
      expect(now % TIMEFRAME_MS["5m"]).toBe(0);
      for (const tf of ["1m", "5m", "15m"] as Timeframe[]) {
        const cs = view.candles[tf]!;
        for (const c of cs) expect(c.ts + TIMEFRAME_MS[tf]).toBeLessThanOrEqual(now);
        const expected = tf === "1m" ? candles.slice(0, i + 1) : resample(candles.slice(0, i + 1), "1m", tf);
        expect(cs).toEqual(expected);
      }
      // 気配は現在バーの終値から作る (次バーの情報を含まない)
      expect(view.quote.last).toBe(candles[i].close);
    }
  });

  it("約定は次のバーの始値 ± 半スプレッド ± スリッページ", () => {
    const rows = flatRows(20);
    rows[11] = [100.5, 100.7, 100.3, 100.4]; // 次バーの始値
    const candles = bars(rows);
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", 90, 120) : null));
    const r = runBacktest({ strategy: s, instrument: inst, candles, spreadBps: 4, slippageBps: 1 });
    const t = r.trades[0];
    expect(t.entryTs).toBe(candles[11].ts);
    expect(t.entryPrice).toBeCloseTo(100.5 * (1 + 0.0002 + 0.0001), 10);
    expect(t.intendedEntryPrice).toBeCloseTo(100 * (1 + 0.0002), 10);
  });
});

describe("決済ロジック", () => {
  const longAt10 = (stop: number, tp?: number, extra: Partial<Signal> = {}) =>
    scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", stop, tp, extra) : null));

  it("同一バーで損切りと利確の両方に触れたら損切り優先", () => {
    const rows = flatRows(20);
    rows[12] = [100, 102, 98, 101];
    const r = runBacktest({ strategy: longAt10(99, 101), instrument: inst, candles: bars(rows), ...NO_COST });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0].exitReason).toBe("stop");
    expect(r.trades[0].exitPrice).toBeCloseTo(99);
    expect(r.trades[0].exitTs).toBe(closeOf(12));
  });

  it("利確は指値 (利確価格で約定)", () => {
    const rows = flatRows(20);
    rows[12] = [100, 101.5, 99.5, 101];
    const r = runBacktest({ strategy: longAt10(99, 101), instrument: inst, candles: bars(rows), ...NO_COST });
    expect(r.trades[0].exitReason).toBe("take_profit");
    expect(r.trades[0].exitPrice).toBe(101);
    expect(r.trades[0].mfePct).toBeCloseTo(0.01);
    expect(r.trades[0].maePct).toBeCloseTo(0.002); // エントリー足とその後の安値 99.8
  });

  it("始値で損切りを越えていたら始値で約定 (ギャップ)", () => {
    const rows = flatRows(20);
    rows[12] = [97, 97.5, 96.5, 97];
    const r = runBacktest({ strategy: longAt10(99, 101), instrument: inst, candles: bars(rows), spreadBps: 0, slippageBps: 10 });
    expect(r.trades[0].exitReason).toBe("stop");
    expect(r.trades[0].exitPrice).toBeCloseTo(97 * (1 - 0.001));
    expect(r.trades[0].exitTs).toBe(T0 + 12 * M);
    expect(r.trades[0].intendedExitPrice).toBe(99);
  });

  it("ショートの損切り優先・損益の符号", () => {
    const rows = flatRows(20);
    rows[12] = [100, 102, 98, 99];
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("short", 101, 99) : null));
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(rows), ...NO_COST });
    expect(r.trades[0].direction).toBe("short");
    expect(r.trades[0].exitReason).toBe("stop");
    expect(r.trades[0].exitPrice).toBe(101);
    expect(r.trades[0].netPnl).toBeLessThan(0);
    expect(r.trades[0].rMultiple).toBeCloseTo(-1);
  });

  it("トレーリングは前バーまでの最高値から計算する", () => {
    const rows = flatRows(20);
    rows[12] = [100, 105, 103.5, 104.5]; // 同じバーの高値 105 ではまだ発動しない
    rows[13] = [104.5, 104.8, 103.9, 104]; // 105 × 0.99 = 103.95 を割る
    const r = runBacktest({ strategy: longAt10(95, undefined, { trailingStopPct: 0.01 }), instrument: inst, candles: bars(rows), ...NO_COST });
    const t = r.trades[0];
    expect(t.exitReason).toBe("trailing");
    expect(t.exitTs).toBe(closeOf(13));
    expect(t.exitPrice).toBeCloseTo(103.95);
  });

  it("maxHoldMs 経過で次の始値に時間切れ決済", () => {
    const r = runBacktest({ strategy: longAt10(90, 110, { maxHoldMs: 3 * M }), instrument: inst, candles: bars(flatRows(20)), ...NO_COST });
    const t = r.trades[0];
    expect(t.exitReason).toBe("time");
    expect(t.entryTs).toBe(T0 + 11 * M);
    expect(t.exitTs).toBe(T0 + 14 * M);
  });

  it("保有中の flat シグナルで次の始値に決済 (signal)", () => {
    const rows = flatRows(20);
    rows[16] = [100.3, 100.5, 100.1, 100.2];
    const s = scripted((ctx) => {
      if (!ctx.position && ctx.market.now === closeOf(10)) return entrySignal("long", 90, 110);
      if (ctx.position && ctx.market.now === closeOf(15)) return { ...entrySignal("long", 0), direction: "flat" };
      return null;
    });
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(rows), ...NO_COST });
    expect(r.trades[0].exitReason).toBe("signal");
    expect(r.trades[0].exitPrice).toBe(100.3);
    expect(r.stats.signalExits).toBe(1);
  });

  it("保有中は PositionView が渡され、終了時は manual で決済", () => {
    let positions = 0;
    const s = scripted((ctx) => {
      if (ctx.position) {
        positions++;
        expect(ctx.position.qty).toBeGreaterThan(0);
        expect(ctx.position.strategyId).toBe("scripted");
      }
      return !ctx.position && ctx.market.now === closeOf(10) ? entrySignal("long", 90, 110) : null;
    });
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(flatRows(20)), ...NO_COST });
    expect(positions).toBeGreaterThan(0);
    expect(r.trades[0].exitReason).toBe("manual");
    expect(r.trades[0].exitTs).toBe(closeOf(19));
  });

  it("allowShort=false の銘柄ではショートしない", () => {
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) ? entrySignal("short", 101, 99) : null));
    const r = runBacktest({ strategy: s, instrument: { ...inst, allowShort: false }, candles: bars(flatRows(20)), ...NO_COST });
    expect(r.trades.length).toBe(0);
    expect(r.stats.skipped.short).toBe(1);
  });

  it("minEdgeToCostRatio でコスト負けのシグナルを見送る", () => {
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) ? entrySignal("long", 99, 101, { expectedEdgeBps: 5 }) : null));
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(flatRows(20)), spreadBps: 2, slippageBps: 1, minEdgeToCostRatio: 2 });
    expect(r.trades.length).toBe(0);
    expect(r.stats.skipped.edge).toBe(1);
  });

  it("edgeIsNet のシグナルは比率 0 (フィルターなし) でも期待値 > 0 が必要 (ライブの RiskManager と同じ)。それ以外は比率 0 なら判定しない", () => {
    const run = (extra: Partial<Signal>, minEdgeToCostRatio?: number) => {
      const s = scripted((ctx) => (ctx.market.now === closeOf(10) ? entrySignal("long", 99, 101, extra) : null));
      return runBacktest({
        strategy: s, instrument: inst, candles: bars(flatRows(20)), spreadBps: 2, slippageBps: 1,
        ...(minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio } : {}),
      });
    };
    for (const edge of [0, -3, NaN]) {
      const r = run({ expectedEdgeBps: edge, edgeIsNet: true });
      expect(r.trades.length, String(edge)).toBe(0);
      expect(r.stats.skipped.edge, String(edge)).toBe(1);
      expect(run({ expectedEdgeBps: edge, edgeIsNet: true }, 0).stats.skipped.edge, String(edge)).toBe(1);
    }
    // 純期待値が正なら比率 0 では通る。edgeIsNet でないシグナルは比率 0 なら期待値によらず通る
    expect(run({ expectedEdgeBps: 0.5, edgeIsNet: true }).trades.length).toBe(1);
    expect(run({ expectedEdgeBps: -3 }).trades.length).toBe(1);
    // 比率 2 (コスト 4bps = スプレッド 2 + 滑り 2): edgeIsNet は (2 − 1) × 4 = 4bps 以上、それ以外は 8bps 以上
    expect(run({ expectedEdgeBps: 5, edgeIsNet: true }, 2).trades.length).toBe(1);
    expect(run({ expectedEdgeBps: 3, edgeIsNet: true }, 2).trades.length).toBe(0);
    expect(run({ expectedEdgeBps: 5 }, 2).trades.length).toBe(0);
  });
});

describe("会計・サイズ", () => {
  it("手数料込み損益 (decimal) と評価額が一致する", () => {
    const rows = flatRows(20);
    rows[12] = [100, 102.5, 99.9, 102];
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", 99, 102) : null));
    const r = runBacktest({
      strategy: s,
      instrument: { ...inst, takerFeeRate: 0.001 },
      candles: bars(rows),
      ...NO_COST,
      initialEquity: 10_000,
      riskPerTrade: 0.01,
      maxPositionPct: 10,
    });
    const t = r.trades[0];
    // qty = 10000 × 0.01 / (100 - 99) = 100
    expect(t.qty).toBe(100);
    expect(t.grossPnl).toBeCloseTo(200, 10);
    expect(t.fees).toBeCloseTo((100 * 100 + 102 * 100) * 0.001, 10);
    expect(t.netPnl).toBeCloseTo(200 - 20.2, 10);
    expect(t.returnPct).toBeCloseTo(179.8 / 10_000, 10);
    expect(t.rMultiple).toBeCloseTo(179.8 / 100, 10);
    expect(r.metrics.netPnl).toBeCloseTo(179.8, 8);
    expect(r.metrics.fees).toBeCloseTo(20.2, 10);
    expect(r.equityCurve[r.equityCurve.length - 1].equity).toBeCloseTo(10_179.8, 8);
    expect(t.entryContext.costBps).toBeCloseTo(20);
    expect(t.entryContext.params.stopAtr).toBe(1);
    expect(t.mode).toBe("backtest");
  });

  it("建玉上限 (maxPositionPct) と lotSize で数量を丸める", () => {
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", 99.9, 101) : null));
    const r = runBacktest({
      strategy: s,
      instrument: { ...inst, lotSize: 0.5 },
      candles: bars(flatRows(20)),
      ...NO_COST,
      initialEquity: 10_000,
      riskPerTrade: 0.01,
      maxPositionPct: 0.2,
    });
    // リスク基準 1000 単位 → 上限 10000×0.2/100 = 20 単位
    expect(r.trades[0].qty).toBe(20);
  });

  it("sizer を差し替えられる", () => {
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", 99, 101) : null));
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(flatRows(20)), ...NO_COST, sizer: () => 3, maxPositionPct: 0 });
    expect(r.trades[0].qty).toBe(3);
  });

  it("postExitMovePct はエグジット後 N 本の方向付き値動き", () => {
    const rows = flatRows(40);
    rows[12] = [100, 101.5, 99.9, 101];
    for (let i = 13; i < 40; i++) rows[i] = [103, 103.2, 102.8, 103];
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position ? entrySignal("long", 99, 101) : null));
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(rows), ...NO_COST, postExitBars: 5 });
    expect(r.trades[0].exitReason).toBe("take_profit");
    expect(r.trades[0].postExitMovePct).toBeCloseTo((103 - 101) / 101);
  });

  it("intel は時刻の関数で渡せ、entryContext に記録される", () => {
    const calls: number[] = [];
    const s = scripted((ctx) => (ctx.market.now === closeOf(10) && !ctx.position && ctx.intel ? entrySignal("long", 99, 101) : null));
    const r = runBacktest({
      strategy: s,
      instrument: inst,
      candles: bars(flatRows(20)),
      ...NO_COST,
      intel: (ts) => {
        calls.push(ts);
        return { asset: "SYN", sentiment: 0.3, confidence: 1, eventRisk: 0, sourceIds: ["a"], sourceContrib: {} };
      },
    });
    expect(calls).toContain(closeOf(10));
    expect(r.trades[0].entryContext.intel?.sentiment).toBe(0.3);
  });

  it("tradeFromTs より前はウォームアップのみ", () => {
    let evals = 0;
    const s = scripted((ctx) => {
      evals++;
      expect(ctx.market.now).toBeGreaterThan(T0 + 10 * M);
      return null;
    });
    const r = runBacktest({ strategy: s, instrument: inst, candles: bars(flatRows(20)), tradeFromTs: T0 + 10 * M });
    expect(evals).toBe(9); // バー 10〜18 (最終バーは約定先が無いので判定しない)
    expect(r.equityCurve[0].ts).toBe(T0 + 10 * M);
  });
});

describe("その他", () => {
  it("基準足の時間足を推定する", () => {
    expect(inferTimeframe(bars(flatRows(5)))).toBe("1m");
    expect(() => inferTimeframe([{ ...bars(flatRows(1))[0] }, { ...bars(flatRows(1))[0], ts: T0 + 7_000 }])).toThrow();
  });

  it("基準足より細かい時間足を要求する戦略は例外", () => {
    const s = scripted(() => null, { primaryTimeframe: "1m", timeframes: ["1m"] });
    const c5 = resample(generateCandles({ seed: 1, bars: 100 }), "1m", "5m");
    expect(() => runBacktest({ strategy: s, instrument: inst, candles: c5, baseTimeframe: "5m" })).toThrow();
  });

  it("空データでも結果を返す", () => {
    const r = runBacktest({ strategy: scripted(() => null), instrument: inst, candles: [] });
    expect(r.trades).toEqual([]);
    expect(r.metrics.trades).toBe(0);
  });
});
