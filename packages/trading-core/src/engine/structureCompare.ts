/**
 * 相場構造のフィルターの検証 (backtest --structure-compare)。
 * 同じ足・同じ区間で、ラップなし (A) と構造のフィルター・損切りの各条件 (B〜G) を evaluateParams の区間検証で比べる。
 *
 *   A: ラップなし / B: 方法 1 のフィルター (MTF なし) / C: B + MTF / D: C + 構造の損切り
 *   E: D の method2 版 / F: D の wick 版 / G: D の conservative 版
 *
 * 区間ごとの取引回数が 30 未満なら「回数不足」と表示する (フィルターで回数が減るため)。
 * --pivot-sweep は pivotN 4 / 6 / 10 の頑健性を見るだけで、最良の値を選ぶ表示はしない (N は一度決めたら固定して使う)。
 */
import { evaluateParams } from "../backtest/evaluate";
import type { BacktestMetrics } from "../backtest/types";
import type { Strategy } from "../core/types";
import { ALL_STRATEGIES, getStrategy } from "../strategies/registry";
import { defaultStructureSettings, type StructureSettings } from "../structure/settings";
import { isStructureWrapped, withFilterCounter, withStructure, type StructureFilterConfig } from "../structure/wrap";
import { baseTimeframeOf, createBacktestDataLoader, type BacktestCommandOptions } from "./backtestCommand";
import { fmtPct, formatTable } from "./report";
import { strategyLabel } from "../strategies/labels";

export type CompareConditionId = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export interface CompareCondition {
  id: CompareConditionId;
  label: string;
  /** undefined はラップなし */
  config?: Partial<StructureFilterConfig>;
}

/** 比較する条件 (仕様 §7)。base は STRUCTURE_* の設定 (pivotN・バッファ・ちゃぶつきなど) */
export function compareConditions(base: StructureFilterConfig): CompareCondition[] {
  // exitOnReversal / exitOnWeakening は全条件で off に固定する。A (ラップなし) は構造による決済をしないので、
  // B〜G も入口のフィルター・損切りの違いだけを比べられるようにする (STRUCTURE_EXIT_ON_* の設定はここでは無視する)
  const b: StructureFilterConfig = {
    ...base, biasMethod: "method1", breakMode: "close", reversalMode: "purist", useMTF: false, stopMode: "existing",
    exitOnReversal: false, exitOnWeakening: false,
  };
  const d: StructureFilterConfig = { ...b, useMTF: true, stopMode: "structure" };
  return [
    { id: "A", label: "ラップなし" },
    { id: "B", label: "方法1のフィルター", config: b },
    { id: "C", label: "B + MTF", config: { ...b, useMTF: true } },
    { id: "D", label: "C + 構造の損切り", config: d },
    { id: "E", label: "D の method2", config: { ...d, biasMethod: "method2" } },
    { id: "F", label: "D の wick", config: { ...d, breakMode: "wick" } },
    { id: "G", label: "D の conservative", config: { ...d, reversalMode: "conservative" } },
  ];
}

/** 頑健性の確認に使う pivotN (仕様 §7。最良の値を選ぶためのものではない) */
export const PIVOT_SWEEP: readonly number[] = [4, 6, 10];
/** 区間ごとの取引回数の目安 (これ未満は「回数不足」) */
export const MIN_TRADES_PER_FOLD = 30;

export interface CompareRow {
  strategyId: string;
  condition: CompareConditionId;
  label: string;
  /** --pivot-sweep のときの pivotN (A は undefined) */
  pivotN?: number;
  metrics?: BacktestMetrics;
  foldTrades: number[];
  /** 構造のフィルターで通さなかった件数 (理由別) */
  filtered: Record<string, number>;
  insufficient: boolean;
  note?: string;
}

export interface StructureCompareOptions extends Omit<BacktestCommandOptions, "strategies"> {
  /** 設定 (STRUCTURE_*)。省略時は既定値 */
  settings?: StructureSettings;
  /** 区間数 (既定 5) */
  folds?: number;
  pivotSweep?: boolean;
}

/** --strategy all の対象: 設定のフィルター対象 (無ければ既定の対象) のうち、履歴で再現できるもの */
export function compareTargets(strategy: string, settings: StructureSettings): Strategy[] {
  if (strategy !== "all") {
    const s = getStrategy(strategy);
    if (!s) throw new Error(`未知の戦略: ${strategy}`);
    return [s];
  }
  const ids = settings.strategies.length ? settings.strategies : defaultStructureSettings().strategies;
  return ALL_STRATEGIES.filter((s) => ids.includes(s.id) && !s.requiresBook);
}

export async function runStructureCompare(o: StructureCompareOptions): Promise<CompareRow[]> {
  const settings = o.settings ?? defaultStructureSettings();
  const folds = Math.max(2, Math.round(o.folds ?? 5));
  const targets = compareTargets(o.strategy, settings);
  const loader = await createBacktestDataLoader(o);
  const pivots = o.pivotSweep ? [...PIVOT_SWEEP] : [settings.config.pivotN];
  const rows: CompareRow[] = [];

  for (const raw of targets) {
    if (raw.requiresBook) {
      rows.push({ strategyId: raw.id, condition: "A", label: "ラップなし", foldTrades: [], filtered: {}, insufficient: true, note: "板情報が必要なため対象外" });
      continue;
    }
    // 条件の一覧 (pivot-sweep なら N ごとに B〜G)。A は 1 回だけ
    const runs: { cond: CompareCondition; pivotN?: number; strategy: Strategy }[] = [];
    for (const [i, n] of pivots.entries()) {
      for (const cond of compareConditions({ ...settings.config, pivotN: n })) {
        if (!cond.config) {
          if (i === 0) runs.push({ cond, strategy: raw });
          continue;
        }
        runs.push({ cond, ...(o.pivotSweep ? { pivotN: n } : {}), strategy: withStructure(raw, cond.config) });
      }
    }
    // 全条件で同じ足・同じ取引開始時刻を使う (ウォームアップは最も長い条件に合わせる)
    const lead = Math.max(...runs.map((r) => r.strategy.warmup)) + 50;
    const longest = runs.reduce((a, r) => (r.strategy.warmup > a.warmup ? r.strategy : a), raw);
    const data = await loader.load(longest, lead);
    for (const r of runs) {
      const base: CompareRow = {
        strategyId: raw.id, condition: r.cond.id, label: r.cond.label, ...(r.pivotN !== undefined ? { pivotN: r.pivotN } : {}),
        foldTrades: [], filtered: {}, insufficient: true,
      };
      if (data.candles.length === 0) {
        rows.push({ ...base, note: "足を取得できませんでした" });
        continue;
      }
      const filtered: Record<string, number> = {};
      const ev = evaluateParams(isStructureWrapped(r.strategy) ? withFilterCounter(r.strategy, filtered) : r.strategy, raw.defaultParams, data.instrument, data.candles, {
        baseTimeframe: baseTimeframeOf(raw),
        tradeFromTs: data.tradeFromTs,
        folds,
        ...(o.minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio: o.minEdgeToCostRatio } : {}),
        ...(o.riskPerTrade !== undefined ? { riskPerTrade: o.riskPerTrade } : {}),
        ...(o.maxPositionPct !== undefined ? { maxPositionPct: o.maxPositionPct } : {}),
      });
      const foldTrades = ev.folds.map((f) => f.metrics.trades);
      const insufficient = foldTrades.length === 0 || foldTrades.some((t) => t < MIN_TRADES_PER_FOLD);
      rows.push({ ...base, metrics: ev.metrics, foldTrades, filtered, insufficient, ...(insufficient ? { note: "回数不足" } : {}) });
    }
  }
  return rows;
}

const fmtHold = (ms: number): string => {
  if (!(ms > 0)) return "-";
  const h = ms / 3_600_000;
  return h >= 24 ? `${(h / 24).toFixed(1)}日` : h >= 1 ? `${h.toFixed(1)}時間` : `${Math.round(ms / 60_000)}分`;
};

const REASON_SHORT: Record<string, string> = {
  structure_none: "none", structure_weakening: "weak", structure_choppy: "chop", structure_bias: "bias", structure_mtf: "mtf",
  structure_po: "po", structure_stop: "stop",
};

export function formatCompareRows(rows: readonly CompareRow[]): string {
  const sweep = rows.some((r) => r.pivotN !== undefined);
  const headers = ["戦略", "条件", ...(sweep ? ["N"] : []), "PF", "最大DD", "期待値R", "取引数", "勝率", "平均保有", "区間の取引数", "除外 (理由別)", "備考"];
  return formatTable(
    headers,
    rows.map((r) => {
      const m = r.metrics;
      const filtered = Object.entries(r.filtered)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${REASON_SHORT[k] ?? k} ${v}`)
        .join(" ");
      return [
        strategyLabel(r.strategyId), `${r.condition} ${r.label}`, ...(sweep ? [r.pivotN !== undefined ? String(r.pivotN) : "-"] : []),
        m ? m.profitFactor.toFixed(2) : "-", m ? fmtPct(m.maxDrawdown) : "-", m ? m.expectancyR.toFixed(3) : "-", m ? m.trades : "-",
        m ? fmtPct(m.winRate, 1) : "-", m ? fmtHold(m.avgHoldMs) : "-", r.foldTrades.length ? r.foldTrades.join("/") : "-",
        filtered || "-", r.note ?? "",
      ];
    }),
  );
}

/** 表の下に付ける注記 */
export function compareFootnotes(o: { folds: number; pivotSweep?: boolean }): string[] {
  return [
    `※ 各条件は同じ足・同じ取引開始時刻で、期間を ${o.folds} 区間に分けた evaluateParams で評価。区間ごとの取引が ${MIN_TRADES_PER_FOLD} 回未満の条件は「回数不足」(結論に使わない)。`,
    "※ 除外: none=目線なし weak=転換の途中 chop=ちゃぶつき bias=目線と逆 mtf=上位足と不一致 po=パーフェクトオーダー不一致 stop=構造の損切りが置けない。",
    "※ 1 つの銘柄・期間だけで良い結果は採用しない (複数の銘柄・期間で確かめる)。",
    ...(o.pivotSweep ? ["※ pivotN 4 / 6 / 10 は頑健性 (結果が N に敏感でないか) を見るためのもの。最良の N を選ぶためのものではない。"] : []),
  ];
}
