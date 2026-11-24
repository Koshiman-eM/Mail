import type { Candle, Signal, Strategy, StrategyContext } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atr, closesOf, donchian, ema } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide } from "./common";

/**
 * 中期のトレンドフォロー (4 時間足)。
 *
 * 流動性の高い暗号資産の 4 時間足〜日足の時系列モメンタム (トレンドフォロー) は、短い時間足のスキャルピングより
 * コストに対して期待値の余裕が大きい (4h の ATR は SOL で 2〜3% 程度、往復コストの数十倍)。
 *
 * - エントリー (買い): 最後の確定足の終値 > 直前の channelBars 本の高値の最高値 (ドンチャンの上抜け)
 *   かつ EMA(trendEma) が上向き (今の EMA > slopeBars 本前の EMA) かつ 終値 > EMA。
 *   売りは対称 (canShort のときだけ。Jupiter は空売りできないので実質は買いのみ)。
 * - 当初の損切り: 建値 − stopAtr × ATR(14)。利確なし。
 * - トレーリング (シャンデリア): エントリー後に確定した足の終値の最高値 − trailAtr × ATR(14) を確定足の終値が割ったら決済 (決済シグナル)。
 *   エンジンの汎用のトレーリング (trailingStopPct: 気配の最高値 × (1 − 幅)、幅はエントリー時の ATR で固定) は
 *   足の中のヒゲで動くため使わない (シグナルから外す)。判定は確定足の終値だけ。
 * - チャネルの決済: 終値 < 直前の exitBars 本の安値の最安値 (売りは逆)。
 * - 最大保有: maxHoldBars 本 (既定 180 本 = 30 日)。
 * - 期待値: 標準の buildEntrySignal (利確が無いので目安はトレーリング幅) → RiskManager の「期待値 ≥ 比 × コスト」がそのまま効く。
 * - managesOwnExit: 建値ストップ・転換で決済・読みの管理・最大保有の上限 (MAX_HOLD_MINUTES) を掛けない (src/core/types.ts の Strategy)。
 * - 相場構造のフィルター (DEFAULT_STRUCTURE_STRATEGIES) には入れない (自前のトレンドの判定 (EMA の傾き) を持つ)。
 *
 * 足は確定足だけ (先読みなし)。エントリー後に確定した足がまだ無ければ決済の判定をしない (エントリー前の足で決済しない)。
 * 1 つの評価に使う足の本数は固定 (TREND_HISTORY_BARS) にして、EMA の初期値の違いで運用とバックテストの判定がずれないようにする。
 */

/** 評価に使う 4 時間足の本数 (MarketHub・バックテストが保持する 300 本に合わせる) */
export const TREND_HISTORY_BARS = 300;

/** パラメータに応じた必要な本数 (max(チャネル, EMA + 傾き) + 20) */
export function trendWarmupBars(channelBars: number, trendEma: number, slopeBars: number): number {
  return Math.max(channelBars, trendEma + slopeBars) + 20;
}

/** エントリー後に確定した足 (終値の時刻 = 開始 + 足の幅 がエントリーより後) */
function barsSinceEntry(c: readonly Candle[], openedAt: number, tfMs: number): Candle[] {
  return c.filter((b) => b.ts + tfMs > openedAt);
}

export const trend4h: Strategy = {
  id: "trend_4h",
  horizon: "mid",
  assetClasses: ["crypto"],
  // 方向は戦略の中で決める (EMA の傾き・チャネル)。低流動性では entryBlocked で入らない
  regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
  primaryTimeframe: "4h",
  timeframes: ["4h"],
  warmup: trendWarmupBars(20, 50, 6),
  managesOwnExit: true,
  defaultParams: {
    stopAtr: 2.5,
    trailAtr: 3.0,
    maxHoldBars: 180,
    /** エントリー用のチャネルの本数 (20 本 ≈ 3.3 日) */
    channelBars: 20,
    /** 決済用のチャネルの本数 */
    exitBars: 10,
    /** トレンドの EMA の期間 */
    trendEma: 50,
    /** EMA の傾きを測る本数 */
    slopeBars: 6,
  },
  paramBounds: {
    stopAtr: [1.5, 5],
    trailAtr: [1.5, 6],
    maxHoldBars: [30, 360],
    channelBars: [10, 60],
    exitBars: [5, 30],
    trendEma: [20, 100],
    slopeBars: [2, 20],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const ch = period(p.channelBars, 2);
    const ex = period(p.exitBars, 2);
    const emaP = period(p.trendEma, 2);
    const sl = period(p.slopeBars, 1);
    const need = trendWarmupBars(ch, emaP, sl);
    const c = candlesOf(ctx, "4h", Math.max(TREND_HISTORY_BARS, need));
    const n = c.length;
    if (n < need) return null;
    const i = n - 1;
    const cur = c[i];
    const closes = closesOf(c);
    const e = ema(closes, emaP);
    const a = atr(c, 14)[i];
    const entryCh = donchian(c, ch);
    const exitCh = donchian(c, ex);
    const upperPrev = entryCh.upper[i - 1];
    const lowerPrev = entryCh.lower[i - 1];
    const emaNow = e[i];
    const emaPast = e[i - sl];
    if (![a, upperPrev, lowerPrev, emaNow, emaPast].every(Number.isFinite) || !(a > 0)) return null;
    const features: Record<string, number> = {
      ema: emaNow, emaSlopeAtr: (emaNow - emaPast) / a, channelHigh: upperPrev, channelLow: lowerPrev, atr4h: a,
    };

    const side = positionSide(ctx);
    if (side) {
      const pos = ctx.position!;
      const after = barsSinceEntry(c, pos.openedAt, TIMEFRAME_MS["4h"]);
      // エントリー後に確定した足が無ければ判定しない (エントリー前の足で決済しない)
      if (after.length === 0) return null;
      const trail = Math.max(0, p.trailAtr ?? 0) * a;
      const exitLow = exitCh.lower[i - 1];
      const exitHigh = exitCh.upper[i - 1];
      if (side === "long") {
        const hc = Math.max(...after.map((b) => b.close));
        const level = hc - trail;
        const f = { ...features, chandelier: level, highestClose: hc, exitChannel: exitLow };
        if (trail > 0 && cur.close < level) return exitSignal(ctx, trend4h, 0.6, `シャンデリア (終値の最高値 − ${p.trailAtr} ATR) を割り込み`, f);
        if (Number.isFinite(exitLow) && cur.close < exitLow) return exitSignal(ctx, trend4h, 0.6, `直近 ${ex} 本の安値を割り込み`, f);
        return null;
      }
      const lc = Math.min(...after.map((b) => b.close));
      const level = lc + trail;
      const f = { ...features, chandelier: level, lowestClose: lc, exitChannel: exitHigh };
      if (trail > 0 && cur.close > level) return exitSignal(ctx, trend4h, 0.6, `シャンデリア (終値の最安値 + ${p.trailAtr} ATR) を上抜け`, f);
      if (Number.isFinite(exitHigh) && cur.close > exitHigh) return exitSignal(ctx, trend4h, 0.6, `直近 ${ex} 本の高値を上抜け`, f);
      return null;
    }

    if (entryBlocked(ctx)) return null;
    let direction: "long" | "short" | null = null;
    if (cur.close > upperPrev && emaNow > emaPast && cur.close > emaNow) direction = "long";
    else if (cur.close < lowerPrev && emaNow < emaPast && cur.close < emaNow) direction = "short";
    if (!direction) return null;
    const breakDist = direction === "long" ? cur.close - upperPrev : lowerPrev - cur.close;
    const confidence = 0.5 + 0.25 * clamp(breakDist / a) + 0.25 * clamp(Math.abs(emaNow - emaPast) / a);
    const sig = buildEntrySignal({
      ctx,
      strategy: trend4h,
      direction,
      confidence,
      atr: a,
      lastPrice: cur.close,
      reason: `4 時間足のドンチャン ${ch} 本の${direction === "long" ? "上抜け" : "下抜け"} + EMA${emaP} が${direction === "long" ? "上向き" : "下向き"}`,
      features,
    });
    if (!sig) return null;
    // トレーリングは確定足の終値のシャンデリア (決済シグナル) で行う。汎用のトレーリング (気配の極値) は付けない
    const { trailingStopPct: _unused, ...rest } = sig;
    return rest;
  },
};
