import type { Signal, Strategy, StrategyContext } from "../core/types";
import { atr, closesOf, ema, macd } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, positionSide } from "./common";

/** 中期戦略 (4h) */

/**
 * EMA20/50 の並び + MACD ヒストグラムの転換でトレンド方向へエントリー。
 * 手仕舞いは ATR トレーリング (trailAtr) が主体。EMA の逆転で flat。
 */
export const midTrendFollow: Strategy = {
  id: "mid_trend_follow",
  horizon: "mid",
  assetClasses: ["crypto", "fx", "stock"],
  regimes: ["trend_up", "trend_down"],
  primaryTimeframe: "4h",
  timeframes: ["4h"],
  warmup: 80,
  defaultParams: {
    stopAtr: 2.5,
    tpAtr: 6.0,
    trailAtr: 3.0,
    /** EMA20 と EMA50 の乖離 (ATR 単位) の下限 */
    entryThreshold: 0.3,
    maxHoldBars: 60,
  },
  paramBounds: {
    stopAtr: [1.5, 5],
    tpAtr: [3, 12],
    trailAtr: [0, 6],
    entryThreshold: [0, 2],
    maxHoldBars: [12, 180],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const c = candlesOf(ctx, "4h", 250);
    const n = c.length;
    if (n < midTrendFollow.warmup) return null;
    const p = ctx.params;
    const closes = closesOf(c);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const m = macd(closes, 12, 26, 9);
    const a = atr(c, 14)[n - 1];
    const i = n - 1;
    const close = closes[i];
    const sep = a > 0 ? (e20[i] - e50[i]) / a : 0;
    const features = { ema20: e20[i], ema50: e50[i], macdHist: m.hist[i], macd: m.macd[i], sepAtr: sep };

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && (e20[i] < e50[i] || (m.hist[i] < 0 && close < e50[i])))
        return exitSignal(ctx, midTrendFollow, 0.6, "EMA20/50 の逆転または MACD 悪化で EMA50 割れ", features);
      if (side === "short" && (e20[i] > e50[i] || (m.hist[i] > 0 && close > e50[i])))
        return exitSignal(ctx, midTrendFollow, 0.6, "EMA20/50 の逆転または MACD 改善で EMA50 超え", features);
      return null;
    }
    if (entryBlocked(ctx)) return null;
    const histUpCross = m.hist[i] > 0 && m.hist[i - 1] <= 0;
    const histDownCross = m.hist[i] < 0 && m.hist[i - 1] >= 0;
    const emaUpCross = e20[i] > e50[i] && e20[i - 1] <= e50[i - 1];
    const emaDownCross = e20[i] < e50[i] && e20[i - 1] >= e50[i - 1];
    const th = p.entryThreshold;

    let direction: "long" | "short" | null = null;
    if (sep >= th && close > e20[i] && m.hist[i] > 0 && (histUpCross || emaUpCross)) direction = "long";
    else if (-sep >= th && close < e20[i] && m.hist[i] < 0 && (histDownCross || emaDownCross)) direction = "short";
    if (!direction) return null;
    const confidence = 0.5 + 0.5 * clamp((Math.abs(sep) - th) / (th + 1));
    return buildEntrySignal({
      ctx,
      strategy: midTrendFollow,
      direction,
      confidence,
      atr: a,
      lastPrice: close,
      reason: `EMA20/50 ${direction === "long" ? "上昇" : "下降"}配列で MACD 転換 (乖離 ${sep.toFixed(2)} ATR)`,
      features,
    });
  },
};
