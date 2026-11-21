import type { Signal, Strategy, StrategyContext } from "../core/types";
import { adx, atr, bollinger, closesOf, donchian, ema, rsi, sma, volumesOf } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, volumeUnknown, VOLUME_WINDOW_BARS } from "./common";

/** 短期戦略 (5m/15m/1h) */

// ───────────────────────── short_ema_trend ─────────────────────────

/** EMA9/21 の並び + ADX フィルターで、押し目 (戻り) からの再開でエントリー */
export const shortEmaTrend: Strategy = {
  id: "short_ema_trend",
  horizon: "short",
  // meme: Jupiter のミームコイン (板・出来高を使わない戦略。腕のキーに資産クラスが入るので crypto と学習を分ける)
  assetClasses: ["crypto", "meme"],
  regimes: ["trend_up", "trend_down"],
  primaryTimeframe: "15m",
  timeframes: ["15m"],
  warmup: 60,
  defaultParams: {
    stopAtr: 1.5,
    tpAtr: 3.0,
    trailAtr: 2.0,
    /** ADX の下限 */
    entryThreshold: 20,
    maxHoldBars: 48,
  },
  paramBounds: {
    stopAtr: [0.8, 4],
    tpAtr: [1, 6],
    trailAtr: [0, 5],
    entryThreshold: [12, 40],
    maxHoldBars: [8, 192],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const c = candlesOf(ctx, "15m", 200);
    const n = c.length;
    if (n < shortEmaTrend.warmup) return null;
    const p = ctx.params;
    const closes = closesOf(c);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const dmi = adx(c, 14);
    const a = atr(c, 14)[n - 1];
    const i = n - 1;
    const cur = c[i];
    const prevBar = c[i - 1];
    const adxV = dmi.adx[i];
    const features = { ema9: e9[i], ema21: e21[i], adx: adxV, plusDI: dmi.plusDI[i], minusDI: dmi.minusDI[i] };

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && e9[i] < e21[i]) return exitSignal(ctx, shortEmaTrend, 0.6, "EMA9 が EMA21 を下抜け", features);
      if (side === "short" && e9[i] > e21[i]) return exitSignal(ctx, shortEmaTrend, 0.6, "EMA9 が EMA21 を上抜け", features);
      return null;
    }
    if (entryBlocked(ctx) || !(adxV >= p.entryThreshold)) return null;

    const upTrend = e9[i] > e21[i] && dmi.plusDI[i] > dmi.minusDI[i];
    const downTrend = e9[i] < e21[i] && dmi.minusDI[i] > dmi.plusDI[i];
    // 押し目: 直近 2 本のどちらかの安値が EMA9 に触れ、現在足が陽線で EMA9 の上で引けた
    const pullbackLong =
      (prevBar.low <= e9[i - 1] || cur.low <= e9[i]) && cur.close > e9[i] && cur.close > cur.open && cur.close > e21[i];
    const pullbackShort =
      (prevBar.high >= e9[i - 1] || cur.high >= e9[i]) && cur.close < e9[i] && cur.close < cur.open && cur.close < e21[i];

    let direction: "long" | "short" | null = null;
    if (upTrend && pullbackLong) direction = "long";
    else if (downTrend && pullbackShort) direction = "short";
    if (!direction) return null;
    const confidence = 0.5 + 0.5 * clamp((adxV - p.entryThreshold) / 25);
    return buildEntrySignal({
      ctx,
      strategy: shortEmaTrend,
      direction,
      confidence,
      atr: a,
      lastPrice: cur.close,
      reason: `EMA9/21 ${direction === "long" ? "上昇" : "下降"}トレンドの${direction === "long" ? "押し目" : "戻り"} (ADX ${adxV.toFixed(1)})`,
      features,
    });
  },
};

// ───────────────────────── short_rsi_revert ─────────────────────────

/** RSI14 + ボリンジャーバンドの逆張り (レンジ向け) */
export const shortRsiRevert: Strategy = {
  id: "short_rsi_revert",
  horizon: "short",
  // meme: Jupiter のミームコイン (板・出来高を使わない戦略。腕のキーに資産クラスが入るので crypto と学習を分ける)
  assetClasses: ["crypto", "meme"],
  regimes: ["range"],
  primaryTimeframe: "15m",
  timeframes: ["15m"],
  warmup: 40,
  defaultParams: {
    stopAtr: 1.5,
    tpAtr: 2.0,
    trailAtr: 0,
    /** ボリンジャーの σ 倍率 */
    entryThreshold: 2.0,
    maxHoldBars: 24,
    /** RSI の極値 (ロングは <= これ、ショートは >= 100 - これ) */
    rsiExtreme: 30,
    /** これを超える ADX では入らない */
    maxAdx: 25,
  },
  paramBounds: {
    stopAtr: [0.8, 4],
    tpAtr: [1, 5],
    trailAtr: [0, 4],
    entryThreshold: [1.5, 3],
    maxHoldBars: [4, 96],
    rsiExtreme: [15, 40],
    maxAdx: [15, 45],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const c = candlesOf(ctx, "15m", 150);
    const n = c.length;
    if (n < shortRsiRevert.warmup) return null;
    const p = ctx.params;
    const closes = closesOf(c);
    const r = rsi(closes, 14)[n - 1];
    const bb = bollinger(closes, 20, p.entryThreshold);
    const a = atr(c, 14)[n - 1];
    const close = closes[n - 1];
    const upper = bb.upper[n - 1];
    const lower = bb.lower[n - 1];
    const ext = p.rsiExtreme;
    const features = { rsi14: r, percentB: bb.percentB[n - 1], bandwidth: bb.bandwidth[n - 1], adx: ctx.regime.trendStrength };

    const oversold = close <= lower && r <= ext;
    const overbought = close >= upper && r >= 100 - ext;
    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && overbought) return exitSignal(ctx, shortRsiRevert, 0.6, "上限バンド + RSI 買われ過ぎ (反転)", features);
      if (side === "short" && oversold) return exitSignal(ctx, shortRsiRevert, 0.6, "下限バンド + RSI 売られ過ぎ (反転)", features);
      return null;
    }
    if (entryBlocked(ctx) || ctx.regime.trendStrength > p.maxAdx) return null;
    if (!oversold && !overbought) return null;
    const direction = oversold ? "long" : "short";
    const beyond = direction === "long" ? lower - close : close - upper;
    const rsiEdge = direction === "long" ? r : 100 - r;
    const confidence = 0.5 + 0.25 * clamp(a > 0 ? beyond / a : 0) + 0.25 * clamp((ext - rsiEdge) / ext);
    return buildEntrySignal({
      ctx,
      strategy: shortRsiRevert,
      direction,
      confidence,
      atr: a,
      lastPrice: close,
      reason: `RSI14=${r.toFixed(1)} でボリンジャー${direction === "long" ? "下限" : "上限"}を突破 (逆張り)`,
      features,
    });
  },
};

// ───────────────────────── short_breakout ─────────────────────────

/** ドンチャンチャネルのブレイク + 出来高確認 */
export const shortBreakout: Strategy = {
  id: "short_breakout",
  horizon: "short",
  assetClasses: ["crypto"],
  regimes: ["trend_up", "trend_down", "high_vol"],
  // 出来高が後から分かる feed (Jupiter) では、出来高が分かるまで同じ足の評価を待つ (エンジンが取り直す)
  needsVolume: true,
  primaryTimeframe: "1h",
  timeframes: ["1h"],
  warmup: 30,
  defaultParams: {
    stopAtr: 2.0,
    tpAtr: 4.0,
    trailAtr: 2.5,
    /** 出来高倍率 (現在足 / 20 本平均) の閾値 */
    entryThreshold: 1.5,
    maxHoldBars: 24,
    /** エントリー用チャネル本数 */
    channelBars: 20,
    /** 反転判定 (エグジット) 用チャネル本数 */
    exitBars: 10,
  },
  paramBounds: {
    stopAtr: [1, 4],
    tpAtr: [2, 8],
    trailAtr: [0, 5],
    entryThreshold: [1, 3],
    maxHoldBars: [6, 96],
    channelBars: [10, 55],
    exitBars: [5, 30],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const ch = period(p.channelBars, 2);
    const ex = period(p.exitBars, 2);
    const c = candlesOf(ctx, "1h", Math.max(150, ch + 30));
    const n = c.length;
    if (n < Math.max(shortBreakout.warmup, ch + 2, ex + 2, 22)) return null;
    const cur = c[n - 1];
    const entryCh = donchian(c, ch);
    const exitCh = donchian(c, ex);
    const upperPrev = entryCh.upper[n - 2];
    const lowerPrev = entryCh.lower[n - 2];
    const volAvg = sma(volumesOf(c), 20)[n - 2];
    const volRatio = volAvg > 0 ? cur.volume / volAvg : 0;
    const a = atr(c, 14)[n - 1];
    const features = { volRatio, channelHigh: upperPrev, channelLow: lowerPrev, channelWidthPct: (upperPrev - lowerPrev) / cur.close };

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && cur.close < exitCh.lower[n - 2]) return exitSignal(ctx, shortBreakout, 0.6, `直近 ${ex} 本の安値を割り込み`, features);
      if (side === "short" && cur.close > exitCh.upper[n - 2]) return exitSignal(ctx, shortBreakout, 0.6, `直近 ${ex} 本の高値を上抜け`, features);
      return null;
    }
    // 出来高の平均の窓 (直前の 20 本) か今の足に出来高が不明な足 (Jupiter の価格のポーリングの足) があれば入らない (fail-closed)
    if (entryBlocked(ctx) || volumeUnknown(c, n - VOLUME_WINDOW_BARS, n - 1) || volRatio < p.entryThreshold) return null;
    let direction: "long" | "short" | null = null;
    if (cur.close > upperPrev) direction = "long";
    else if (cur.close < lowerPrev) direction = "short";
    if (!direction) return null;
    const breakDist = direction === "long" ? cur.close - upperPrev : lowerPrev - cur.close;
    const confidence = 0.5 + 0.25 * clamp((volRatio - p.entryThreshold) / p.entryThreshold) + 0.25 * clamp(a > 0 ? breakDist / a : 0);
    return buildEntrySignal({
      ctx,
      strategy: shortBreakout,
      direction,
      confidence,
      atr: a,
      lastPrice: cur.close,
      reason: `ドンチャン ${ch} 本の${direction === "long" ? "上抜け" : "下抜け"} (出来高 ${volRatio.toFixed(1)} 倍)`,
      features,
    });
  },
};
