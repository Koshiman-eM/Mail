import type { Signal, Strategy, StrategyContext } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atrLast, closesOf, emaLast, vwapLast } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide } from "./common";

/** ミームコイン戦略 */

/** 出来高の基準窓 = 直近 1 時間 (1m 足 60 本) */
const BASELINE_BARS = TIMEFRAME_MS["1h"] / TIMEFRAME_MS["1m"];

/**
 * 直近 1 時間の平均出来高に対する出来高急増 + VWAP より上 + 価格上昇 + インテルの sentiment が正。
 * ロングのみ。損切り近め・保有短め。5m 足があれば EMA9 より上であることも確認する。
 */
export const memeMomentum: Strategy = {
  id: "meme_momentum",
  horizon: "scalp",
  assetClasses: ["meme"],
  regimes: ["trend_up", "high_vol"],
  primaryTimeframe: "1m",
  timeframes: ["1m", "5m"],
  warmup: BASELINE_BARS + 10,
  defaultParams: {
    stopAtr: 0.8,
    tpAtr: 2.0,
    trailAtr: 0.8,
    /** 出来高倍率 (直近 burstBars 本の平均 / 直前 1 時間の平均) の閾値 */
    entryThreshold: 3.0,
    maxHoldBars: 20,
    /** 必要なインテル sentiment の下限 (常に 0 より大きいことも必要) */
    minSentiment: 0.1,
    /** 急増を測る直近本数 */
    burstBars: 3,
  },
  paramBounds: {
    stopAtr: [0.4, 2],
    tpAtr: [1, 5],
    trailAtr: [0, 2],
    entryThreshold: [1.5, 8],
    maxHoldBars: [3, 60],
    minSentiment: [0, 0.6],
    burstBars: [1, 10],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const burst = period(p.burstBars);
    const c = candlesOf(ctx, "1m", BASELINE_BARS + burst + 20);
    const n = c.length;
    if (n < Math.max(memeMomentum.warmup, BASELINE_BARS + burst + 1)) return null;
    let recent = 0;
    for (let i = n - burst; i < n; i++) recent += c[i].volume;
    let base = 0;
    for (let i = n - burst - BASELINE_BARS; i < n - burst; i++) base += c[i].volume;
    const recentAvg = recent / burst;
    const baseAvg = base / BASELINE_BARS;
    const volRatio = baseAvg > 0 ? recentAvg / baseAvg : 0;
    const vwap = vwapLast(c, BASELINE_BARS);
    const cur = c[n - 1];
    const priceUp = cur.close > c[n - 1 - burst].close;
    const sentiment = ctx.intel?.sentiment ?? 0;
    const a = atrLast(c, 14);

    // 5m 足の確認 (足りなければスキップ)
    const c5 = candlesOf(ctx, "5m", 60);
    const ema5 = c5.length >= 10 ? emaLast(closesOf(c5), 9) : NaN;
    const above5m = Number.isFinite(ema5) ? c5[c5.length - 1].close > ema5 : true;
    const features = { volRatio, vwap, vwapDevPct: (cur.close - vwap) / vwap, sentiment, above5mEma: above5m ? 1 : 0 };

    const side = positionSide(ctx);
    if (side) {
      const breakdown = cur.close < vwap && cur.close < cur.open && volRatio >= p.entryThreshold * 0.5;
      if (side === "long" && (breakdown || sentiment <= -0.3))
        return exitSignal(ctx, memeMomentum, 0.7, breakdown ? "出来高を伴って VWAP 割れ" : "センチメント悪化", features);
      return null;
    }
    if (entryBlocked(ctx)) return null;
    if (!(sentiment > 0) || sentiment < p.minSentiment) return null;
    if (volRatio < p.entryThreshold || !(cur.close > vwap) || !priceUp || !above5m) return null;
    const confidence = 0.4 + 0.3 * clamp((volRatio - p.entryThreshold) / p.entryThreshold) + 0.3 * clamp(sentiment);
    return buildEntrySignal({
      ctx,
      strategy: memeMomentum,
      direction: "long",
      confidence,
      atr: a,
      lastPrice: cur.close,
      reason: `出来高 ${volRatio.toFixed(1)} 倍 (対 1 時間平均) / VWAP 上 / sentiment ${sentiment.toFixed(2)}`,
      features,
    });
  },
};
