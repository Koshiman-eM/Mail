import type { Candle, Params, Signal, Strategy, StrategyContext } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { atr, closesOf, ema, rsi } from "../indicators/series";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, period, positionSide, refPrice } from "./common";
import { DEFAULT_WIN_EDGE_MAX, netEdgeEntry } from "./netEdge";
import { relaxToward, TEMPO_COST_MULT_FLOOR } from "../engine/tempo";

/**
 * scalp_rebound: 下降トレンドの中の短い反発を買いで取る超短期の逆張り (主時間足 1m、上位足 15m、買いのみ)。
 *
 * 狙い: 空売りできない現物では、下げ相場で既存戦略はほぼ何もしない (逆張り系は regimes が range だけ、
 *   トレンド系は売りを出す)。下降トレンドでも下落と反発は繰り返すので、行き過ぎた下げの後の戻りの一部を取る。
 *   当面は観測専用 (OBSERVE_ONLY_STRATEGIES の既定) で、発注せずに仮想トレードだけを記録して効果を測る。
 *
 * 上位足 (15m) の条件: 下降トレンドであること (戦略の中で自前で判定する)。
 *   - 15m の EMA(20) の傾き (trendSlopeBars 本前との差) が負、かつ 15m の終値が EMA より下。
 *   - 主時間足 (1m) のレジーム判定は反発の局面で range / high_vol に振れやすいので、regimes は
 *     trend_down / high_vol / range とし、トレンドの向きは 15m で決める。trend_up (上昇の押し目買い) は既存戦略の範囲。
 *
 * エントリー (1m の確定足のみ。すべて満たすとき):
 *   1. 売られ過ぎからの戻り: 直近 rsiLookback 本の RSI(7) の最小値が rsiOversold 以下で、末尾の RSI が直前より上。
 *      (RSI(7) は 1m の短い行き過ぎを拾う標準的な設定。底を付けてから向きが変わったことを確認して、落ちるナイフを避ける)
 *   2. 短期平均からの下方乖離: 直近 rsiLookback 本の (EMA(20) - 終値) / ATR(14) の最大が entryThreshold 以上。
 *      (平均からの距離が ATR の数倍に広がった後のほうが、平均方向への戻りの余地が大きい)
 *   3. 反転の足: 末尾の足が陽線、または下ひげ (実体の下端 - 安値) が足の幅の wickRatio 以上で終値が足の上半分。
 *   4. 末尾の終値がまだ EMA(20) より下 (戻りの余地が残っている)。
 *   出来高 (直前 volBars 本の平均に対する倍率) が増えていれば confidence を加点する (必須にはしない)。
 *
 * 決済:
 *   - 損切り: 直近 swingBars 本の安値 - stopAtr × ATR (直近安値の少し下)。エントリー価格からの距離が
 *     MIN_STOP_ATR 未満なら MIN_STOP_ATR まで広げ、MAX_STOP_ATR を超えるなら見送る (リスクが広すぎる)。
 *   - 利確: min(tpAtr × ATR, EMA(20) までの距離)。短期平均への戻りの一部だけを取る (平均を越える戻りは当てにしない)。
 *   - 最大保有: maxHoldBars (1m で 15〜30 本)。paramBounds 外の値も evaluate 内でクランプする。トレーリングは既定で無効。
 *   - 保有中は終値が EMA(20) に戻ったら flat を返す (平均回帰の完了)。損切り・利確・時間切れはエンジン側。
 *
 * コストの条件 (scalp_micro と同じ。すべて満たすときだけシグナルを出す):
 *   - 往復コスト = 2 × takerFeeRate + 現在のスプレッド比 + 2 × 想定スリッページ (片道 slippageBps)。
 *   - 利確幅 ≥ costMult × 往復コスト、損切り幅 ≥ minStopSpreads × スプレッド、期待値 > 0。
 *   - 見送ったシグナルは ctx.onFiltered で観測用に通知する (理由: cost / spread / edge)。戻り値は null。
 *
 * 期待値 (expectedEdgeBps): scalp_micro の microExpectedEdge を使う。ランダムウォークの勝率 p0 = 損切り / (利確 + 損切り)
 *   に、シグナルの強さに応じて最大 winEdgeMax (既定 10%pt) を上乗せした p で、p × 利確 - (1 - p) × 損切り - 往復コスト (bps)。
 *   トレンドに逆らう買いなので confidence をそのまま勝率とみなさない (保守的)。winEdgeMax は paramBounds に入れない。
 *   期待値はコスト控除後なので、シグナルに edgeIsNet: true を付ける。
 *
 * テンポ (ctx.tempo、0〜1) で緩めるのは costMult だけ (TEMPO_COST_MULT_FLOOR まで)。期待値 > minNetEdgeBps は緩めない。
 *   例外は探索 (ctx.tempoExplore が true のときだけ): 期待値の下限を tempoNetEdgeFloor (minNetEdgeBps - tempo × 往復コスト) に下げる。
 *   tempoExplore が無い・false なら従来どおり。
 *
 * クールダウン: 直前 cooldownBars 本のどれかでも同じ条件が成立していたら見送る (同じ反発での連続エントリーを防ぐ)。
 *
 * 資産クラスは crypto のみ (scalp_micro と同じ理由。meme はスプレッドが大きい)。
 */

/** 保有本数 (1m) の範囲。maxHoldMs を 15〜30 分にする */
export const SCALP_REBOUND_HOLD_BOUNDS: readonly [number, number] = [15, 30];
/** 損切り幅 (エントリー価格から, ATR 倍) の下限。直近安値が近すぎるときはここまで広げる */
export const REBOUND_MIN_STOP_ATR = 0.5;
/** 損切り幅 (ATR 倍) の上限。直近安値が遠すぎる (超えたら見送る) */
export const REBOUND_MAX_STOP_ATR = 3;
/** 1m の ATR の期間 */
const ATR_PERIOD = 14;
/** 1m の RSI の期間 */
const RSI_PERIOD = 7;
/** 1m の短期平均 (EMA) の期間 */
const MEAN_EMA = 20;
/** 15m のトレンド判定の EMA の期間 */
const TREND_EMA = 20;

export interface ReboundSetup {
  /** 1m の ATR(14) */
  atr: number;
  close: number;
  /** 1m の EMA(20) */
  mean: number;
  /** 直近 swingBars 本の安値 */
  swingLow: number;
  /** 直近 rsiLookback 本の RSI(7) の最小値 */
  rsiMin: number;
  rsi: number;
  /** 直近 rsiLookback 本の (EMA - 終値) / ATR の最大 */
  devAtr: number;
  /** 末尾の足の出来高 / 直前 volBars 本の平均 */
  volRatio: number;
  /** 末尾の足の下ひげ / 足の幅 */
  wick: number;
  bullish: boolean;
  /** 15m の EMA(20) の傾き (1 本あたり, bps) */
  trendSlopeBps: number;
  /** 15m の終値の EMA(20) からの乖離 (bps, 負 = 下) */
  trendGapBps: number;
}

/** 1m の判定に必要な最小本数 */
export function reboundMinBars(p: Params): number {
  const lb = period(p.rsiLookback, 2);
  return Math.max(MEAN_EMA + lb, RSI_PERIOD + lb + 1, ATR_PERIOD + 1, period(p.swingBars, 2), period(p.volBars, 2) + 1);
}

/** 15m の判定に必要な最小本数 */
export function reboundMinTrendBars(p: Params): number {
  return TREND_EMA + period(p.trendSlopeBars, 1);
}

/**
 * 15m の確定足で下降トレンドか (EMA(20) の傾きが負、かつ終値が EMA より下)。
 * 成立すれば傾き・乖離 (bps)、しなければ null。純粋関数
 */
export function trendDown15m(c15: readonly Candle[], p: Params): { slopeBps: number; gapBps: number } | null {
  const sb = period(p.trendSlopeBars, 1);
  if (c15.length < reboundMinTrendBars(p)) return null;
  const e = ema(closesOf(c15), TREND_EMA);
  const n = c15.length;
  const now = e[n - 1];
  const before = e[n - 1 - sb];
  const close = c15[n - 1].close;
  if (!Number.isFinite(now) || !Number.isFinite(before) || !(now > 0)) return null;
  const slopeBps = ((now - before) / sb / now) * 1e4;
  const gapBps = ((close - now) / now) * 1e4;
  if (!(slopeBps < 0) || !(gapBps < 0)) return null;
  return { slopeBps, gapBps };
}

/**
 * 末尾の確定足での反発の条件の判定 (1m の売られ過ぎ → 反転 + 15m の下降トレンド)。成立しなければ null。
 * 純粋関数。c1 / c15 はどちらも確定足だけ (末尾が最新)。クールダウンの判定では末尾を切り詰めた配列で呼ぶ
 */
export function detectRebound(c1: readonly Candle[], c15: readonly Candle[], p: Params): ReboundSetup | null {
  const n = c1.length;
  if (n < reboundMinBars(p)) return null;
  const trend = trendDown15m(c15, p);
  if (!trend) return null;

  const lb = period(p.rsiLookback, 2);
  const closes = closesOf(c1);
  const a = atr(c1, ATR_PERIOD)[n - 1];
  if (!(a > 0) || !Number.isFinite(a)) return null;
  const m = ema(closes, MEAN_EMA);
  const r = rsi(closes, RSI_PERIOD);
  const cur = c1[n - 1];
  const mean = m[n - 1];
  if (!Number.isFinite(mean) || !Number.isFinite(r[n - 1]) || !Number.isFinite(r[n - 2])) return null;

  // 1. 売られ過ぎ → 向きが上に変わった
  let rsiMin = Infinity;
  let devAtr = -Infinity;
  for (let i = n - lb; i < n; i++) {
    if (Number.isFinite(r[i]) && r[i] < rsiMin) rsiMin = r[i];
    if (Number.isFinite(m[i])) devAtr = Math.max(devAtr, (m[i] - closes[i]) / a);
  }
  if (!(rsiMin <= p.rsiOversold) || !(r[n - 1] > r[n - 2])) return null;
  // 2. 短期平均からの下方乖離
  if (!(devAtr >= Math.max(0, p.entryThreshold))) return null;
  // 3. 反転の足 (陽線、または長い下ひげで終値が上半分)
  const range = cur.high - cur.low;
  const wick = range > 0 ? (Math.min(cur.open, cur.close) - cur.low) / range : 0;
  const upperHalf = range > 0 && (cur.close - cur.low) / range >= 0.5;
  const bullish = cur.close > cur.open;
  if (!bullish && !(wick >= p.wickRatio && upperHalf)) return null;
  // 4. まだ平均より下 (戻りの余地)
  if (!(cur.close < mean)) return null;

  let swingLow = Infinity;
  for (let i = n - period(p.swingBars, 2); i < n; i++) swingLow = Math.min(swingLow, c1[i].low);
  const vb = period(p.volBars, 2);
  let vsum = 0;
  for (let i = n - 1 - vb; i < n - 1; i++) vsum += c1[i].volume;
  const volAvg = vsum / vb;
  const volRatio = volAvg > 0 ? cur.volume / volAvg : 0;
  return {
    atr: a, close: cur.close, mean, swingLow, rsiMin, rsi: r[n - 1], devAtr, volRatio, wick, bullish,
    trendSlopeBps: trend.slopeBps, trendGapBps: trend.gapBps,
  };
}

/** 1m の末尾 k 本を除いた時点 (その時点の確定足) の 1m / 15m */
function truncatedAt(c1: readonly Candle[], c15: readonly Candle[], k: number): { c1: Candle[]; c15: Candle[] } {
  const a = c1.slice(0, c1.length - k);
  if (a.length === 0) return { c1: a, c15: [] };
  const asOf = a[a.length - 1].ts + TIMEFRAME_MS["1m"];
  return { c1: a, c15: c15.filter((b) => b.ts + TIMEFRAME_MS["15m"] <= asOf) };
}

export interface ScalpReboundOptions {
  id?: string;
  /** 勝率の上乗せの上限 (既定 0.1)。診断用。学習では変えない */
  winEdgeMax?: number;
  /** 期待値 (コスト控除後, bps) の下限 (既定 0)。診断用。学習では変えない */
  minNetEdgeBps?: number;
}

export function createScalpRebound(opts: ScalpReboundOptions = {}): Strategy {
  const winEdgeMax = opts.winEdgeMax ?? DEFAULT_WIN_EDGE_MAX;
  const minNetEdgeBps = opts.minNetEdgeBps ?? 0;
  const strategy: Strategy = {
    id: opts.id ?? "scalp_rebound",
    horizon: "scalp",
    assetClasses: ["crypto"],
    // 主時間足のレジームに依存しない (トレンドの向きは 15m で自前で判定)。trend_up と low_liquidity は対象外
    regimes: ["trend_down", "high_vol", "range"],
    primaryTimeframe: "1m",
    timeframes: ["1m", "15m"],
    warmup: 40,
    defaultParams: {
      /** 直近安値の下に置く損切りの余裕 (ATR 倍)。エントリーからの損切り幅は (価格 - 直近安値) / ATR + これ */
      stopAtr: 0.5,
      /** 利確幅の上限 (ATR 倍)。EMA(20) までの距離のほうが短ければそちら */
      tpAtr: 1.5,
      /** トレーリングは既定で無効 (戻りの一部を取る前提で、利確・時間切れで十分) */
      trailAtr: 0,
      /** 短期平均 (1m の EMA(20)) からの下方乖離 (ATR 倍) の閾値 */
      entryThreshold: 2.0,
      /** 最大保有本数 (1m)。15〜30 分 */
      maxHoldBars: 20,
      /** 売られ過ぎの RSI(7) の閾値 */
      rsiOversold: 25,
      /** 売られ過ぎ・乖離を探す直近の本数 */
      rsiLookback: 5,
      /** 損切りの基準にする直近安値の本数 */
      swingBars: 5,
      /** 15m の EMA(20) の傾きを測る本数 */
      trendSlopeBars: 3,
      /** 反転の足とみなす下ひげの比率 (陽線でないとき) */
      wickRatio: 0.5,
      /** 平均出来高の本数 */
      volBars: 20,
      /** 利確幅 / 往復コストの下限 (k) */
      costMult: 2.5,
      /** 想定スリッページ (片道 bps) */
      slippageBps: 2,
      /** 損切り幅 / スプレッドの下限 */
      minStopSpreads: 4,
      /** 同じ反発で再エントリーしない本数 (1m) */
      cooldownBars: 3,
    },
    paramBounds: {
      stopAtr: [0.1, 1.5],
      tpAtr: [0.8, 4],
      trailAtr: [0, 2],
      entryThreshold: [1, 4],
      maxHoldBars: [SCALP_REBOUND_HOLD_BOUNDS[0], SCALP_REBOUND_HOLD_BOUNDS[1]],
      rsiOversold: [10, 35],
      rsiLookback: [2, 10],
      swingBars: [3, 15],
      trendSlopeBars: [1, 8],
      wickRatio: [0.3, 0.8],
      volBars: [10, 60],
      // 下限 2: 学習でコストの条件を緩めすぎない (scalp_micro と同じ)
      costMult: [2, 5],
      slippageBps: [1, 20],
      minStopSpreads: [3, 10],
      cooldownBars: [1, 10],
    },
    evaluate(ctx: StrategyContext): Signal | null {
      const p = ctx.params;
      const cd = Math.max(1, period(p.cooldownBars, 1));
      const c1 = candlesOf(ctx, "1m", reboundMinBars(p) + cd + 120);
      const c15 = candlesOf(ctx, "15m", reboundMinTrendBars(p) + 60);
      if (c1.length < Math.max(strategy.warmup, reboundMinBars(p))) return null;

      const side = positionSide(ctx);
      if (side) {
        // 保有中: 終値が短期平均 (EMA(20)) に戻ったら手仕舞い (利確・損切り・時間切れはエンジン側)
        const m = ema(closesOf(c1), MEAN_EMA)[c1.length - 1];
        const close = c1[c1.length - 1].close;
        if (side === "long" && Number.isFinite(m) && close >= m) {
          return exitSignal(ctx, strategy, 0.6, "短期平均 (1m EMA20) へ回帰", { mean: m });
        }
        return null;
      }
      if (entryBlocked(ctx)) return null;
      const s = detectRebound(c1, c15, p);
      if (!s) return null;

      // クールダウン: 直前 cd 本でも成立していたら同じ反発とみなして見送る
      for (let k = 1; k <= cd; k++) {
        const t = truncatedAt(c1, c15, k);
        if (detectRebound(t.c1, t.c15, p)) return null;
      }

      const th = Math.max(1e-9, p.entryThreshold);
      const ro = Math.max(1e-9, p.rsiOversold);
      const confidence =
        0.5 +
        0.15 * clamp((s.devAtr - th) / th) +
        0.15 * clamp((ro - s.rsiMin) / ro) +
        0.1 * clamp(s.volRatio - 1) +
        0.1 * (s.bullish && s.wick >= p.wickRatio ? 1 : 0);

      // 損切り: 直近安値 - stopAtr × ATR、利確: min(tpAtr × ATR, 平均までの距離)。標準の buildEntrySignal に ATR 倍で渡す
      const price = refPrice(ctx, "long", s.close);
      const stopAtrEff = Math.max(REBOUND_MIN_STOP_ATR, (price - s.swingLow) / s.atr + Math.max(0, p.stopAtr));
      if (!(stopAtrEff <= REBOUND_MAX_STOP_ATR)) return null;
      const gapAtr = (s.mean - price) / s.atr;
      if (!(gapAtr > 0)) return null;
      const tpAtrEff = Math.min(Math.max(0, p.tpAtr), gapAtr);
      const holdBars = Math.min(SCALP_REBOUND_HOLD_BOUNDS[1], Math.max(SCALP_REBOUND_HOLD_BOUNDS[0], period(p.maxHoldBars)));

      const features: Record<string, number> = {
        rsi7: s.rsi, rsiMin: s.rsiMin, devAtr: s.devAtr, volRatio: s.volRatio, wick: s.wick, bullish: s.bullish ? 1 : 0,
        swingLow: s.swingLow, mean: s.mean, trendSlope15Bps: s.trendSlopeBps, trendGap15Bps: s.trendGapBps,
      };
      const sig = buildEntrySignal({
        ctx: { ...ctx, params: { ...p, stopAtr: stopAtrEff, tpAtr: tpAtrEff, maxHoldBars: holdBars } },
        strategy,
        direction: "long",
        confidence,
        atr: s.atr,
        lastPrice: s.close,
        reason: `15m 下降中の反発: RSI7 ${s.rsiMin.toFixed(0)}→${s.rsi.toFixed(0)} / 乖離 ${s.devAtr.toFixed(1)}ATR / 出来高 ${s.volRatio.toFixed(1)} 倍`,
        features,
      });
      return netEdgeEntry({
        ctx,
        sig,
        price,
        // テンポ (ctx.tempo) では costMult だけを TEMPO_COST_MULT_FLOOR まで緩める (tempo 未指定・0 なら p.costMult そのもの)
        costMult: relaxToward(p.costMult, TEMPO_COST_MULT_FLOOR, ctx.tempo ?? 0),
        maxHoldMs: holdBars * TIMEFRAME_MS["1m"],
        winEdgeMax,
        minNetEdgeBps,
      });
    },
  };
  return strategy;
}

/** 既定の scalp_rebound */
export const scalpRebound: Strategy = createScalpRebound();
