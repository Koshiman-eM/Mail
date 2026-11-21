/** ParamTuner 用の検証器のスタブ (区間ごとの成績を決め打ちで返す。オフライン) */
import type { Params, TradeRecord } from "../core/types";
import type { ParamValidator, ValidationRun } from "../learning/tuner";

const PATTERN = [1, 2, 0, -1, 3];

/** 検証データのトレード (要因の基準比率用): 計画通りの損切りと利確が半々で、特定の要因に偏らない */
export function neutralTrades(n = 60): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const win = i % 2 === 1;
    const entryTs = i * 3_600_000;
    return {
      id: `bt-${i}`, mode: "backtest", symbol: "SYN/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction: "long",
      qty: 1, entryTs, entryPrice: 100, intendedEntryPrice: 100, exitTs: entryTs + 60_000, exitPrice: win ? 103 : 98, intendedExitPrice: win ? 103 : 98,
      initialStop: 98, grossPnl: win ? 3 : -2, fees: 0, netPnl: win ? 3 : -2, returnPct: win ? 0.03 : -0.02, rMultiple: win ? 1.5 : -1,
      mfePct: win ? 0.031 : 0.006, maePct: win ? 0.015 : 0.02, exitReason: win ? "take_profit" : "stop", postExitMovePct: -0.01,
      entryContext: {
        regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
        confidence: 0.5, expectedEdgeBps: 30, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "bt",
      },
    } satisfies TradeRecord;
  });
}

/**
 * score(params) を全 5 区間の R 合計に足す検証器 (各区間 tradesPerFold 件)。
 * score が大きい候補は全区間で勝つので、差が 0.03R/取引 以上なら合格する。calls に検証したパラメータを記録する
 */
export function stubValidator(
  score: (p: Params) => number,
  o: { trades?: TradeRecord[]; tradesPerFold?: number } = {},
): ParamValidator & { calls: Params[] } {
  const calls: Params[] = [];
  const v = (async (_s: string, _a: string, p: Params): Promise<ValidationRun> => {
    calls.push(p);
    const d = score(p);
    return {
      dataKey: "stub",
      folds: PATTERN.map((x, i) => ({ from: i * 86_400_000, to: (i + 1) * 86_400_000, trades: o.tradesPerFold ?? 20, sumR: x + d })),
      trades: o.trades ?? neutralTrades(),
    };
  }) as ParamValidator & { calls: Params[] };
  v.calls = calls;
  return v;
}
