import type { EquityPoint, TradeRecord } from "../core/types";
import { mean, sampleStdev } from "../indicators/series";
import type { BacktestMetrics } from "./types";

const YEAR_MS = 365 * 86_400_000;
/** 損失ゼロ時の profitFactor / 下方偏差ゼロ時の sortino の上限 */
export const PROFIT_FACTOR_CAP = 100;
export const RATIO_CAP = 10;

const finite = (x: number, def = 0): number => (Number.isFinite(x) ? x : def);

/** 評価額曲線の最大ドローダウン (ピーク比) */
export function maxDrawdownOf(curve: readonly { equity: number }[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) dd = Math.max(dd, (peak - p.equity) / peak);
  }
  return dd;
}

function medianStep(curve: readonly EquityPoint[]): number {
  const d: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const s = curve[i].ts - curve[i - 1].ts;
    if (s > 0) d.push(s);
  }
  if (d.length === 0) return NaN;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

export interface MetricsOptions {
  /** 評価額曲線の 1 区間の長さ (年率換算用)。省略時は時刻差の中央値 */
  periodMs?: number;
}

/**
 * トレード列と評価額曲線から成績を計算する。
 * initialEquity は曲線の開始評価額 (区間評価では区間開始時点の評価額)。
 */
export function computeMetrics(
  trades: readonly TradeRecord[],
  curve: readonly EquityPoint[],
  initialEquity: number,
  opts: MetricsOptions = {},
): BacktestMetrics {
  const finalEquity = curve.length > 0 ? curve[curve.length - 1].equity : initialEquity;
  const netPnl = finalEquity - initialEquity;

  // 期間リターン
  const rets: number[] = [];
  let prevEq = initialEquity;
  for (const p of curve) {
    if (prevEq > 0) rets.push(p.equity / prevEq - 1);
    prevEq = p.equity;
  }
  // 先頭点が初期評価額そのものなら 0 リターンが 1 つ入るので除く
  if (curve.length > 0 && curve[0].equity === initialEquity && rets.length > 0) rets.shift();
  const step = opts.periodMs ?? medianStep(curve);
  const ppy = step > 0 ? YEAR_MS / step : 0;
  let sharpe = 0;
  let sortino = 0;
  if (rets.length >= 2 && ppy > 0) {
    const m = mean(rets);
    const sd = sampleStdev(rets);
    sharpe = sd > 0 ? (m / sd) * Math.sqrt(ppy) : 0;
    const down = Math.sqrt(mean(rets.map((r) => (r < 0 ? r * r : 0))));
    sortino = down > 0 ? (m / down) * Math.sqrt(ppy) : m > 0 ? RATIO_CAP : 0;
  }

  const n = trades.length;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumR = 0;
  let sumHold = 0;
  let fees = 0;
  let gross = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      wins++;
      grossWin += t.netPnl;
    } else grossLoss -= t.netPnl;
    sumR += finite(t.rMultiple);
    sumHold += t.exitTs - t.entryTs;
    fees += t.fees;
    gross += t.grossPnl;
  }
  const profitFactor = grossLoss > 0 ? Math.min(PROFIT_FACTOR_CAP, grossWin / grossLoss) : grossWin > 0 ? PROFIT_FACTOR_CAP : 0;

  return {
    netPnl,
    returnPct: initialEquity > 0 ? netPnl / initialEquity : 0,
    sharpe: finite(sharpe),
    sortino: finite(sortino),
    maxDrawdown: maxDrawdownOf([{ equity: initialEquity }, ...curve]),
    winRate: n > 0 ? wins / n : 0,
    profitFactor,
    expectancyR: n > 0 ? sumR / n : 0,
    trades: n,
    avgHoldMs: n > 0 ? sumHold / n : 0,
    fees,
    grossPnl: gross,
    finalEquity,
  };
}

export interface ScoreOptions {
  /** これ未満の取引数にはペナルティ (既定 20) */
  minTrades?: number;
  /** 期待値の縮小に使う事前取引数 (既定 10)。n / (n + prior) を掛ける */
  priorTrades?: number;
}

/**
 * 最適化用の単一スコア (大きいほど良い)。
 *   2 × 期待値R (取引数で縮小, ±3 で打ち切り)
 * + 0.5 × シャープ (±5 で打ち切り)
 * − 5 × 最大ドローダウン
 * − 取引数不足ペナルティ ((minTrades − n) / minTrades, 最大 1)
 * 取引ゼロは -1。
 */
export function scoreResult(m: BacktestMetrics, opts: ScoreOptions = {}): number {
  const minTrades = Math.max(1, opts.minTrades ?? 20);
  const prior = Math.max(0, opts.priorTrades ?? 10);
  const n = m.trades;
  const shrink = n > 0 ? n / (n + prior) : 0;
  const exp = Math.max(-3, Math.min(3, finite(m.expectancyR))) * shrink;
  const sh = Math.max(-5, Math.min(5, finite(m.sharpe)));
  const dd = Math.max(0, Math.min(1, finite(m.maxDrawdown)));
  const lowN = n < minTrades ? (minTrades - n) / minTrades : 0;
  return 2 * exp + 0.5 * sh - 5 * dd - lowN;
}
