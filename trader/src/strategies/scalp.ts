import type { Signal, Strategy, StrategyContext } from "../core/types";
import { atrLast, closesOf, rsiLast, stdevLast, vwapLast } from "../indicators/series";
import { microprice, orderBookImbalance, spreadBps, tradeFlowImbalance } from "../indicators/microstructure";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, volumeUnknown } from "./common";

/**
 * スキャルピング戦略 (主時間足 1m)。
 * 損切り・利確・トレーリング・時間切れはエンジン側で処理する。保有中は反転時のみ flat を返す。
 */

// ───────────────────────── scalp_obi ─────────────────────────

/** 板不均衡 + マイクロプライス乖離 + 約定フローの合成スコア (-1〜1) */
export const scalpObi: Strategy = {
  id: "scalp_obi",
  horizon: "scalp",
  assetClasses: ["crypto"],
  regimes: ["range", "trend_up", "trend_down", "high_vol"],
  requiresBook: true,
  primaryTimeframe: "1m",
  timeframes: ["1m"],
  warmup: 15,
  defaultParams: {
    stopAtr: 1.0,
    tpAtr: 1.5,
    trailAtr: 0,
    /** 合成スコアの閾値 */
    entryThreshold: 0.45,
    maxHoldBars: 5,
    /** 板不均衡に使う段数 */
    bookDepth: 5,
    /** 約定フローの集計窓 (秒) */
    flowWindowSec: 30,
  },
  paramBounds: {
    stopAtr: [0.5, 3],
    tpAtr: [0.5, 4],
    trailAtr: [0, 3],
    entryThreshold: [0.2, 0.9],
    maxHoldBars: [2, 30],
    bookDepth: [1, 20],
    flowWindowSec: [5, 120],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const book = ctx.market.book;
    if (!book || book.bids.length === 0 || book.asks.length === 0) return null;
    const c = candlesOf(ctx, "1m", 60);
    if (c.length < scalpObi.warmup) return null;
    const p = ctx.params;
    const th = p.entryThreshold;

    const bid = book.bids[0][0];
    const ask = book.asks[0][0];
    const mid = (bid + ask) / 2;
    const half = (ask - bid) / 2;
    const obi = orderBookImbalance(book, period(p.bookDepth));
    const mp = microprice(book);
    const microSkew = half > 0 && Number.isFinite(mp) ? clamp((mp - mid) / half, -1, 1) : 0;
    const prints = ctx.market.prints;
    const flow = prints && prints.length > 0 ? tradeFlowImbalance(prints, Math.max(1, p.flowWindowSec) * 1000, ctx.market.now) : 0;
    const score = 0.4 * obi + 0.3 * microSkew + 0.3 * flow;
    const atr = atrLast(c, 14);
    const features = { obi, microSkew, flow, score, spreadBps: spreadBps({ bid, ask }) };

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && score <= -th) return exitSignal(ctx, scalpObi, Math.abs(score), "板・フローが売り優勢に反転", features);
      if (side === "short" && score >= th) return exitSignal(ctx, scalpObi, Math.abs(score), "板・フローが買い優勢に反転", features);
      return null;
    }
    if (entryBlocked(ctx) || Math.abs(score) < th) return null;
    const direction = score > 0 ? "long" : "short";
    const confidence = 0.5 + 0.5 * clamp((Math.abs(score) - th) / Math.max(1e-9, 1 - th));
    return buildEntrySignal({
      ctx,
      strategy: scalpObi,
      direction,
      confidence,
      atr,
      lastPrice: mid,
      reason: `板不均衡 ${obi.toFixed(2)} / マイクロプライス ${microSkew.toFixed(2)} / フロー ${flow.toFixed(2)}`,
      features,
    });
  },
};

// ───────────────────────── scalp_vwap_revert ─────────────────────────

/** VWAP 乖離の z スコアと RSI(7) の極値で逆張り (レンジ向け) */
export const scalpVwapRevert: Strategy = {
  id: "scalp_vwap_revert",
  horizon: "scalp",
  assetClasses: ["crypto"],
  regimes: ["range"],
  primaryTimeframe: "1m",
  timeframes: ["1m"],
  warmup: 40,
  defaultParams: {
    stopAtr: 1.5,
    tpAtr: 1.2,
    trailAtr: 0,
    /** VWAP 乖離 z スコアの閾値 */
    entryThreshold: 2.0,
    maxHoldBars: 20,
    /** VWAP と標準偏差の窓 */
    vwapBars: 30,
    /** RSI(7) の極値 (ロングは < これ、ショートは > 100 - これ) */
    rsiExtreme: 25,
    /** これを超える ADX (トレンド) では入らない */
    maxAdx: 30,
  },
  paramBounds: {
    stopAtr: [0.5, 4],
    tpAtr: [0.5, 4],
    trailAtr: [0, 3],
    entryThreshold: [1, 3.5],
    maxHoldBars: [5, 60],
    vwapBars: [10, 120],
    rsiExtreme: [10, 40],
    maxAdx: [15, 50],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const vb = period(p.vwapBars, 5);
    const c = candlesOf(ctx, "1m", Math.max(120, vb + 20));
    if (c.length < Math.max(scalpVwapRevert.warmup, vb + 1)) return null;
    const closes = closesOf(c);
    const close = closes[closes.length - 1];
    const vwap = vwapLast(c, vb);
    const sd = stdevLast(closes, vb);
    const z = sd > 0 ? (close - vwap) / sd : 0;
    const r = rsiLast(closes, 7);
    const atr = atrLast(c, 14);
    const th = p.entryThreshold;
    const ext = p.rsiExtreme;
    const features = { z, rsi7: r, vwap, vwapDevPct: (close - vwap) / vwap, adx: ctx.regime.trendStrength };

    const overbought = z >= th && r >= 100 - ext;
    const oversold = z <= -th && r <= ext;
    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && overbought) return exitSignal(ctx, scalpVwapRevert, 0.6, "VWAP 上方乖離の極値 (反転)", features);
      if (side === "short" && oversold) return exitSignal(ctx, scalpVwapRevert, 0.6, "VWAP 下方乖離の極値 (反転)", features);
      return null;
    }
    if (entryBlocked(ctx) || ctx.regime.trendStrength > p.maxAdx) return null;
    if (!oversold && !overbought) return null;
    const direction = oversold ? "long" : "short";
    const rsiEdge = direction === "long" ? r : 100 - r;
    const confidence = 0.5 + 0.3 * clamp((Math.abs(z) - th) / th) + 0.2 * clamp((ext - rsiEdge) / ext);
    return buildEntrySignal({
      ctx,
      strategy: scalpVwapRevert,
      direction,
      confidence,
      atr,
      lastPrice: close,
      reason: `VWAP 乖離 z=${z.toFixed(2)} / RSI7=${r.toFixed(1)} の逆張り`,
      features,
    });
  },
};

// ───────────────────────── scalp_momentum_burst ─────────────────────────

/** 出来高急増 + 直近 N 本の高値/安値ブレイク (トレンド・高ボラ向け) */
export const scalpMomentumBurst: Strategy = {
  id: "scalp_momentum_burst",
  horizon: "scalp",
  assetClasses: ["crypto", "meme"],
  regimes: ["trend_up", "trend_down", "high_vol"],
  primaryTimeframe: "1m",
  timeframes: ["1m"],
  warmup: 30,
  defaultParams: {
    stopAtr: 1.0,
    tpAtr: 2.0,
    trailAtr: 1.0,
    /** 出来高倍率 (直近足 / 平均) の閾値 */
    entryThreshold: 2.5,
    maxHoldBars: 15,
    /** ブレイク判定の本数 */
    lookbackBars: 15,
    /** 平均出来高の本数 */
    volBars: 20,
  },
  paramBounds: {
    stopAtr: [0.5, 3],
    tpAtr: [1, 5],
    trailAtr: [0, 3],
    entryThreshold: [1.5, 6],
    maxHoldBars: [3, 60],
    lookbackBars: [5, 60],
    volBars: [10, 60],
  },
  evaluate(ctx: StrategyContext): Signal | null {
    const p = ctx.params;
    const lb = period(p.lookbackBars, 2);
    const vb = period(p.volBars, 2);
    const c = candlesOf(ctx, "1m", Math.max(lb, vb) + 20);
    const n = c.length;
    if (n < Math.max(scalpMomentumBurst.warmup, lb + 1, vb + 1)) return null;
    const cur = c[n - 1];
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = n - 1 - lb; i < n - 1; i++) {
      if (c[i].high > hh) hh = c[i].high;
      if (c[i].low < ll) ll = c[i].low;
    }
    let vsum = 0;
    for (let i = n - 1 - vb; i < n - 1; i++) vsum += c[i].volume;
    const volAvg = vsum / vb;
    const volRatio = volAvg > 0 ? cur.volume / volAvg : 0;
    const atr = atrLast(c, 14);
    const up = cur.close > hh && cur.close > cur.open;
    const down = cur.close < ll && cur.close < cur.open;
    const th = p.entryThreshold;
    const features = { volRatio, breakHigh: hh, breakLow: ll, bodyPct: (cur.close - cur.open) / cur.open };
    // 出来高が不明な足 (Jupiter の価格のポーリングの足) が判定の窓にあれば、出来高の条件は満たさない (fail-closed)
    const volOk = !volumeUnknown(c, n - 1 - vb, n - 1) && volRatio >= th;

    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && down && volOk) return exitSignal(ctx, scalpMomentumBurst, 0.6, "出来高を伴う下方ブレイク (反転)", features);
      if (side === "short" && up && volOk) return exitSignal(ctx, scalpMomentumBurst, 0.6, "出来高を伴う上方ブレイク (反転)", features);
      return null;
    }
    if (entryBlocked(ctx) || !volOk || (!up && !down)) return null;
    const direction = up ? "long" : "short";
    const breakDist = up ? cur.close - hh : ll - cur.close;
    const confidence = 0.4 + 0.3 * clamp((volRatio - th) / th) + 0.3 * clamp(atr > 0 ? breakDist / atr : 0);
    return buildEntrySignal({
      ctx,
      strategy: scalpMomentumBurst,
      direction,
      confidence,
      atr,
      lastPrice: cur.close,
      reason: `出来高 ${volRatio.toFixed(1)} 倍で直近 ${lb} 本の${up ? "高値" : "安値"}をブレイク`,
      features,
    });
  },
};
