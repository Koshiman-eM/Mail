import type { Candle, EquityPoint, Instrument, Params, Strategy } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { mean, sampleStdev } from "../indicators/series";
import { inferTimeframe, runBacktest } from "./engine";
import { computeMetrics, scoreResult } from "./metrics";
import type { BacktestMetrics, BacktestOptions, BacktestResult } from "./types";

/**
 * パラメータ評価 (学習モジュールが「現行 vs 候補」を比較するのに使う)。
 */

export type EvaluateOptions = Omit<BacktestOptions, "strategy" | "instrument" | "candles" | "params"> & {
  /** 期間を時間で等分した区間数 (安定性の評価用, 既定 3) */
  folds?: number;
  /** scoreResult の最小取引数 (既定 20) */
  minTrades?: number;
  /** 区間スコアのばらつきに掛けるペナルティ係数 (既定 0.5) */
  stabilityWeight?: number;
};

export interface FoldResult {
  from: number;
  to: number;
  metrics: BacktestMetrics;
  score: number;
}

export interface EvaluateResult {
  /** 全期間スコア − stabilityWeight × 区間スコアの標準偏差 */
  score: number;
  /** 全期間の成績 */
  metrics: BacktestMetrics;
  folds: FoldResult[];
  result: BacktestResult;
}

/** 評価額曲線とトレードを [from, to] の区間へ切り出して成績を計算する */
export function sliceMetrics(result: BacktestResult, from: number, to: number): BacktestMetrics {
  const curve = result.equityCurve;
  // 区間開始時点の評価額 = from 以前の最後の点
  let startEq = curve.length > 0 ? curve[0].equity : 0;
  const pts: EquityPoint[] = [];
  for (const p of curve) {
    if (p.ts <= from) startEq = p.equity;
    else if (p.ts <= to) pts.push(p);
  }
  const trades = result.trades.filter((t) => t.exitTs > from && t.exitTs <= to);
  return computeMetrics(trades, [{ ts: from, equity: startEq, mode: "backtest" }, ...pts], startEq);
}

export function evaluateParams(
  strategy: Strategy,
  params: Params,
  instrument: Instrument,
  candles: Candle[],
  opts: EvaluateOptions = {},
): EvaluateResult {
  const { folds: foldsOpt, minTrades: minTradesOpt, stabilityWeight: swOpt, ...bt } = opts;
  const folds = Math.max(1, Math.round(foldsOpt ?? 3));
  const minTrades = minTradesOpt ?? 20;
  const stabilityWeight = swOpt ?? 0.5;
  const result = runBacktest({ ...bt, strategy, instrument, candles, params });
  const full = scoreResult(result.metrics, { minTrades });

  const foldResults: FoldResult[] = [];
  const curve = result.equityCurve;
  if (folds > 1 && curve.length >= 2) {
    const start = curve[0].ts;
    const end = curve[curve.length - 1].ts;
    const step = (end - start) / folds;
    for (let k = 0; k < folds; k++) {
      const from = start + step * k;
      const to = k === folds - 1 ? end : start + step * (k + 1);
      const m = sliceMetrics(result, from, to);
      foldResults.push({ from, to, metrics: m, score: scoreResult(m, { minTrades: Math.max(1, minTrades / folds) }) });
    }
  }
  const spread = foldResults.length > 1 ? sampleStdev(foldResults.map((f) => f.score)) : 0;
  return { score: full - stabilityWeight * spread, metrics: result.metrics, folds: foldResults, result };
}

export type WalkForwardOptions = Omit<BacktestOptions, "strategy" | "instrument" | "candles" | "params" | "tradeFromTs"> & {
  /** 検証 (アウトオブサンプル) 区間の数 (既定 3)。全体は folds + 1 等分される */
  folds?: number;
  /** true: 学習区間を先頭から伸ばす (既定)。false: 直前 1 区間のみで学習 */
  anchored?: boolean;
  minTrades?: number;
};

export interface WalkForwardFold {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  /** 選ばれた候補の添字 */
  chosen: number;
  trainScore: number;
  testScore: number;
  testMetrics: BacktestMetrics;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** 検証区間スコアの平均 */
  score: number;
  /** 候補ごとの選択回数 */
  chosenCounts: number[];
}

/**
 * ウォークフォワード検証: 各区間で学習区間のスコアが最良の候補を選び、直後の区間で検証する。
 * 検証区間の直前にはウォームアップ用の足 (主時間足で warmup + 50 本相当) を付けて走らせる。
 */
export function walkForward(
  strategy: Strategy,
  candidates: Params[],
  instrument: Instrument,
  candles: Candle[],
  opts: WalkForwardOptions = {},
): WalkForwardResult {
  if (candidates.length === 0) throw new Error("walkForward: 候補パラメータがありません");
  const { folds: foldsOpt, anchored: anchoredOpt, minTrades: minTradesOpt, ...bt } = opts;
  const folds = Math.max(1, Math.round(foldsOpt ?? 3));
  const anchored = anchoredOpt ?? true;
  const minTrades = minTradesOpt ?? 20;
  const n = candles.length;
  const seg = Math.floor(n / (folds + 1));
  if (seg < 2) throw new Error("walkForward: データが短すぎます");
  const baseTf = bt.baseTimeframe ?? inferTimeframe(candles);
  const ratio = TIMEFRAME_MS[strategy.primaryTimeframe] / TIMEFRAME_MS[baseTf];
  const leadBars = Math.ceil((strategy.warmup + 50) * ratio);
  const testMinTrades = Math.max(1, minTrades / folds);

  const out: WalkForwardFold[] = [];
  const counts = candidates.map(() => 0);
  for (let k = 1; k <= folds; k++) {
    const testStart = k * seg;
    const testEnd = k === folds ? n : (k + 1) * seg;
    const trainStart = anchored ? 0 : (k - 1) * seg;
    const train = candles.slice(trainStart, testStart);
    let best = 0;
    let bestScore = -Infinity;
    candidates.forEach((params, ci) => {
      const r = runBacktest({ ...bt, baseTimeframe: baseTf, strategy, instrument, candles: train, params });
      const s = scoreResult(r.metrics, { minTrades: minTrades * (train.length / n) });
      if (s > bestScore) {
        bestScore = s;
        best = ci;
      }
    });
    counts[best]++;
    const testCandles = candles.slice(Math.max(0, testStart - leadBars), testEnd);
    const r = runBacktest({
      ...bt,
      baseTimeframe: baseTf,
      strategy,
      instrument,
      candles: testCandles,
      params: candidates[best],
      tradeFromTs: candles[testStart].ts,
    });
    out.push({
      trainFrom: candles[trainStart].ts,
      trainTo: candles[testStart - 1].ts,
      testFrom: candles[testStart].ts,
      testTo: candles[testEnd - 1].ts,
      chosen: best,
      trainScore: bestScore,
      testScore: scoreResult(r.metrics, { minTrades: testMinTrades }),
      testMetrics: r.metrics,
    });
  }
  return { folds: out, score: mean(out.map((f) => f.testScore)), chosenCounts: counts };
}
