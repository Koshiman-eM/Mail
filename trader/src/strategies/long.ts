import type { Signal, Strategy, StrategyContext } from "../core/types";
import { atrLast, closesOf, smaLast } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide } from "./common";

/** 長期戦略 (1d) */

/**
 * 90 日モメンタム + 200 日 SMA フィルター。ロング中心。
 * ショートは allowShort かつ「閾値 × shortThresholdMult」以上の下落モメンタムで SMA200 の下にあるときのみ。
 */
export const longMomentum: Strategy = {
  id: "long_momentum",
  horizon: "long",
  assetClasses: ["crypto", "fx", "stock"],
  regimes: ["trend_up", "trend_down"],
  primaryTimeframe: "1d",
  timeframes: ["1d"],
  warmup: 201,
  defaultParams: {
    stopAtr: 3.0,
    tpAtr: 8.0,
    trailAtr: 4.0,
    /** モメンタム (lookbackBars 本前比の騰落率) の閾値 */
    entryThreshold: 0.1,
    maxHoldBars: 60,
    lookbackBars: 90,
    /** ショートに必要な閾値の倍率 (ロング中心のため厳しめ) */
    shortThresholdMult: 2,
  },
  paramBounds: {
    stopAtr: [1.5, 6],
    tpAtr: [3, 15],
    trailAtr: [0, 8],
    entryThreshold: [0, 0.5],
    maxHoldBars: [10, 250],
    lookbackBars: [30, 180],
    shortThresholdMult: [1, 4],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const lb = period(p.lookbackBars, 2);
    const c = candlesOf(ctx, "1d", Math.max(260, lb + 1));
    const n = c.length;
    if (n < Math.max(longMomentum.warmup, lb + 1)) return null;
    const closes = closesOf(c);
    const close = closes[n - 1];
    const base = closes[n - 1 - lb];
    const mom = base > 0 ? close / base - 1 : 0;
    const s200 = smaLast(closes, 200);
    const a = atrLast(c, 14);
    const features = { momentum: mom, sma200: s200, distSma200Pct: (close - s200) / s200 };

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && (close < s200 || mom < 0)) return exitSignal(ctx, longMomentum, 0.6, "SMA200 割れまたはモメンタム消失", features);
      if (side === "short" && (close > s200 || mom > 0)) return exitSignal(ctx, longMomentum, 0.6, "SMA200 回復またはモメンタム好転", features);
      return null;
    }
    if (entryBlocked(ctx)) return null;
    const th = p.entryThreshold;
    let direction: "long" | "short" | null = null;
    if (mom >= th && close > s200) direction = "long";
    else if (mom <= -th * Math.max(1, p.shortThresholdMult) && close < s200) direction = "short";
    if (!direction) return null;
    const confidence = 0.5 + 0.5 * clamp((Math.abs(mom) - th) / (th + 0.2));
    return buildEntrySignal({
      ctx,
      strategy: longMomentum,
      direction,
      confidence,
      atr: a,
      lastPrice: close,
      reason: `${lb} 日モメンタム ${(mom * 100).toFixed(1)}% / SMA200 ${direction === "long" ? "上" : "下"}`,
      features,
    });
  },
};
