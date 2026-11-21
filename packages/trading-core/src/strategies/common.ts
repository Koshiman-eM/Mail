import type { Candle, IntelBias, Signal, Strategy, StrategyContext, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { roundToStep, toNum } from "../core/decimal";
import { canShort } from "../core/short";

/** 戦略共通ヘルパー */

export const clamp = (x: number, lo = 0, hi = 1): number => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);

/** 期間系パラメータを 1 以上の整数へ */
export const period = (x: number, min = 1): number => Math.max(min, Math.round(Number.isFinite(x) ? x : min));

/** 配列末尾 n 件 */
export function tail<T>(arr: readonly T[] | undefined, n: number): T[] {
  if (!arr) return [];
  return arr.length > n ? arr.slice(arr.length - n) : arr.slice();
}

/** 指定時間足の確定足 (末尾 n 本まで) */
/**
 * 足 [from, to] (添字、両端を含む) に出来高が不明な足 (volumeKnown === false。Jupiter の価格のポーリングで作った足) があるか。
 * 出来高を使う条件 (出来高の倍率など) は、不明な足があれば満たさない扱いにする (0 を「出来高が少ない」と誤読しない。fail-closed)。
 * ccxt・合成データの足は volumeKnown を持たない (= 分かっている) ので常に false (従来どおり)
 */
export function volumeUnknown(c: readonly Candle[], from: number, to: number): boolean {
  for (let i = Math.max(0, from); i <= Math.min(c.length - 1, to); i++) if (c[i].volumeKnown === false) return true;
  return false;
}

/** 出来高の平均の窓 + 今の足 (本数)。short_breakout の出来高の判定 (直前の 20 本の平均と今の足) が見る範囲 */
export const VOLUME_WINDOW_BARS = 21;

/**
 * 主時間足の末尾 VOLUME_WINDOW_BARS 本に出来高が不明な足があるか (volumeUnknown の末尾の窓版)。
 * Strategy.needsVolume の戦略をエンジンが待たせる (評価済みにしない) かの判定に使う
 */
export function volumeWindowUnknown(c: readonly Candle[]): boolean {
  return volumeUnknown(c, c.length - VOLUME_WINDOW_BARS, c.length - 1);
}

export function candlesOf(ctx: StrategyContext, tf: Timeframe, n: number): Candle[] {
  return tail(ctx.market.candles[tf], n);
}

/** 保有方向 (なければ undefined) */
export function positionSide(ctx: StrategyContext): "long" | "short" | undefined {
  const q = ctx.position?.qty ?? 0;
  if (q > 0) return "long";
  if (q < 0) return "short";
  return undefined;
}

/** 新規エントリーを禁止する状況 (低流動性) */
export function entryBlocked(ctx: StrategyContext): boolean {
  return ctx.regime.label === "low_liquidity";
}

/** 成行エントリーの想定価格 (買いは ask、売りは bid。気配が無効なら fallback) */
export function refPrice(ctx: StrategyContext, dir: "long" | "short", fallback: number): number {
  const q = ctx.market.quote;
  const p = dir === "long" ? q?.ask : q?.bid;
  return p !== undefined && Number.isFinite(p) && p > 0 ? p : fallback;
}

const roundTick = (price: number, tick: number): number => (tick > 0 ? toNum(roundToStep(price, tick)) : price);

type StrategyMeta = Pick<Strategy, "id" | "horizon" | "primaryTimeframe">;

export interface EntryArgs {
  ctx: StrategyContext;
  strategy: StrategyMeta;
  direction: "long" | "short";
  /** 0〜1 (チルト前) */
  confidence: number;
  /** 主時間足の ATR */
  atr: number;
  /** 直近終値 (気配が無いときの想定価格) */
  lastPrice: number;
  reason: string;
  features: Record<string, number>;
}

/**
 * 標準パラメータ (stopAtr, tpAtr, trailAtr, maxHoldBars) から ATR ベースのエントリーシグナルを作り、
 * インテルのチルトを適用して返す。条件不正 (ATR 無効・ショート不可など) なら null。
 */
export function buildEntrySignal(a: EntryArgs): Signal | null {
  const { ctx, strategy, direction } = a;
  const p = ctx.params;
  const inst = ctx.market.instrument;
  // 実効の空売り可否 (取引所で可能か、paper で再現する銘柄で ctx.mode が paper のとき。live では allowShort だけ)
  if (direction === "short" && !canShort(inst, ctx.mode)) return null;
  if (!(a.atr > 0) || !Number.isFinite(a.atr)) return null;
  const price = refPrice(ctx, direction, a.lastPrice);
  if (!(price > 0)) return null;

  const sign = direction === "long" ? 1 : -1;
  const stopDist = Math.max(0, p.stopAtr ?? 1) * a.atr;
  const tpDist = Math.max(0, p.tpAtr ?? 0) * a.atr;
  if (!(stopDist > 0)) return null;
  const stopLoss = roundTick(price - sign * stopDist, inst.tickSize);
  if (!(stopLoss > 0)) return null;
  const tpRaw = price + sign * tpDist;
  const takeProfit = tpDist > 0 && tpRaw > 0 ? roundTick(tpRaw, inst.tickSize) : undefined;
  const trailAtr = p.trailAtr ?? 0;
  const trailingStopPct = trailAtr > 0 ? (trailAtr * a.atr) / price : undefined;
  const confidence = clamp(a.confidence);
  // 利確が無い場合はトレーリング幅 (なければ損切り幅) を目安にする
  const targetDist = takeProfit !== undefined ? tpDist : Math.max(trailAtr * a.atr, stopDist);
  const expectedEdgeBps = (targetDist / price) * 1e4 * confidence;
  const maxHoldMs = period(p.maxHoldBars ?? 1) * TIMEFRAME_MS[strategy.primaryTimeframe];

  const signal: Signal = {
    strategyId: strategy.id,
    horizon: strategy.horizon,
    symbol: inst.symbol,
    direction,
    confidence,
    expectedEdgeBps,
    entry: { type: "market" },
    stopLoss,
    takeProfit,
    trailingStopPct,
    maxHoldMs,
    reason: a.reason,
    features: { ...a.features, atr: a.atr, atrPct: a.atr / price },
  };
  return applyIntelTilt(signal, ctx.intel, ctx.market.now);
}

/** 保有中の反転 (エグジット) シグナル */
export function exitSignal(
  ctx: StrategyContext,
  strategy: StrategyMeta,
  confidence: number,
  reason: string,
  features: Record<string, number>,
): Signal {
  return {
    strategyId: strategy.id,
    horizon: strategy.horizon,
    symbol: ctx.market.instrument.symbol,
    direction: "flat",
    confidence: clamp(confidence),
    expectedEdgeBps: 0,
    entry: { type: "market" },
    stopLoss: 0,
    maxHoldMs: 0,
    reason,
    features,
  };
}

/** 同方向のインテルで confidence を上げる最大割合 */
const TILT_UP = 0.2;
/** 逆方向のインテルで confidence を下げる最大割合 */
const TILT_DOWN = 0.5;

/**
 * インテル (情報バイアス) によるシグナル補正。
 * - blackoutUntil > now ならエントリー不可 (null)。エグジット (flat) はそのまま通す。
 * - sentiment × confidence (インテル側の確信度) を一致度とし、
 *   同方向なら最大 +20%、逆方向なら最大 -50% confidence を補正する (0〜1 にクランプ)。
 * - expectedEdgeBps も同じ比率で補正する。
 */
export function applyIntelTilt(signal: Signal, intel: IntelBias | undefined, now: number): Signal | null {
  if (signal.direction === "flat") return signal;
  if (!intel) return signal;
  if (intel.blackoutUntil !== undefined && intel.blackoutUntil > now) return null;
  const sign = signal.direction === "long" ? 1 : -1;
  const agreement = clamp(intel.sentiment, -1, 1) * clamp(intel.confidence) * sign;
  const factor = agreement >= 0 ? 1 + TILT_UP * agreement : 1 + TILT_DOWN * agreement;
  const confidence = clamp(signal.confidence * factor);
  const ratio = signal.confidence > 0 ? confidence / signal.confidence : 0;
  return {
    ...signal,
    confidence,
    expectedEdgeBps: signal.expectedEdgeBps * ratio,
    features: { ...signal.features, intelSentiment: intel.sentiment, intelAgreement: agreement },
  };
}
