import type { Candle, Params, Signal, Strategy, StrategyContext } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atrLast } from "../indicators/series";
import { orderBookImbalance, tradeFlowImbalance } from "../indicators/microstructure";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, refPrice } from "./common";

/**
 * scalp_micro: 5〜10 分で利確・損切りを繰り返す超短期のモメンタム戦略 (主時間足 1m、成行 = taker)。
 *
 * エントリー (確定足のみ):
 *   1. 直近 lookbackBars 本 (3〜5 本) の高値 (安値) を確定足の終値でブレイクし、実体も同じ向き。
 *   2. 勢い: (終値 - lookbackBars 本前の終値) / ATR(14) が entryThreshold 以上 (同方向)。
 *   3. 出来高: 直近足の出来高が直前 volBars 本の平均の volMult 倍以上。
 *   4. 板の不均衡・約定フロー (取れたときだけ): 同方向なら confidence を加点、逆方向に強ければ見送り。
 *      板が取れない (REST 失敗・バックテスト) と完全に止まるのを避けるため requiresBook にはしない。
 *      requiresBook にすると毎ティック評価になり、同じ確定足で決済直後に再エントリーし得る点も避けたい。
 *
 * コストの条件 (すべて満たすときだけシグナルを出す):
 *   - 往復コスト = 2 × takerFeeRate + 現在のスプレッド比 + 2 × 想定スリッページ (片道 slippageBps)。
 *   - 利確幅 (tpAtr × ATR) ≥ costMult × 往復コスト。
 *   - 損切り幅 ≥ minStopSpreads × 現在のスプレッド (RiskManager の下限 2 倍より厳しく)。
 *   - 期待値 (下記) > 0。
 *
 * 期待値 (expectedEdgeBps): p × 利確 - (1 - p) × 損切り - 往復コスト (bps, コスト控除後)。
 *   - p0 = 損切り / (利確 + 損切り) は、値動きがランダムウォークのときに利確に先に届く確率
 *     (このとき p0 × 利確 - (1 - p0) × 損切り = 0 で、期待値はちょうど -往復コスト)。
 *   - p = p0 + winEdgeMax × s。s = (confidence - 0.5) / 0.5 (0〜1) はシグナルの強さ。
 *     confidence をそのまま勝率とみなさず、「ランダムウォーク + 最大 winEdgeMax (既定 10%pt) の上乗せ」に抑える。
 *     winEdgeMax は学習で上げられないよう paramBounds に入れない (期待値を自己申告で膨らませない)。
 *   - 既存戦略の expectedEdgeBps (利確幅 × confidence、手数料控除前) とは定義が違う。RiskManager は
 *     expectedEdgeBps ≥ MIN_EDGE_TO_COST × コストで判定するため、この戦略では実質「控除前の期待値 ≥ (1 + 比率) × コスト」
 *     となり、より厳しい側 (安全側) に働く。
 *
 * 保有: maxHoldBars (5〜10 本 = 5〜10 分) で時間切れ。エンジン/バックテストが成行で決済する。
 *   paramBounds 外の値が渡されても evaluate 内で 5〜10 にクランプし、maxHoldMs は必ず 10 分以内。
 *   損切り・利確・トレーリングはエンジン側。保有中は逆方向のバーストが出たときだけ flat を返す。
 *
 * クールダウン: エンジンには銘柄ごとのクールダウンがなく、StrategyContext に直近の決済情報もない (evaluate は純粋関数)。
 *   そこで、直前 cooldownBars 本のどれかで同方向のバースト条件が成立していたら見送る (シグナルの鮮度)。
 *   これで「損切り直後に同じ方向へ再エントリーを連発する」のを防ぐ。時間切れで決済した後 (5 本以上後) の
 *   新しいバーストはすぐに拾える。逆方向は止めない。
 *
 * 逆張り版は入れていない: 往復 0.24% (bitbank) を超える値幅を 10 分以内に逆張りで取る根拠が薄く、
 *   パラメータ面を増やすだけになるため。入れるなら別 id にする。
 *
 * 資産クラスは crypto のみ:
 *   - fx: 出来高がティック数で、出来高の急増の判定が当てにならない。
 *   - stock: 寄り付き・引けの非連続や空売り規制がある。
 *   - meme: スプレッド (合成で 60bps) が大きく、コストの条件をほぼ満たさない。
 */

/** 保有本数 (1m) の範囲。maxHoldMs を必ず 10 分以内にする */
export const SCALP_MICRO_HOLD_BOUNDS: readonly [number, number] = [5, 10];
/** 既定の勝率の上乗せの上限 (ランダムウォークの勝率 p0 に対して) */
export const DEFAULT_WIN_EDGE_MAX = 0.1;
/** ATR の期間 (1m) */
const ATR_PERIOD = 14;
/** 約定フローの集計窓 */
const FLOW_WINDOW_MS = 60_000;

/** 往復コスト (bps)。気配が無効なら undefined */
export function roundTripCostBps(takerFeeRate: number, bid: number, ask: number, slippageBps: number): number | undefined {
  if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(ask)) return undefined;
  const mid = (bid + ask) / 2;
  const spread = ((ask - bid) / mid) * 1e4;
  const fee = Math.max(0, Number.isFinite(takerFeeRate) ? takerFeeRate : 0) * 2 * 1e4;
  const slip = 2 * Math.max(0, Number.isFinite(slippageBps) ? slippageBps : 0);
  return fee + spread + slip;
}

/**
 * 勝率を仮定した期待値 (bps, コスト控除後)。
 * p0 = sl / (tp + sl) (ランダムウォークで利確が先に届く確率)、p = p0 + winEdgeMax × strength。
 */
export function microExpectedEdge(a: { tpBps: number; slBps: number; costBps: number; confidence: number; winEdgeMax: number }): {
  p0: number;
  p: number;
  edgeBps: number;
} {
  const { tpBps, slBps, costBps } = a;
  if (!(tpBps > 0) || !(slBps > 0)) return { p0: 0, p: 0, edgeBps: -Infinity };
  const p0 = slBps / (tpBps + slBps);
  const strength = clamp((a.confidence - 0.5) / 0.5);
  const p = clamp(p0 + Math.max(0, a.winEdgeMax) * strength, 0, 0.99);
  return { p0, p, edgeBps: p * tpBps - (1 - p) * slBps - costBps };
}

export interface Burst {
  direction: "long" | "short";
  /** 直近足の出来高 / 平均 */
  volRatio: number;
  /** (終値 - lookbackBars 本前の終値) / ATR (符号付き) */
  momentum: number;
  /** ブレイク幅 / ATR */
  breakAtr: number;
  atr: number;
  close: number;
}

/** バーストの判定に必要な最小本数 */
export function burstMinBars(p: Params): number {
  return Math.max(ATR_PERIOD + 1, period(p.lookbackBars, 2) + 1, period(p.volBars, 2) + 1);
}

/**
 * 末尾の確定足でのバースト (ブレイク + 勢い + 出来高) の判定。成立しなければ null。
 * 純粋関数。クールダウンの判定では末尾を切り詰めた配列で呼ぶ。
 */
export function detectBurst(c: readonly Candle[], p: Params): Burst | null {
  const n = c.length;
  if (n < burstMinBars(p)) return null;
  const lb = period(p.lookbackBars, 2);
  const vb = period(p.volBars, 2);
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
  if (!(volRatio >= p.volMult)) return null;
  const atr = atrLast(c, ATR_PERIOD);
  if (!(atr > 0) || !Number.isFinite(atr)) return null;
  const momentum = (cur.close - c[n - 1 - lb].close) / atr;
  const th = Math.max(0, p.entryThreshold);
  if (cur.close > hh && cur.close > cur.open && momentum >= th) {
    return { direction: "long", volRatio, momentum, breakAtr: (cur.close - hh) / atr, atr, close: cur.close };
  }
  if (cur.close < ll && cur.close < cur.open && momentum <= -th) {
    return { direction: "short", volRatio, momentum, breakAtr: (ll - cur.close) / atr, atr, close: cur.close };
  }
  return null;
}

/** 板の不均衡と約定フローの合成 (-1〜1)。どちらも取れなければ undefined */
function microScore(ctx: StrategyContext, depth: number): { score?: number; obi?: number; flow?: number } {
  const book = ctx.market.book;
  const obi = book && book.bids.length > 0 && book.asks.length > 0 ? orderBookImbalance(book, depth) : undefined;
  const prints = ctx.market.prints;
  const flow = prints && prints.length > 0 ? tradeFlowImbalance(prints, FLOW_WINDOW_MS, ctx.market.now) : undefined;
  if (obi === undefined && flow === undefined) return {};
  const score = obi !== undefined && flow !== undefined ? 0.6 * obi + 0.4 * flow : (obi ?? flow)!;
  return { score: clamp(score, -1, 1), obi, flow };
}

export interface ScalpMicroOptions {
  id?: string;
  /** 勝率の上乗せの上限 (既定 0.1)。診断用。学習では変えない */
  winEdgeMax?: number;
  /** 期待値 (コスト控除後, bps) の下限 (既定 0 = 正のときだけ出す)。診断用。学習では変えない */
  minNetEdgeBps?: number;
}

export function createScalpMicro(opts: ScalpMicroOptions = {}): Strategy {
  const winEdgeMax = opts.winEdgeMax ?? DEFAULT_WIN_EDGE_MAX;
  const minNetEdgeBps = opts.minNetEdgeBps ?? 0;
  const strategy: Strategy = {
    id: opts.id ?? "scalp_micro",
    horizon: "scalp",
    assetClasses: ["crypto"],
    regimes: ["trend_up", "trend_down", "high_vol"],
    primaryTimeframe: "1m",
    timeframes: ["1m"],
    warmup: 30,
    defaultParams: {
      /** 損切り幅 (ATR 倍)。1m の ATR は小さいので、スプレッドの数倍は確保する (minStopSpreads) */
      stopAtr: 1.2,
      /** 利確幅 (ATR 倍)。往復コストの costMult 倍以上が必要 */
      tpAtr: 2.0,
      /** トレーリングは既定で無効 (10 分以内の決済が前提で、利確・時間切れで十分) */
      trailAtr: 0,
      /** 勢い (ATR 倍) の閾値 */
      entryThreshold: 1.0,
      /** 最大保有本数 (1m)。5〜10 分 */
      maxHoldBars: 8,
      /** ブレイク判定の本数 (直近 3〜5 分) */
      lookbackBars: 4,
      /** 平均出来高の本数 */
      volBars: 20,
      /** 出来高倍率の閾値 */
      volMult: 2.0,
      /** 利確幅 / 往復コストの下限 (k) */
      costMult: 2.5,
      /** 想定スリッページ (片道 bps)。成行の滑りを保守的に見込む */
      slippageBps: 2,
      /** 損切り幅 / スプレッドの下限 */
      minStopSpreads: 4,
      /** 同方向の再エントリーを見送る本数 (1m) */
      cooldownBars: 2,
      /** 板の不均衡に使う段数 */
      bookDepth: 5,
      /** 板・フローがこれ以上逆向きなら見送る */
      microVeto: 0.4,
    },
    paramBounds: {
      stopAtr: [0.6, 3],
      tpAtr: [1, 5],
      trailAtr: [0, 2],
      entryThreshold: [0.5, 3],
      maxHoldBars: [SCALP_MICRO_HOLD_BOUNDS[0], SCALP_MICRO_HOLD_BOUNDS[1]],
      lookbackBars: [3, 5],
      volBars: [10, 60],
      volMult: [1.2, 5],
      // 下限 2: 学習でコストの条件を緩めすぎない
      costMult: [2, 5],
      slippageBps: [1, 20],
      minStopSpreads: [3, 10],
      cooldownBars: [1, 5],
      bookDepth: [1, 20],
      microVeto: [0.1, 1],
    },
    evaluate(ctx: StrategyContext): Signal | null {
      const p = ctx.params;
      const cd = Math.max(1, period(p.cooldownBars, 1));
      const c = candlesOf(ctx, "1m", burstMinBars(p) + cd + 40);
      if (c.length < Math.max(strategy.warmup, burstMinBars(p))) return null;
      const burst = detectBurst(c, p);
      const features: Record<string, number> = burst
        ? { volRatio: burst.volRatio, momentum: burst.momentum, breakAtr: burst.breakAtr }
        : {};

      const side = positionSide(ctx);
      if (side) {
        // 保有中: 逆方向のバーストで手仕舞い (利確・損切り・時間切れはエンジン側)
        if (burst && burst.direction !== side) {
          return exitSignal(ctx, strategy, 0.6, `逆方向のバースト (出来高 ${burst.volRatio.toFixed(1)} 倍)`, features);
        }
        return null;
      }
      if (!burst || entryBlocked(ctx)) return null;
      const dir = burst.direction;

      // クールダウン: 直前 cd 本で同方向のバーストが成立していたら見送る (損切り直後の連発を防ぐ)
      for (let k = 1; k <= cd; k++) {
        const prev = detectBurst(c.slice(0, c.length - k), p);
        if (prev && prev.direction === dir) return null;
      }

      // 板・約定フロー (任意の加点。逆向きに強ければ見送り)
      const sign = dir === "long" ? 1 : -1;
      const micro = microScore(ctx, period(p.bookDepth));
      const aligned = micro.score !== undefined ? sign * micro.score : 0;
      if (micro.score !== undefined && aligned <= -Math.abs(p.microVeto)) return null;

      const th = Math.max(1e-9, p.entryThreshold);
      const vm = Math.max(1e-9, p.volMult);
      const confidence =
        0.5 +
        0.2 * clamp((burst.volRatio - vm) / vm) +
        0.15 * clamp((Math.abs(burst.momentum) - th) / th) +
        0.15 * clamp(aligned);

      // コスト
      const q = ctx.market.quote;
      const costBps = roundTripCostBps(ctx.market.instrument.takerFeeRate, q?.bid ?? NaN, q?.ask ?? NaN, p.slippageBps);
      if (costBps === undefined) return null;
      const spread = q.ask - q.bid;

      const sig = buildEntrySignal({
        ctx,
        strategy,
        direction: dir,
        confidence,
        atr: burst.atr,
        lastPrice: burst.close,
        reason: `直近 ${period(p.lookbackBars, 2)} 本の${dir === "long" ? "高値" : "安値"}ブレイク / 出来高 ${burst.volRatio.toFixed(1)} 倍 / 勢い ${burst.momentum.toFixed(2)}ATR`,
        features: {
          ...features,
          ...(micro.obi !== undefined ? { obi: micro.obi } : {}),
          ...(micro.flow !== undefined ? { flow: micro.flow } : {}),
        },
      });
      if (!sig || sig.takeProfit === undefined) return null;

      const price = refPrice(ctx, dir, burst.close);
      const tpDist = Math.abs(sig.takeProfit - price);
      const slDist = Math.abs(price - sig.stopLoss);
      const tpBps = (tpDist / price) * 1e4;
      const slBps = (slDist / price) * 1e4;
      // 利確幅がコストの costMult 倍未満、または損切りがスプレッドに近すぎるなら出さない
      if (tpBps < Math.max(0, p.costMult) * costBps) return null;
      if (slDist < Math.max(0, p.minStopSpreads) * spread) return null;
      // インテルの補正後の confidence で勝率を推定する
      const ev = microExpectedEdge({ tpBps, slBps, costBps, confidence: sig.confidence, winEdgeMax });
      if (!(ev.edgeBps > minNetEdgeBps)) return null;

      const holdBars = Math.min(SCALP_MICRO_HOLD_BOUNDS[1], Math.max(SCALP_MICRO_HOLD_BOUNDS[0], period(p.maxHoldBars)));
      return {
        ...sig,
        expectedEdgeBps: ev.edgeBps,
        maxHoldMs: holdBars * TIMEFRAME_MS["1m"],
        features: { ...sig.features, costBps, tpBps, slBps, winProb: ev.p, winProbBase: ev.p0, netEdgeBps: ev.edgeBps },
      };
    },
  };
  return strategy;
}

/** 既定の scalp_micro */
export const scalpMicro: Strategy = createScalpMicro();
