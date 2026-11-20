import type { Candle, Params, Signal, Strategy, StrategyContext } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atr, closesOf, ema, rsi } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, refPrice } from "./common";
import { DEFAULT_WIN_EDGE_MAX, microExpectedEdge, roundTripCostBps } from "./scalpMicro";
import { clampTempo, relaxToward, TEMPO_COST_MULT_FLOOR, tempoNetEdgeFloor } from "../engine/tempo";

/**
 * scalp_pullback: 15m のトレンドの向きに、1m の押し目で買い・戻りで売る順張りのスキャルピング
 * (主時間足 1m、上位足 15m、売り買い両方)。
 *
 * 狙い: GMOコインのレバレッジ取引 (売りから建てられる・手数料ほぼ 0、コスト ≈ スプレッド + 滑り) で、
 *   おおむね 10 分に 1 回のエントリーと 30 分以内の決済を目指す。トレンドの中の短い逆行 (押し・戻り) が
 *   終わってトレンド方向へ動き出したところで入り、直近の押し・戻りの外側に損切りを置いて R 倍で利確する。
 *
 * 上位足 (15m) の条件: トレンドの向きを戦略の中で自前で判定する。
 *   - 15m の EMA(20) の傾き (trendSlopeBars 本前との差 / 本数, 価格比 bps) の符号が向き。
 *     |傾き| ≥ minTrendSlopeBps で、15m の末尾の終値が EMA と同じ側 (上昇なら上、下降なら下) にあること。
 *   - 上昇なら買いだけ、下降なら売りだけ。主時間足 (1m) のレジーム判定は押し・戻りの局面で range / high_vol に
 *     振れやすいので、regimes は trend_up / trend_down / high_vol / range とし、向きは 15m で決める。
 *
 * エントリー (1m の確定足のみ。売りの場合。買いは上下を反転):
 *   1. 戻り: 引き金の足の直前 pullbackBars 本 (窓) の RSI(7) の最大値 ≥ 50 + entryThreshold。
 *   2. 平均への接近: 窓のどれかの足の高値が、その足の 1m の EMA(20) - touchAtr × ATR(14) 以上
 *      (戻りが 1m の短期平均まで届いた)。
 *   3. 引き金 (末尾の確定足): 陰線、終値が直前の足の安値より下、RSI(7) が窓の最大値 - 5 以下 (戻りの勢いが落ちた)。
 *   4. 末尾の 1m の終値が 15m の EMA(20) の最後の値よりまだ下 (トレンドの側に残っている)。
 *   出来高 (直前 volBars 本の平均に対する倍率) が増えていれば confidence を加点する (必須にはしない)。
 *
 * 決済:
 *   - 損切り: 売りは窓 (と引き金の足) の最高値 + stopAtr × ATR、買いは最安値 - stopAtr × ATR。
 *     エントリー価格からの距離が PULLBACK_MIN_STOP_ATR (0.8 ATR) 未満ならそこまで広げ、
 *     PULLBACK_MAX_STOP_ATR (3.5 ATR) を超えるなら見送る (リスクが広すぎる)。
 *   - 利確: 損切り幅 × tpR (既定 2R)。どちらも標準の buildEntrySignal に、エントリー価格からの ATR 倍
 *     (実効の損切り幅・利確幅。パラメータの stopAtr ではなく計算後の値) で渡す。
 *   - 最大保有: maxHoldBars (1m で 10〜30 本)。paramBounds 外の値も evaluate 内でクランプし、maxHoldMs は必ず 30 分以内。
 *     トレーリングは既定で無効。
 *   - 保有中は 15m の末尾の終値が EMA(20) の反対側に抜けたら (トレンドの崩れ) flat を返す。
 *     損切り・利確・時間切れはエンジン側。
 *
 * コストの条件 (scalp_micro と同じ。すべて満たすときだけシグナルを出す):
 *   - 往復コスト = 2 × takerFeeRate + 現在のスプレッド比 + 2 × 想定スリッページ (片道 slippageBps)。
 *   - 利確幅 ≥ costMult × 往復コスト、損切り幅 ≥ minStopSpreads × スプレッド、期待値 > minNetEdgeBps (既定 0)。
 *   - 見送ったシグナルは ctx.onFiltered で観測用に通知する (理由: cost / spread / edge)。戻り値は null。
 *
 * 期待値 (expectedEdgeBps): scalp_micro の microExpectedEdge を使う (コスト控除後。シグナルに edgeIsNet: true を付ける)。
 *   ランダムウォークの勝率 p0 = 損切り / (利確 + 損切り) に、シグナルの強さに応じて最大 winEdgeMax (既定 10%pt) を
 *   上乗せした p で、p × 利確 - (1 - p) × 損切り - 往復コスト (bps)。winEdgeMax は paramBounds に入れない (学習で上げない)。
 *   confidence = 0.5 + 0.2 × 15m の傾きの強さ + 0.15 × RSI の行き過ぎ + 0.15 × 出来高の増加 (強さはテンポで緩める前の閾値で測る)。
 *
 * テンポ (ctx.tempo、0〜1。エントリー頻度の目標に届かないときにエンジンが上げる。省略時 0):
 *   緩めるのは次の 4 つだけ (t = tempo)。
 *   - entryThreshold × (1 - 0.5t)、minTrendSlopeBps × (1 - 0.5t)、touchAtr + 0.5t、
 *     costMult - t × (costMult - TEMPO_COST_MULT_FLOOR) (1.5 より下にはしない。設定がもともと 1.5 未満なら設定のまま)。
 *   - 期待値 > minNetEdgeBps (コスト控除後) とクールダウン・損切り幅の上下限・最大保有は緩めない。
 *     例外は探索 (ctx.tempoExplore が true のときだけ): 期待値の下限を tempoNetEdgeFloor (minNetEdgeBps - tempo × 往復コスト) に下げる。
 *     tempoExplore が無い・false なら従来どおり。
 *   - 使ったテンポと実効の閾値は features に記録する。
 *
 * クールダウン: 直前 cooldownBars 本のどれかでも同じ向きの条件が成立していたら見送る (同じ押し・戻りでの連続エントリーを防ぐ)。
 *
 * パラメータ名は ParamTuner が扱えるよう標準名にそろえる: stopAtr = 押し・戻りの端の外側に置く損切りの余裕 (ATR 倍)、
 * entryThreshold = 押し・戻りとみなす RSI(7) の 50 からの幅 (大きいほど厳しい)。tpR・maxHoldBars・trailAtr はそのまま。
 *
 * 売りは buildEntrySignal の canShort (取引所の allowShort、paper では空売りの再現) で判定する。
 * 資産クラスは crypto のみ (scalp_micro と同じ理由)。
 */

/** 保有本数 (1m) の範囲。maxHoldMs を 10〜30 分にする */
export const SCALP_PULLBACK_HOLD_BOUNDS: readonly [number, number] = [10, 30];
/** 損切り幅 (エントリー価格から, ATR 倍) の下限。押し・戻りの端が近すぎるときはここまで広げる */
export const PULLBACK_MIN_STOP_ATR = 0.8;
/** 損切り幅 (ATR 倍) の上限。押し・戻りの端が遠すぎる (超えたら見送る) */
export const PULLBACK_MAX_STOP_ATR = 3.5;
/** 引き金の足の RSI が窓の極値から戻っている幅 (RSI のポイント) */
export const PULLBACK_RSI_TURN = 5;
/** 1m の ATR の期間 */
const ATR_PERIOD = 14;
/** 1m の RSI の期間 */
const RSI_PERIOD = 7;
/** 1m の短期平均 (EMA) の期間 */
const MEAN_EMA = 20;
/** 15m のトレンド判定の EMA の期間 */
const TREND_EMA = 20;

/** テンポを反映した実効の閾値 */
export interface PullbackThresholds {
  /** 0〜1 に収めたテンポ */
  tempo: number;
  entryThreshold: number;
  minTrendSlopeBps: number;
  touchAtr: number;
  costMult: number;
}

/** テンポ (0〜1、省略時 0) で緩めた実効の閾値。tempo 0 なら設定値そのもの。純粋関数 */
export function pullbackThresholds(p: Params, tempo?: number): PullbackThresholds {
  const t = clampTempo(tempo);
  return {
    tempo: t,
    entryThreshold: Math.max(0, p.entryThreshold) * (1 - 0.5 * t),
    minTrendSlopeBps: Math.max(0, p.minTrendSlopeBps) * (1 - 0.5 * t),
    touchAtr: Math.max(0, p.touchAtr) + 0.5 * t,
    costMult: relaxToward(p.costMult, TEMPO_COST_MULT_FLOOR, t),
  };
}

export interface Trend15m {
  direction: "long" | "short";
  /** 15m の EMA(20) の傾き (1 本あたり, bps, 符号付き) */
  slopeBps: number;
  /** 15m の終値の EMA(20) からの乖離 (bps, 符号付き) */
  gapBps: number;
  /** 15m の EMA(20) の最後の値 */
  ema: number;
}

/** 15m の判定に必要な最小本数 */
export function pullbackMinTrendBars(p: Params): number {
  return TREND_EMA + period(p.trendSlopeBars, 1);
}

/** 1m の判定に必要な最小本数 */
export function pullbackMinBars(p: Params): number {
  const pb = period(p.pullbackBars, 2);
  return Math.max(MEAN_EMA + pb + 1, RSI_PERIOD + pb + 2, ATR_PERIOD + 1, period(p.volBars, 2) + 1);
}

/** 15m の末尾の終値と EMA(20) (足りなければ null) */
function last15m(c15: readonly Candle[]): { close: number; ema: number } | null {
  if (c15.length < TREND_EMA) return null;
  const e = ema(closesOf(c15), TREND_EMA)[c15.length - 1];
  const close = c15[c15.length - 1].close;
  if (!Number.isFinite(e) || !(e > 0) || !Number.isFinite(close)) return null;
  return { close, ema: e };
}

/**
 * 15m の確定足でのトレンドの向き。|傾き| ≥ minSlopeBps かつ終値が EMA(20) の同じ側なら成立、しなければ null。
 * minSlopeBps の省略時は p.minTrendSlopeBps (テンポで緩めない値)。純粋関数
 */
export function trend15m(c15: readonly Candle[], p: Params, minSlopeBps: number = Math.max(0, p.minTrendSlopeBps)): Trend15m | null {
  const sb = period(p.trendSlopeBars, 1);
  if (c15.length < pullbackMinTrendBars(p)) return null;
  const e = ema(closesOf(c15), TREND_EMA);
  const n = c15.length;
  const now = e[n - 1];
  const before = e[n - 1 - sb];
  const close = c15[n - 1].close;
  if (!Number.isFinite(now) || !Number.isFinite(before) || !(now > 0) || !Number.isFinite(close)) return null;
  const slopeBps = ((now - before) / sb / now) * 1e4;
  const gapBps = ((close - now) / now) * 1e4;
  if (!(Math.abs(slopeBps) >= minSlopeBps)) return null;
  if (slopeBps > 0 && gapBps > 0) return { direction: "long", slopeBps, gapBps, ema: now };
  if (slopeBps < 0 && gapBps < 0) return { direction: "short", slopeBps, gapBps, ema: now };
  return null;
}

export interface PullbackSetup {
  direction: "long" | "short";
  /** 1m の ATR(14) (引き金の足) */
  atr: number;
  close: number;
  /** 1m の EMA(20) (引き金の足) */
  mean: number;
  /** 窓と引き金の足の最高値・最安値 (売りは最高値、買いは最安値が損切りの基準) */
  swingHigh: number;
  swingLow: number;
  /** 窓の RSI(7) の極値 (売り: 最大、買い: 最小) */
  rsiExtreme: number;
  /** 引き金の足の RSI(7) */
  rsi: number;
  /**
   * 窓での 1m の平均への接近 (ATR 倍)。売り: max((高値 - EMA) / ATR)、買い: max((EMA - 安値) / ATR)。
   * -touchAtr 以上なら平均に触れたとみなす (0 以上なら平均を越えた)
   */
  devAtr: number;
  /** 引き金の足の出来高 / 直前 volBars 本の平均 */
  volRatio: number;
  trendSlopeBps: number;
  trendGapBps: number;
  /** 15m の EMA(20) の最後の値 */
  trendEma: number;
}

/**
 * 末尾の確定足での押し目・戻りの条件の判定。成立しなければ null。
 * 純粋関数。c1 / c15 はどちらも確定足だけ (末尾が最新)。tempo (0〜1、省略時 0) で決められた閾値だけを緩める。
 * クールダウンの判定では末尾を切り詰めた配列で呼ぶ
 */
export function detectPullback(c1: readonly Candle[], c15: readonly Candle[], p: Params, tempo?: number): PullbackSetup | null {
  const n = c1.length;
  if (n < pullbackMinBars(p)) return null;
  const th = pullbackThresholds(p, tempo);
  const trend = trend15m(c15, p, th.minTrendSlopeBps);
  if (!trend) return null;
  const long = trend.direction === "long";

  const pb = period(p.pullbackBars, 2);
  const closes = closesOf(c1);
  const a = atr(c1, ATR_PERIOD)[n - 1];
  if (!(a > 0) || !Number.isFinite(a)) return null;
  const m = ema(closes, MEAN_EMA);
  const r = rsi(closes, RSI_PERIOD);
  const cur = c1[n - 1];
  const prev = c1[n - 2];
  const mean = m[n - 1];
  if (!Number.isFinite(mean) || !Number.isFinite(r[n - 1])) return null;

  // 窓 (引き金の足の直前 pb 本) の RSI の極値と、1m の平均への接近
  let rsiExtreme = long ? Infinity : -Infinity;
  let devAtr = -Infinity;
  let swingHigh = cur.high;
  let swingLow = cur.low;
  for (let i = n - 1 - pb; i <= n - 2; i++) {
    const b = c1[i];
    if (Number.isFinite(r[i])) rsiExtreme = long ? Math.min(rsiExtreme, r[i]) : Math.max(rsiExtreme, r[i]);
    if (Number.isFinite(m[i])) devAtr = Math.max(devAtr, long ? (m[i] - b.low) / a : (b.high - m[i]) / a);
    swingHigh = Math.max(swingHigh, b.high);
    swingLow = Math.min(swingLow, b.low);
  }
  // 1. 押し (買い) / 戻り (売り) の RSI
  if (long ? !(rsiExtreme <= 50 - th.entryThreshold) : !(rsiExtreme >= 50 + th.entryThreshold)) return null;
  // 2. 1m の平均まで届いた
  if (!(devAtr >= -th.touchAtr)) return null;
  // 3. 引き金の足 (トレンド方向の実体で直前の足を抜け、RSI が極値から戻った)
  if (long) {
    if (!(cur.close > cur.open) || !(cur.close > prev.high) || !(r[n - 1] >= rsiExtreme + PULLBACK_RSI_TURN)) return null;
    // 4. まだ 15m の平均の上 (トレンドの側)
    if (!(cur.close > trend.ema)) return null;
  } else {
    if (!(cur.close < cur.open) || !(cur.close < prev.low) || !(r[n - 1] <= rsiExtreme - PULLBACK_RSI_TURN)) return null;
    if (!(cur.close < trend.ema)) return null;
  }

  const vb = period(p.volBars, 2);
  let vsum = 0;
  for (let i = n - 1 - vb; i < n - 1; i++) vsum += c1[i].volume;
  const volAvg = vsum / vb;
  const volRatio = volAvg > 0 ? cur.volume / volAvg : 0;
  return {
    direction: trend.direction,
    atr: a,
    close: cur.close,
    mean,
    swingHigh,
    swingLow,
    rsiExtreme,
    rsi: r[n - 1],
    devAtr,
    volRatio,
    trendSlopeBps: trend.slopeBps,
    trendGapBps: trend.gapBps,
    trendEma: trend.ema,
  };
}

/** 1m の末尾 k 本を除いた時点 (その時点の確定足) の 1m / 15m */
function truncatedAt(c1: readonly Candle[], c15: readonly Candle[], k: number): { c1: Candle[]; c15: Candle[] } {
  const a = c1.slice(0, c1.length - k);
  if (a.length === 0) return { c1: a, c15: [] };
  const asOf = a[a.length - 1].ts + TIMEFRAME_MS["1m"];
  return { c1: a, c15: c15.filter((b) => b.ts + TIMEFRAME_MS["15m"] <= asOf) };
}

export interface ScalpPullbackOptions {
  id?: string;
  /** 勝率の上乗せの上限 (既定 0.1)。診断用。学習では変えない */
  winEdgeMax?: number;
  /** 期待値 (コスト控除後, bps) の下限 (既定 0)。テンポでも緩めない。診断用。学習では変えない */
  minNetEdgeBps?: number;
}

export function createScalpPullback(opts: ScalpPullbackOptions = {}): Strategy {
  const winEdgeMax = opts.winEdgeMax ?? DEFAULT_WIN_EDGE_MAX;
  const minNetEdgeBps = opts.minNetEdgeBps ?? 0;
  const strategy: Strategy = {
    id: opts.id ?? "scalp_pullback",
    horizon: "scalp",
    assetClasses: ["crypto"],
    // 主時間足のレジームに依存しない (トレンドの向きは 15m で自前で判定)。low_liquidity は対象外
    regimes: ["trend_up", "trend_down", "high_vol", "range"],
    primaryTimeframe: "1m",
    timeframes: ["1m", "15m"],
    warmup: 40,
    defaultParams: {
      /** 押し・戻りの端の外側に置く損切りの余裕 (ATR 倍) */
      stopAtr: 0.3,
      /** 利確幅 / 損切り幅 (R 倍) */
      tpR: 2.0,
      /** トレーリングは既定で無効 */
      trailAtr: 0,
      /** 最大保有本数 (1m)。10〜30 分 */
      maxHoldBars: 30,
      /** 押し・戻りとみなす RSI(7) の 50 からの幅 (買い: 50 - これ以下、売り: 50 + これ以上) */
      entryThreshold: 12,
      /** 押し・戻りを探す引き金の足の直前の本数 */
      pullbackBars: 8,
      /** 1m の平均 (EMA20) に届いたとみなす余裕 (ATR 倍) */
      touchAtr: 0.25,
      /** 15m の EMA(20) の傾きを測る本数 */
      trendSlopeBars: 3,
      /** 15m の EMA(20) の傾きの下限 (1 本あたり bps) */
      minTrendSlopeBps: 3,
      /** 平均出来高の本数 */
      volBars: 20,
      /** 利確幅 / 往復コストの下限 (k) */
      costMult: 2.5,
      /** 想定スリッページ (片道 bps) */
      slippageBps: 2,
      /** 損切り幅 / スプレッドの下限 */
      minStopSpreads: 4,
      /** 同じ押し・戻りで再エントリーしない本数 (1m) */
      cooldownBars: 5,
    },
    paramBounds: {
      stopAtr: [0, 1],
      tpR: [1.2, 3],
      trailAtr: [0, 2],
      maxHoldBars: [SCALP_PULLBACK_HOLD_BOUNDS[0], SCALP_PULLBACK_HOLD_BOUNDS[1]],
      entryThreshold: [5, 25],
      pullbackBars: [3, 20],
      touchAtr: [0, 1],
      trendSlopeBars: [1, 8],
      minTrendSlopeBps: [0, 20],
      volBars: [10, 60],
      // 下限 1.5 (= TEMPO_COST_MULT_FLOOR): 学習でもテンポでもこれより緩めない
      costMult: [TEMPO_COST_MULT_FLOOR, 5],
      slippageBps: [1, 20],
      minStopSpreads: [3, 10],
      cooldownBars: [1, 15],
    },
    evaluate(ctx: StrategyContext): Signal | null {
      const p = ctx.params;
      const tempo = clampTempo(ctx.tempo);
      const c15 = candlesOf(ctx, "15m", pullbackMinTrendBars(p) + 60);

      const side = positionSide(ctx);
      if (side) {
        // 保有中: 15m の終値が EMA(20) の反対側に抜けたら手仕舞い (利確・損切り・時間切れはエンジン側)
        const t = last15m(c15);
        if (!t) return null;
        if ((side === "long" && t.close < t.ema) || (side === "short" && t.close > t.ema)) {
          return exitSignal(ctx, strategy, 0.6, `15m のトレンドの崩れ (終値が EMA20 の${side === "long" ? "下" : "上"})`, {
            trendClose15: t.close,
            trendEma15: t.ema,
          });
        }
        return null;
      }

      const cd = Math.max(1, period(p.cooldownBars, 1));
      const c1 = candlesOf(ctx, "1m", pullbackMinBars(p) + cd + 120);
      if (c1.length < Math.max(strategy.warmup, pullbackMinBars(p))) return null;
      if (entryBlocked(ctx)) return null;
      const s = detectPullback(c1, c15, p, tempo);
      if (!s) return null;
      const dir = s.direction;

      // クールダウン: 直前 cd 本でも同じ向きで成立していたら同じ押し・戻りとみなして見送る
      for (let k = 1; k <= cd; k++) {
        const t = truncatedAt(c1, c15, k);
        const prev = detectPullback(t.c1, t.c15, p, tempo);
        if (prev && prev.direction === dir) return null;
      }

      // confidence: 強さはテンポで緩める前の閾値で測る (テンポで期待値を膨らませない)
      const th = pullbackThresholds(p, tempo);
      const slopeBase = Math.max(0, p.minTrendSlopeBps);
      const bandBase = Math.max(1e-9, p.entryThreshold);
      const slopeStrength = clamp((Math.abs(s.trendSlopeBps) - slopeBase) / Math.max(1, slopeBase));
      const rsiStrength = clamp((Math.abs(s.rsiExtreme - 50) - bandBase) / bandBase);
      const confidence = 0.5 + 0.2 * slopeStrength + 0.15 * rsiStrength + 0.15 * clamp(s.volRatio - 1);

      // 損切り: 押し・戻りの端 ± stopAtr × ATR (0.8〜3.5 ATR)。利確: tpR × 損切り幅
      const price = refPrice(ctx, dir, s.close);
      const rawStopAtr = (dir === "long" ? price - s.swingLow : s.swingHigh - price) / s.atr + Math.max(0, p.stopAtr);
      const stopAtrEff = Math.max(PULLBACK_MIN_STOP_ATR, rawStopAtr);
      if (!(stopAtrEff <= PULLBACK_MAX_STOP_ATR)) return null;
      const tpAtrEff = Math.max(0, p.tpR) * stopAtrEff;
      const holdBars = Math.min(SCALP_PULLBACK_HOLD_BOUNDS[1], Math.max(SCALP_PULLBACK_HOLD_BOUNDS[0], period(p.maxHoldBars)));

      const features: Record<string, number> = {
        trendSlope15Bps: s.trendSlopeBps,
        trendGap15Bps: s.trendGapBps,
        trendEma15: s.trendEma,
        rsi7: s.rsi,
        rsiExtreme: s.rsiExtreme,
        devAtr: s.devAtr,
        volRatio: s.volRatio,
        swingHigh: s.swingHigh,
        swingLow: s.swingLow,
        mean: s.mean,
        stopAtrEff,
        tempo,
        entryThresholdEff: th.entryThreshold,
        minTrendSlopeBpsEff: th.minTrendSlopeBps,
        touchAtrEff: th.touchAtr,
        costMultEff: th.costMult,
      };
      const what = dir === "long" ? "15m 上昇中の押し目買い" : "15m 下降中の戻り売り";
      const sig = buildEntrySignal({
        ctx: { ...ctx, params: { ...p, stopAtr: stopAtrEff, tpAtr: tpAtrEff, maxHoldBars: holdBars } },
        strategy,
        direction: dir,
        confidence,
        atr: s.atr,
        lastPrice: s.close,
        reason:
          `${what}: RSI7 ${s.rsiExtreme.toFixed(0)}→${s.rsi.toFixed(0)} / 15m 傾き ${s.trendSlopeBps.toFixed(1)}bps/本` +
          ` / 出来高 ${s.volRatio.toFixed(1)} 倍${tempo > 0 ? ` / テンポ ${tempo.toFixed(2)}` : ""}`,
        features,
      });
      if (!sig || sig.takeProfit === undefined) return null;

      // コスト
      const q = ctx.market.quote;
      const costBps = roundTripCostBps(ctx.market.instrument.takerFeeRate, q?.bid ?? NaN, q?.ask ?? NaN, p.slippageBps);
      if (costBps === undefined) return null;
      const spread = q.ask - q.bid;
      const tpDist = Math.abs(sig.takeProfit - price);
      const slDist = Math.abs(price - sig.stopLoss);
      const tpBps = (tpDist / price) * 1e4;
      const slBps = (slDist / price) * 1e4;
      // インテルの補正後の confidence で勝率を推定する
      const ev = microExpectedEdge({ tpBps, slBps, costBps, confidence: sig.confidence, winEdgeMax });
      const full: Signal = {
        ...sig,
        expectedEdgeBps: ev.edgeBps,
        edgeIsNet: true,
        maxHoldMs: holdBars * TIMEFRAME_MS["1m"],
        features: { ...sig.features, costBps, tpBps, slBps, winProb: ev.p, winProbBase: ev.p0, netEdgeBps: ev.edgeBps },
      };
      // 見送ったシグナルを観測用に通知する (失敗しても戦略の結果は変えない)
      const notify = (reason: string): null => {
        if (ctx.onFiltered && Number.isFinite(ev.edgeBps) && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.takeProfit)) {
          try {
            ctx.onFiltered(full, reason);
          } catch {
            /* 観測用。握りつぶす */
          }
        }
        return null;
      };
      if (tpBps < Math.max(0, th.costMult) * costBps) return notify("cost");
      if (slDist < Math.max(0, p.minStopSpreads) * spread) return notify("spread");
      // コスト控除後の期待値の条件はテンポでも緩めない (探索 ctx.tempoExplore のときだけ tempoNetEdgeFloor まで下げる)
      if (!(ev.edgeBps > tempoNetEdgeFloor(minNetEdgeBps, ctx.tempo, costBps, ctx.tempoExplore === true))) return notify("edge");
      return full;
    },
  };
  return strategy;
}

/** 既定の scalp_pullback */
export const scalpPullback: Strategy = createScalpPullback();
