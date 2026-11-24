/**
 * バックテストの検証の補助 (実データの長期の検証用。純粋関数):
 * - 保有 (buy & hold) の成績: 同じ期間の最初の始値 → 最後の終値のリターンと、終値の最大ドローダウン
 * - 区間別の成績 (1 回の通しのバックテストを時間で k 等分して切り出す。evaluate.ts の foldBoundaries・sliceMetrics)
 * - 複数銘柄の合計 (戦略ごと): 取引数・合計 R・勝率・PF (損益は各銘柄の初期評価額に対する比率で合算) と、
 *   等加重の合成の評価額曲線 (各銘柄の評価額 / 初期評価額 の平均) の最大ドローダウン
 * - 実際に取れた期間と、要求より短いときの警告
 */
import type { BacktestResult } from "../backtest/types";
import { foldBoundaries, sliceMetrics } from "../backtest/evaluate";
import { maxDrawdownOf, PROFIT_FACTOR_CAP } from "../backtest/metrics";
import type { Candle, EquityPoint, TradeRecord } from "../core/types";
import { fmtPct, fmtTime, formatTable } from "./report";
import { strategyLabel } from "../strategies/labels";

const DAY = 86_400_000;

/** 実際にトレードの対象にした期間 (ウォームアップを除く) */
export interface BacktestPeriod {
  /** 要求した開始時刻 (until − --days) */
  requestedFrom: number;
  /** 実際の開始時刻 (最初にトレードの対象にした足) */
  from: number;
  /** 実際の終了時刻 (最後の足の終わり) */
  to: number;
}

/** 保有 (buy & hold) の成績 */
export interface BuyAndHold {
  from: number;
  to: number;
  /** 最初の始値 → 最後の終値 */
  returnPct: number;
  /** 終値の最大ドローダウン (ピーク比。最初の始値をピークの初期値にする) */
  maxDrawdown: number;
  /** 価値の推移 (最初の始値 = 1。合成の曲線用に sampleMs ごとに間引く) */
  curve: { ts: number; value: number }[];
}

/**
 * 保有の成績。fromTs 以降の足の最初の始値で買い、最後の足の終値まで持つ。足が無ければ undefined。
 * curve は sampleMs (既定 1 時間) ごとに間引く (最後の足は必ず入れる)
 */
export function buyAndHold(candles: readonly Candle[], fromTs: number, baseMs: number, sampleMs = 3_600_000): BuyAndHold | undefined {
  const start = candles.findIndex((c) => c.ts >= fromTs);
  if (start < 0) return undefined;
  const first = candles[start];
  const last = candles[candles.length - 1];
  if (!(first.open > 0)) return undefined;
  let peak = first.open;
  let dd = 0;
  const curve: { ts: number; value: number }[] = [{ ts: first.ts, value: 1 }];
  let lastSample = first.ts;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (c.close > peak) peak = c.close;
    if (peak > 0) dd = Math.max(dd, (peak - c.close) / peak);
    const end = c.ts + baseMs;
    if (end - lastSample >= sampleMs || i === candles.length - 1) {
      curve.push({ ts: end, value: c.close / first.open });
      lastSample = end;
    }
  }
  return { from: first.ts, to: last.ts + baseMs, returnPct: last.close / first.open - 1, maxDrawdown: dd, curve };
}

/** 区間ごとの成績 (取引は決済時刻で区間に入れる) */
export interface FoldSummary {
  from: number;
  to: number;
  trades: number;
  totalR: number;
  winRate: number;
  profitFactor: number;
  returnPct: number;
}

/**
 * 通しのバックテストの結果を [from, to) を folds 等分した区間で切り出す (evaluate.ts の sliceMetrics)。
 * 区間どうしは独立ではない (建玉・評価額は持ち越す)。folds < 2 なら空
 */
export function foldSummaries(result: Pick<BacktestResult, "trades" | "equityCurve">, from: number, to: number, folds: number): FoldSummary[] {
  if (!(folds >= 2)) return [];
  const b = foldBoundaries(from, to, folds);
  const out: FoldSummary[] = [];
  for (let i = 0; i + 1 < b.length; i++) {
    const m = sliceMetrics(result as BacktestResult, b[i], b[i + 1]);
    out.push({ from: b[i], to: b[i + 1], trades: m.trades, totalR: m.expectancyR * m.trades, winRate: m.winRate, profitFactor: m.profitFactor, returnPct: m.returnPct });
  }
  return out;
}

/** 合計 R (rMultiple が無限・NaN の取引は 0) */
export function totalR(trades: readonly Pick<TradeRecord, "rMultiple">[]): number {
  return trades.reduce((s, t) => s + (Number.isFinite(t.rMultiple) ? t.rMultiple : 0), 0);
}

/** 銘柄ごとの 1 戦略の結果 (合計の入力) */
export interface SymbolStrategyResult {
  symbol: string;
  strategyId: string;
  initialEquity: number;
  trades: readonly TradeRecord[];
  equityCurve: readonly EquityPoint[];
  benchmark?: BuyAndHold;
}

/** 戦略ごとの複数銘柄の合計 */
export interface AggregateRow {
  strategyId: string;
  symbols: number;
  trades: number;
  totalR: number;
  winRate: number;
  /** 総利益 / 総損失 (各取引の損益を銘柄の初期評価額で割ってから合算。通貨が違っても比べられる) */
  profitFactor: number;
  /** 等加重の合成のリターン (= 各銘柄のリターンの平均) */
  returnPct: number;
  /** 等加重の合成の評価額曲線の最大ドローダウン */
  maxDrawdown: number;
  /** 保有の等加重の合成 (各銘柄の保有の平均リターン・合成の曲線の最大ドローダウン) */
  benchmarkReturnPct?: number;
  benchmarkMaxDrawdown?: number;
}

/**
 * 等加重の合成の曲線: 各系列 (正規化した値、最初は 1) の「その時刻までの最後の値」の平均。
 * 系列が始まる前は 1 (現金)、終わった後は最後の値のまま
 */
export function equalWeightCurve(series: readonly (readonly { ts: number; value: number }[])[]): { ts: number; value: number }[] {
  const live = series.filter((s) => s.length > 0);
  if (live.length === 0) return [];
  const times = [...new Set(live.flatMap((s) => s.map((p) => p.ts)))].sort((a, b) => a - b);
  const idx = live.map(() => -1);
  const out: { ts: number; value: number }[] = [];
  for (const t of times) {
    let sum = 0;
    live.forEach((s, k) => {
      while (idx[k] + 1 < s.length && s[idx[k] + 1].ts <= t) idx[k]++;
      sum += idx[k] >= 0 ? s[idx[k]].value : 1;
    });
    out.push({ ts: t, value: sum / live.length });
  }
  return out;
}

/** 戦略ごとに銘柄を合計する (戦略の並びは入力の最初の出現順) */
export function aggregateAcrossSymbols(results: readonly SymbolStrategyResult[]): AggregateRow[] {
  const byStrategy = new Map<string, SymbolStrategyResult[]>();
  for (const r of results) byStrategy.set(r.strategyId, [...(byStrategy.get(r.strategyId) ?? []), r]);
  const out: AggregateRow[] = [];
  for (const [strategyId, rs] of byStrategy) {
    let trades = 0;
    let wins = 0;
    let gw = 0;
    let gl = 0;
    let sumR = 0;
    for (const r of rs) {
      const eq = r.initialEquity > 0 ? r.initialEquity : 1;
      for (const t of r.trades) {
        trades++;
        const p = t.netPnl / eq;
        if (t.netPnl > 0) {
          wins++;
          gw += p;
        } else gl -= p;
      }
      sumR += totalR(r.trades);
    }
    const curves = rs.map((r) => {
      const eq = r.initialEquity > 0 ? r.initialEquity : 1;
      return r.equityCurve.map((p) => ({ ts: p.ts, value: p.equity / eq }));
    });
    const combined = equalWeightCurve(curves);
    const finalValues = curves.map((c) => (c.length ? c[c.length - 1].value : 1));
    const benches = rs.map((r) => r.benchmark).filter((b): b is BuyAndHold => b !== undefined);
    const benchCurve = equalWeightCurve(benches.map((b) => b.curve));
    out.push({
      strategyId,
      symbols: rs.length,
      trades,
      totalR: sumR,
      winRate: trades > 0 ? wins / trades : 0,
      profitFactor: gl > 0 ? Math.min(PROFIT_FACTOR_CAP, gw / gl) : gw > 0 ? PROFIT_FACTOR_CAP : 0,
      returnPct: finalValues.reduce((s, v) => s + v, 0) / finalValues.length - 1,
      maxDrawdown: maxDrawdownOf([{ equity: 1 }, ...combined.map((p) => ({ equity: p.value }))]),
      ...(benches.length
        ? {
          benchmarkReturnPct: benches.reduce((s, b) => s + b.returnPct, 0) / benches.length,
          benchmarkMaxDrawdown: maxDrawdownOf([{ equity: 1 }, ...benchCurve.map((p) => ({ equity: p.value }))]),
        }
        : {}),
    });
  }
  return out;
}

/** 期間の日数 */
export const periodDays = (p: { from: number; to: number }): number => (p.to - p.from) / DAY;

/**
 * 実際の期間が要求より短いときの警告 (無ければ undefined)。
 * 許容: 開始が要求より toleranceMs (既定 1 日) 以上遅い、または終了が expectedTo より toleranceMs 以上早いとき
 */
export function coverageWarning(p: BacktestPeriod, expectedTo: number, toleranceMs = DAY): string | undefined {
  const lateStart = p.from - p.requestedFrom >= toleranceMs;
  const earlyEnd = expectedTo - p.to >= toleranceMs;
  if (!lateStart && !earlyEnd) return undefined;
  const want = (expectedTo - p.requestedFrom) / DAY;
  return (
    `実際の期間は ${fmtDate(p.from)} 〜 ${fmtDate(p.to)} (${periodDays(p).toFixed(1)} 日) で、要求の ${want.toFixed(1)} 日より短いです` +
    `${lateStart ? " (取引所・プールの履歴の先頭、または上場日に達しました)" : ""}${earlyEnd ? " (最近の足が欠けています)" : ""}。取れた分だけで計算しています`
  );
}

const fmtDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** 実際の期間の表示 (例: 2024-02-27 〜 2026-11-24 (1000.0 日)) */
export const formatPeriod = (p: { from: number; to: number }): string => `${fmtDate(p.from)} 〜 ${fmtDate(p.to)} (${periodDays(p).toFixed(1)} 日)`;

const fmtR = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}R` : "-");
const fmtPf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const fmtSignedPct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : ""}${fmtPct(x)}`);

/** 区間別の表 (1 戦略 × 1 銘柄) */
export function formatFoldRows(folds: readonly FoldSummary[]): string {
  return formatTable(
    ["区間", "開始", "終了", "取引数", "合計R", "勝率", "PF", "リターン"],
    folds.map((f, i) => [`${i + 1}`, fmtTime(f.from), fmtTime(f.to), f.trades, fmtR(f.totalR), fmtPct(f.winRate, 1), fmtPf(f.profitFactor), fmtSignedPct(f.returnPct)]),
  );
}

/** 複数銘柄の合計の表 */
export function formatAggregateRows(rows: readonly AggregateRow[]): string {
  return formatTable(
    ["戦略", "銘柄数", "取引数", "合計R", "勝率", "PF", "リターン(等加重)", "最大DD(合成)", "保有リターン", "保有DD(合成)"],
    rows.map((r) => [
      strategyLabel(r.strategyId), r.symbols, r.trades, fmtR(r.totalR), fmtPct(r.winRate, 1), fmtPf(r.profitFactor), fmtSignedPct(r.returnPct),
      fmtPct(r.maxDrawdown), fmtSignedPct(r.benchmarkReturnPct), r.benchmarkMaxDrawdown === undefined ? "-" : fmtPct(r.benchmarkMaxDrawdown),
    ]),
  );
}
