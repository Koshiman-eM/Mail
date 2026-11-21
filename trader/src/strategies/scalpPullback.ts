import type { Candle, Horizon, Params, Signal, Strategy, StrategyContext, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atr, closesOf, ema, rsi } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, refPrice } from "./common";
import { DEFAULT_WIN_EDGE_MAX, netEdgeEntry } from "./netEdge";
import { clampTempo, relaxToward, TEMPO_COST_MULT_FLOOR } from "../engine/tempo";

/**
 * 押し目買い・戻り売り (pullback) の戦略群: 上位足のトレンドの向きに、主時間足の押し目で買い・戻りで売る順張り
 * (売り買い両方)。主時間足と上位足の組は相場構造 (ダウ理論) の MTF の対応 (1m→15m、5m→1h、15m→4h) に合わせる。
 * 判定の中身は 3 つとも同じ (createPullback)。違うのは時間足・保有本数・時間足に依存する既定値だけ。
 *
 *   | id             | 時間軸 | 主時間足 | 上位足 | 保有 (主時間足の本数)   | 構造ラッパー | 観測専用 |
 *   | scalp_pullback | scalp  | 1m       | 15m    | 10〜30 本 (10〜30 分)    | なし         | いいえ   |
 *   | pullback_5m    | short  | 5m       | 1h     | 6〜24 本 (30 分〜2 時間) | なし         | いいえ   |
 *   | pullback_15m   | short  | 15m      | 4h     | 4〜16 本 (1〜4 時間)     | なし         | いいえ   |
 *
 *   3 つとも上位足のトレンドを自前で判定するので、相場構造のフィルター (DEFAULT_STRUCTURE_STRATEGIES) には入れない。
 *
 * 以下は scalp_pullback (主時間足 1m、上位足 15m) で説明する。pullback_5m / pullback_15m は
 * 「1m」を主時間足 (5m / 15m)、「15m」を上位足 (1h / 4h) と読み替える (時間足に依存する既定値は末尾の各設定を参照)。
 *
 * 狙い: GMOコインのレバレッジ取引 (売りから建てられる・手数料ほぼ 0、コスト ≈ スプレッド + 滑り) で、
 *   おおむね 10 分に 1 回のエントリーと 30 分以内の決済を目指す。トレンドの中の短い逆行 (押し・戻り) が
 *   終わってトレンド方向へ動き出したところで入り、直近の押し・戻りの外側に損切りを置いて R 倍で利確する。
 *   pullback_5m / pullback_15m は同じ形を 5 分足・15 分足で取り、30 分〜4 時間の短期の取引を繰り返す。
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
 *   - 保有中は 15m の末尾の終値が EMA(20) の反対側に抜けたら (トレンドの崩れ) flat を返す (必ず上位足 = trendTf の足で見る)。
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
 *
 * ウォームアップ (Strategy.warmup、主時間足の本数): バックテスト・パラメータ検証は warmup + 50 本を前に付けるので、
 * 上位足で PULLBACK_TREND_WARMUP_BARS (= EMA20 + trendSlopeBars の上限 8 = 28) 本ぶんを主時間足の本数で持つ
 * (pullbackWarmupBars: 5m / 1h → 336 本、15m / 4h → 448 本)。scalp_pullback は従来の 40 のまま (変えない)。
 * evaluate の中で要求する主時間足の本数は warmup ではなく PULLBACK_EXEC_MIN_BARS (40) と指標の必要本数の大きい方
 * (運用の MarketHub は時間足ごとに約 300 本しか持たないため、448 本を要求すると運用で出なくなる)。
 * 上位足は pullbackMinTrendBars (既定で 23 本、trendSlopeBars の上限 8 で 28 本) の確定足が無ければ判定しない (null)。
 * 運用では MarketHub が strategy.timeframes (主時間足と上位足) をそれぞれ直近 300 本取得する (setup.ts の hubTimeframesFor)。
 */

/** 保有本数 (1m) の範囲。maxHoldMs を 10〜30 分にする */
export const SCALP_PULLBACK_HOLD_BOUNDS: readonly [number, number] = [10, 30];
/** pullback_5m の保有本数 (5m) の範囲。maxHoldMs を 30 分〜2 時間にする */
export const PULLBACK_5M_HOLD_BOUNDS: readonly [number, number] = [6, 24];
/** pullback_15m の保有本数 (15m) の範囲。maxHoldMs を 1〜4 時間にする */
export const PULLBACK_15M_HOLD_BOUNDS: readonly [number, number] = [4, 16];
/** 損切り幅 (エントリー価格から, ATR 倍) の下限。押し・戻りの端が近すぎるときはここまで広げる */
export const PULLBACK_MIN_STOP_ATR = 0.8;
/** 損切り幅 (ATR 倍) の上限。押し・戻りの端が遠すぎる (超えたら見送る) */
export const PULLBACK_MAX_STOP_ATR = 3.5;
/** 引き金の足の RSI が窓の極値から戻っている幅 (RSI のポイント) */
export const PULLBACK_RSI_TURN = 5;
/** 主時間足の ATR の期間 */
const ATR_PERIOD = 14;
/** 主時間足の RSI の期間 */
const RSI_PERIOD = 7;
/** 主時間足の短期平均 (EMA) の期間 */
const MEAN_EMA = 20;
/** 上位足のトレンド判定の EMA の期間 */
const TREND_EMA = 20;
/** trendSlopeBars (上位足の本数) の上限 (paramBounds) */
const TREND_SLOPE_BARS_MAX = 8;
/** evaluate の中で要求する主時間足の最小本数 (scalp_pullback の warmup と同じ 40 本。指標の必要本数が多ければそちら) */
export const PULLBACK_EXEC_MIN_BARS = 40;
/** ウォームアップで確保する上位足の本数: EMA(20) + trendSlopeBars の上限 (8) */
export const PULLBACK_TREND_WARMUP_BARS = TREND_EMA + TREND_SLOPE_BARS_MAX;

/**
 * 上位足で PULLBACK_TREND_WARMUP_BARS 本に相当する主時間足の本数 (切り上げ) と PULLBACK_EXEC_MIN_BARS の大きい方。
 * pullback_5m / pullback_15m の Strategy.warmup に使う。純粋関数
 */
export function pullbackWarmupBars(execTf: Timeframe, trendTf: Timeframe): number {
  return Math.max(PULLBACK_EXEC_MIN_BARS, Math.ceil((PULLBACK_TREND_WARMUP_BARS * TIMEFRAME_MS[trendTf]) / TIMEFRAME_MS[execTf]));
}

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

/** 上位足 (scalp_pullback は 15m、pullback_5m は 1h、pullback_15m は 4h) のトレンド */
export interface PullbackTrend {
  direction: "long" | "short";
  /** 上位足の EMA(20) の傾き (1 本あたり, bps, 符号付き) */
  slopeBps: number;
  /** 上位足の終値の EMA(20) からの乖離 (bps, 符号付き) */
  gapBps: number;
  /** 上位足の EMA(20) の最後の値 */
  ema: number;
}

/** 上位足の判定に必要な最小本数 (EMA20 + trendSlopeBars。既定 23 本) */
export function pullbackMinTrendBars(p: Params): number {
  return TREND_EMA + period(p.trendSlopeBars, 1);
}

/** 主時間足の判定に必要な最小本数 */
export function pullbackMinBars(p: Params): number {
  const pb = period(p.pullbackBars, 2);
  return Math.max(MEAN_EMA + pb + 1, RSI_PERIOD + pb + 2, ATR_PERIOD + 1, period(p.volBars, 2) + 1);
}

/** 上位足の末尾の終値と EMA(20) (足りなければ null) */
function lastTrendBar(ct: readonly Candle[]): { close: number; ema: number } | null {
  if (ct.length < TREND_EMA) return null;
  const e = ema(closesOf(ct), TREND_EMA)[ct.length - 1];
  const close = ct[ct.length - 1].close;
  if (!Number.isFinite(e) || !(e > 0) || !Number.isFinite(close)) return null;
  return { close, ema: e };
}

/**
 * 上位足の確定足でのトレンドの向き。|傾き| ≥ minSlopeBps かつ終値が EMA(20) の同じ側なら成立、しなければ null。
 * minSlopeBps の省略時は p.minTrendSlopeBps (テンポで緩めない値)。時間足には依存しない (渡された足で判定する)。純粋関数
 */
export function pullbackTrend(ct: readonly Candle[], p: Params, minSlopeBps: number = Math.max(0, p.minTrendSlopeBps)): PullbackTrend | null {
  const sb = period(p.trendSlopeBars, 1);
  if (ct.length < pullbackMinTrendBars(p)) return null;
  const e = ema(closesOf(ct), TREND_EMA);
  const n = ct.length;
  const now = e[n - 1];
  const before = e[n - 1 - sb];
  const close = ct[n - 1].close;
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
  /** 主時間足の ATR(14) (引き金の足) */
  atr: number;
  close: number;
  /** 主時間足の EMA(20) (引き金の足) */
  mean: number;
  /** 窓と引き金の足の最高値・最安値 (売りは最高値、買いは最安値が損切りの基準) */
  swingHigh: number;
  swingLow: number;
  /** 窓の RSI(7) の極値 (売り: 最大、買い: 最小) */
  rsiExtreme: number;
  /** 引き金の足の RSI(7) */
  rsi: number;
  /**
   * 窓での主時間足の平均への接近 (ATR 倍)。売り: max((高値 - EMA) / ATR)、買い: max((EMA - 安値) / ATR)。
   * -touchAtr 以上なら平均に触れたとみなす (0 以上なら平均を越えた)
   */
  devAtr: number;
  /** 引き金の足の出来高 / 直前 volBars 本の平均 */
  volRatio: number;
  trendSlopeBps: number;
  trendGapBps: number;
  /** 上位足の EMA(20) の最後の値 */
  trendEma: number;
}

/**
 * 末尾の確定足での押し目・戻りの条件の判定。成立しなければ null。
 * 純粋関数。c1 (主時間足) / c15 (上位足) はどちらも確定足だけ (末尾が最新)。時間足には依存しない。
 * tempo (0〜1、省略時 0) で決められた閾値だけを緩める。クールダウンの判定では末尾を切り詰めた配列で呼ぶ
 */
export function detectPullback(c1: readonly Candle[], c15: readonly Candle[], p: Params, tempo?: number): PullbackSetup | null {
  const n = c1.length;
  if (n < pullbackMinBars(p)) return null;
  const th = pullbackThresholds(p, tempo);
  const trend = pullbackTrend(c15, p, th.minTrendSlopeBps);
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

  // 窓 (引き金の足の直前 pb 本) の RSI の極値と、主時間足の平均への接近
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
  // 2. 主時間足の平均まで届いた
  if (!(devAtr >= -th.touchAtr)) return null;
  // 3. 引き金の足 (トレンド方向の実体で直前の足を抜け、RSI が極値から戻った)
  if (long) {
    if (!(cur.close > cur.open) || !(cur.close > prev.high) || !(r[n - 1] >= rsiExtreme + PULLBACK_RSI_TURN)) return null;
    // 4. まだ上位足の平均の上 (トレンドの側)
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

/** 主時間足の末尾 k 本を除いた時点 (その時点の確定足) の主時間足 / 上位足 */
function truncatedAt(
  ce: readonly Candle[],
  ct: readonly Candle[],
  k: number,
  execTf: Timeframe,
  trendTf: Timeframe,
): { ce: Candle[]; ct: Candle[] } {
  const a = ce.slice(0, ce.length - k);
  if (a.length === 0) return { ce: a, ct: [] };
  const asOf = a[a.length - 1].ts + TIMEFRAME_MS[execTf];
  return { ce: a, ct: ct.filter((b) => b.ts + TIMEFRAME_MS[trendTf] <= asOf) };
}

/**
 * 既定パラメータ (scalp_pullback の値)。時間足に依存する値 (maxHoldBars・minTrendSlopeBps・pullbackBars・cooldownBars) は
 * 各設定の defaults で上書きする。ATR 倍・RSI・R 倍・コストの値は時間足に依存しないのでそのまま使う
 */
const BASE_DEFAULTS: Params = {
  /** 押し・戻りの端の外側に置く損切りの余裕 (ATR 倍) */
  stopAtr: 0.3,
  /** 利確幅 / 損切り幅 (R 倍) */
  tpR: 2.0,
  /** トレーリングは既定で無効 */
  trailAtr: 0,
  /** 最大保有本数 (主時間足)。scalp_pullback は 1m で 10〜30 分 */
  maxHoldBars: 30,
  /** 押し・戻りとみなす RSI(7) の 50 からの幅 (買い: 50 - これ以下、売り: 50 + これ以上) */
  entryThreshold: 12,
  /** 押し・戻りを探す引き金の足の直前の本数 (主時間足) */
  pullbackBars: 8,
  /** 主時間足の平均 (EMA20) に届いたとみなす余裕 (ATR 倍) */
  touchAtr: 0.25,
  /** 上位足の EMA(20) の傾きを測る本数 (上位足) */
  trendSlopeBars: 3,
  /** 上位足の EMA(20) の傾きの下限 (上位足 1 本あたり bps) */
  minTrendSlopeBps: 3,
  /** 平均出来高の本数 (主時間足) */
  volBars: 20,
  /** 利確幅 / 往復コストの下限 (k) */
  costMult: 2.5,
  /** 想定スリッページ (片道 bps) */
  slippageBps: 2,
  /** 損切り幅 / スプレッドの下限 */
  minStopSpreads: 4,
  /** 同じ押し・戻りで再エントリーしない本数 (主時間足) */
  cooldownBars: 5,
};

/** paramBounds (scalp_pullback の値。maxHoldBars は保有本数の範囲) */
function baseBounds(hold: readonly [number, number]): Record<string, [number, number]> {
  return {
    stopAtr: [0, 1],
    tpR: [1.2, 3],
    trailAtr: [0, 2],
    maxHoldBars: [hold[0], hold[1]],
    entryThreshold: [5, 25],
    pullbackBars: [3, 20],
    touchAtr: [0, 1],
    trendSlopeBars: [1, TREND_SLOPE_BARS_MAX],
    minTrendSlopeBps: [0, 20],
    volBars: [10, 60],
    // 下限 1.5 (= TEMPO_COST_MULT_FLOOR): 学習でもテンポでもこれより緩めない
    costMult: [TEMPO_COST_MULT_FLOOR, 5],
    slippageBps: [1, 20],
    minStopSpreads: [3, 10],
    cooldownBars: [1, 15],
  };
}

/** 押し目買い・戻り売りの戦略の設定 (createPullback) */
export interface PullbackConfig {
  id: string;
  horizon: Horizon;
  /** 主時間足 (押し・戻り・引き金・ATR・最大保有の本数の足) */
  execTf: Timeframe;
  /** 上位足 (トレンドの向きと、保有中のトレンドの崩れを判定する足) */
  trendTf: Timeframe;
  /** 保有本数 (主時間足) の範囲。maxHoldBars の paramBounds で、範囲外の値も evaluate 内でこの範囲にクランプする */
  holdBounds: readonly [number, number];
  /** Strategy.warmup (主時間足の本数)。バックテスト・検証の前置き (warmup + 50 本) に使う */
  warmup: number;
  /** 既定パラメータの上書き (時間足に依存する値) */
  defaults?: Params;
  /** paramBounds の上書き (maxHoldBars は holdBounds で決める) */
  bounds?: Record<string, [number, number]>;
  /** features の上位足の名前 (trendSlope<tag>Bps・trendGap<tag>Bps・trendEma<tag>・trendClose<tag>)。省略時は trendTf */
  featureTag?: string;
  /** 勝率の上乗せの上限 (既定 0.1)。診断用。学習では変えない */
  winEdgeMax?: number;
  /** 期待値 (コスト控除後, bps) の下限 (既定 0)。テンポでも緩めない。診断用。学習では変えない */
  minNetEdgeBps?: number;
}

/** 押し目買い・戻り売りの戦略を作る (主時間足・上位足・保有本数・既定値を設定で変える。判定はすべて同じ) */
export function createPullback(cfg: PullbackConfig): Strategy {
  const winEdgeMax = cfg.winEdgeMax ?? DEFAULT_WIN_EDGE_MAX;
  const minNetEdgeBps = cfg.minNetEdgeBps ?? 0;
  const { execTf, trendTf } = cfg;
  const hold: readonly [number, number] = [cfg.holdBounds[0], cfg.holdBounds[1]];
  const tag = cfg.featureTag ?? trendTf;
  const strategy: Strategy = {
    id: cfg.id,
    horizon: cfg.horizon,
    assetClasses: ["crypto"],
    // 主時間足のレジームに依存しない (トレンドの向きは上位足で自前で判定)。low_liquidity は対象外
    regimes: ["trend_up", "trend_down", "high_vol", "range"],
    primaryTimeframe: execTf,
    // 運用の MarketHub はこの 2 つの時間足をそれぞれ直近 300 本取得する (hubTimeframesFor)
    timeframes: [execTf, trendTf],
    warmup: cfg.warmup,
    defaultParams: { ...BASE_DEFAULTS, ...cfg.defaults },
    paramBounds: { ...baseBounds(hold), ...cfg.bounds, maxHoldBars: [hold[0], hold[1]] },
    evaluate(ctx: StrategyContext): Signal | null {
      const p = ctx.params;
      const tempo = clampTempo(ctx.tempo);
      // 上位足 (trendTf) の確定足。トレンドの向き・保有中の崩れの判定はどちらもこの足で行う
      const ct = candlesOf(ctx, trendTf, pullbackMinTrendBars(p) + 60);

      const side = positionSide(ctx);
      if (side) {
        // 保有中: 上位足の終値が EMA(20) の反対側に抜けたら手仕舞い (利確・損切り・時間切れはエンジン側)
        const t = lastTrendBar(ct);
        if (!t) return null;
        if ((side === "long" && t.close < t.ema) || (side === "short" && t.close > t.ema)) {
          return exitSignal(ctx, strategy, 0.6, `${trendTf} のトレンドの崩れ (終値が EMA20 の${side === "long" ? "下" : "上"})`, {
            [`trendClose${tag}`]: t.close,
            [`trendEma${tag}`]: t.ema,
          });
        }
        return null;
      }

      const cd = Math.max(1, period(p.cooldownBars, 1));
      const ce = candlesOf(ctx, execTf, pullbackMinBars(p) + cd + 120);
      // 主時間足の本数は warmup ではなく PULLBACK_EXEC_MIN_BARS で見る (warmup は上位足の分も含み、運用の 300 本を超えうる)
      if (ce.length < Math.max(PULLBACK_EXEC_MIN_BARS, pullbackMinBars(p))) return null;
      if (entryBlocked(ctx)) return null;
      const s = detectPullback(ce, ct, p, tempo);
      if (!s) return null;
      const dir = s.direction;

      // クールダウン: 直前 cd 本でも同じ向きで成立していたら同じ押し・戻りとみなして見送る
      for (let k = 1; k <= cd; k++) {
        const t = truncatedAt(ce, ct, k, execTf, trendTf);
        const prev = detectPullback(t.ce, t.ct, p, tempo);
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
      const holdBars = Math.min(hold[1], Math.max(hold[0], period(p.maxHoldBars)));

      const features: Record<string, number> = {
        [`trendSlope${tag}Bps`]: s.trendSlopeBps,
        [`trendGap${tag}Bps`]: s.trendGapBps,
        [`trendEma${tag}`]: s.trendEma,
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
      const what = dir === "long" ? `${trendTf} 上昇中の押し目買い` : `${trendTf} 下降中の戻り売り`;
      const sig = buildEntrySignal({
        ctx: { ...ctx, params: { ...p, stopAtr: stopAtrEff, tpAtr: tpAtrEff, maxHoldBars: holdBars } },
        strategy,
        direction: dir,
        confidence,
        atr: s.atr,
        lastPrice: s.close,
        reason:
          `${what}: RSI7 ${s.rsiExtreme.toFixed(0)}→${s.rsi.toFixed(0)} / ${trendTf} 傾き ${s.trendSlopeBps.toFixed(1)}bps/本` +
          ` / 出来高 ${s.volRatio.toFixed(1)} 倍${tempo > 0 ? ` / テンポ ${tempo.toFixed(2)}` : ""}`,
        features,
      });
      // コスト控除後の期待値の条件はテンポでも緩めない (探索 ctx.tempoExplore のときだけ tempoNetEdgeFloor まで下げる)
      return netEdgeEntry({ ctx, sig, price, costMult: th.costMult, maxHoldMs: holdBars * TIMEFRAME_MS[execTf], winEdgeMax, minNetEdgeBps });
    },
  };
  return strategy;
}

/** 診断用の上書き (id・勝率の上乗せの上限・期待値の下限)。学習では変えない */
export interface ScalpPullbackOptions {
  id?: string;
  /** 勝率の上乗せの上限 (既定 0.1)。診断用。学習では変えない */
  winEdgeMax?: number;
  /** 期待値 (コスト控除後, bps) の下限 (既定 0)。テンポでも緩めない。診断用。学習では変えない */
  minNetEdgeBps?: number;
}
/** pullback_5m / pullback_15m の診断用の上書き (scalp_pullback と同じ) */
export type PullbackOptions = ScalpPullbackOptions;

/** 設定に診断用の上書きを重ねる (id を省略したら設定の id) */
function withOptions(cfg: PullbackConfig, opts: PullbackOptions): PullbackConfig {
  return {
    ...cfg,
    id: opts.id ?? cfg.id,
    ...(opts.winEdgeMax !== undefined ? { winEdgeMax: opts.winEdgeMax } : {}),
    ...(opts.minNetEdgeBps !== undefined ? { minNetEdgeBps: opts.minNetEdgeBps } : {}),
  };
}

/** scalp_pullback: 1m の押し・戻り、15m のトレンド、保有 10〜30 分 (従来と同じ値。warmup も従来の 40) */
export const SCALP_PULLBACK_CONFIG: Readonly<PullbackConfig> = {
  id: "scalp_pullback",
  horizon: "scalp",
  execTf: "1m",
  trendTf: "15m",
  holdBounds: SCALP_PULLBACK_HOLD_BOUNDS,
  warmup: 40,
  // features の名前は従来どおり trendSlope15Bps など
  featureTag: "15",
};

/**
 * pullback_5m: 5m の押し・戻り、1h のトレンド (ダウ理論の MTF: 5m → 1h)、保有 6〜24 本 (30 分〜2 時間)。
 * 時間足に依存する既定値 (それ以外は scalp_pullback と同じ):
 *   - maxHoldBars 12 (= 1 時間): 範囲 6〜24 本の中ほど。読みの管理 (THESIS_EXIT) が当たっている建玉は延長する。
 *   - minTrendSlopeBps 6 (1h 足 1 本あたり bps): 上位足 1 本の値動きはおおむね足の長さの平方根に比例するので、
 *     scalp_pullback の 15m の 3bps を √(60 / 15) = 2 倍した。範囲も同じく 2 倍の 0〜40。
 *   - pullbackBars 6 (5m で 30 分): 押し・戻りを上位足のおよそ半分の長さ (scalp_pullback の 8 分 ≈ 15m の半分と同じ比率) で探す。
 *   - cooldownBars 4 (5m で 20 分): scalp_pullback と同じく窓の約 5/8 (5 / 8 本)。同じ押しの引き金が続く間の再エントリーを防ぎ、
 *     次の押しでは入れるよう短めにする。
 *   - trendSlopeBars 3 (上位足の本数)・volBars 20・entryThreshold・touchAtr・stopAtr・tpR は本数や ATR・RSI の単位なので変えない。
 * warmup は上位足 28 本ぶん (pullbackWarmupBars("5m", "1h") = 336 本 = 28 時間)。
 */
export const PULLBACK_5M_CONFIG: Readonly<PullbackConfig> = {
  id: "pullback_5m",
  horizon: "short",
  execTf: "5m",
  trendTf: "1h",
  holdBounds: PULLBACK_5M_HOLD_BOUNDS,
  warmup: pullbackWarmupBars("5m", "1h"),
  defaults: { maxHoldBars: 12, minTrendSlopeBps: 6, pullbackBars: 6, cooldownBars: 4 },
  bounds: { minTrendSlopeBps: [0, 40] },
};

/**
 * pullback_15m: 15m の押し・戻り、4h のトレンド (ダウ理論の MTF: 15m → 4h)、保有 4〜16 本 (1〜4 時間)。
 * 時間足に依存する既定値 (それ以外は scalp_pullback と同じ):
 *   - maxHoldBars 8 (= 2 時間): 範囲 4〜16 本の中ほど。
 *   - minTrendSlopeBps 12 (4h 足 1 本あたり bps): √(240 / 15) = 4 倍。範囲も 4 倍の 0〜80。
 *   - pullbackBars 8 (15m で 2 時間): 上位足 (4h) のおよそ半分。
 *   - cooldownBars 5 (15m で 75 分): 窓の約 5/8。
 * warmup は上位足 28 本ぶん (pullbackWarmupBars("15m", "4h") = 448 本 = 112 時間)。
 * 運用では 4h の確定足が pullbackMinTrendBars (既定 23 本 ≈ 4 日) 以上必要。MarketHub は 4h も直近 300 本を取得するので足りるが、
 * feed が 4h を返さず 1m から集約する場合 (1m の 300 本 = 5 時間) は足りず、シグナルは出ない (null)。
 */
export const PULLBACK_15M_CONFIG: Readonly<PullbackConfig> = {
  id: "pullback_15m",
  horizon: "short",
  execTf: "15m",
  trendTf: "4h",
  holdBounds: PULLBACK_15M_HOLD_BOUNDS,
  warmup: pullbackWarmupBars("15m", "4h"),
  defaults: { maxHoldBars: 8, minTrendSlopeBps: 12, pullbackBars: 8, cooldownBars: 5 },
  bounds: { minTrendSlopeBps: [0, 80] },
};

export function createScalpPullback(opts: ScalpPullbackOptions = {}): Strategy {
  return createPullback(withOptions(SCALP_PULLBACK_CONFIG, opts));
}

export function createPullback5m(opts: PullbackOptions = {}): Strategy {
  return createPullback(withOptions(PULLBACK_5M_CONFIG, opts));
}

export function createPullback15m(opts: PullbackOptions = {}): Strategy {
  return createPullback(withOptions(PULLBACK_15M_CONFIG, opts));
}

/** 既定の scalp_pullback */
export const scalpPullback: Strategy = createScalpPullback();
/** 既定の pullback_5m (5 分足の押し目買い・戻り売り、1h のトレンド) */
export const pullback5m: Strategy = createPullback5m();
/** 既定の pullback_15m (15 分足の押し目買い・戻り売り、4h のトレンド) */
export const pullback15m: Strategy = createPullback15m();
