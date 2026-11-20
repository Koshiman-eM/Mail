/** レポート (simulate / report コマンド・ダッシュボード) 用の集計と日本語の表整形 */
import type { CauseCode, EquityPoint, ExitReason, Store, TradeRecord } from "../core/types";
import { CAUSE_LABEL } from "../learning/attribution";
import { FORECAST_FEATURES, FORECAST_FEATURE_LABEL, type ForecastSummary } from "../learning/forecast";
import type { NewsCheckSummary } from "../learning/newsCheck";
import type { CauseSummary, LearningSnapshot } from "../learning/service";
import { SIMULATED_SHORT_ARM_SUFFIX } from "../learning/allocator";
import { microReasonLabel, sideLabel, SIMULATED_SHORT_LABEL, type ShadowGroup, type ShadowSummary } from "../learning/shadow";
import { quoteCurrencyOfSymbol } from "./fx";
import type { LimitStats } from "./orders";
import { THESIS_OUTCOME_LABEL, type ThesisOutcome } from "./thesis";
import { REVERSAL_EXIT_LABEL, reversalDetailLabel } from "./reversalExit";
import { armLabel, strategyLabel } from "../strategies/labels";

export const EXIT_REASON_LABEL: Record<ExitReason, string> = {
  stop: "損切り",
  take_profit: "利確",
  trailing: "トレーリング",
  signal: "シグナル",
  time: "時間切れ",
  kill_switch: "キルスイッチ",
  manual: "手動",
  thesis_failed: "読み外れ(途中)",
  thesis_timeout: "読み外れ(期限)",
  thesis_cap: "延長の上限",
  reversal: REVERSAL_EXIT_LABEL,
  wallet_reset: "リセットで決済",
};

/** 決済理由の表示名。転換で決済は方向が分かれば中身 (買い: 押し安値割れ / 売り: 戻り高値超え) を添える */
export function exitReasonLabel(reason: string, direction?: "long" | "short"): string {
  const base = EXIT_REASON_LABEL[reason as ExitReason] ?? reason;
  return reason === "reversal" && direction ? `${base} (${reversalDetailLabel(direction)})` : base;
}

export const ADJUSTMENT_STATUS_LABEL: Record<string, string> = {
  proposed: "提案のみ",
  applied: "適用",
  rejected: "却下",
  reverted: "差し戻し",
};

export interface StrategySummary {
  strategyId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** 純損益 (口座通貨, 換算できないトレードは除外) */
  netPnl: number;
  fees: number;
  avgR: number;
  /** 口座通貨へ換算できなかった件数 */
  unconverted: number;
}

/** 決済時点の為替レート (エンジンが監査ログ engine.exit に残したもの)。tradeId → レート */
export function exitFxRates(store: Pick<Store, "listAudit">, since?: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of store.listAudit({ type: "engine.exit", ...(since !== undefined ? { since } : {}) })) {
    const id = a.data.tradeId;
    const rate = a.data.fxRate;
    if (typeof id === "string" && typeof rate === "number" && Number.isFinite(rate) && rate > 0) out.set(id, rate);
  }
  return out;
}

/**
 * 1 トレードの純損益・手数料を口座通貨へ (換算できなければ undefined)。
 * 決済時点のレート (rate) があればそれを、無ければ toAccount (現在のレート) を使う。
 */
export function tradePnlAccount(
  t: TradeRecord,
  toAccount: (ccy: string) => number,
  quoteCurrency?: string,
  exitRate?: number,
): { net: number; fees: number } | undefined {
  const rate = exitRate !== undefined && Number.isFinite(exitRate) && exitRate > 0 ? exitRate : toAccount(quoteCurrency ?? quoteCurrencyOfSymbol(t.symbol));
  if (!Number.isFinite(rate) || !(rate > 0)) return undefined;
  return { net: t.netPnl * rate, fees: t.fees * rate };
}

/** 戦略別の成績 (取引数の多い順) */
export function summarizeByStrategy(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): StrategySummary[] {
  const map = new Map<string, StrategySummary & { sumR: number }>();
  for (const t of trades) {
    let s = map.get(t.strategyId);
    if (!s) map.set(t.strategyId, (s = { strategyId: t.strategyId, trades: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, fees: 0, avgR: 0, unconverted: 0, sumR: 0 }));
    s.trades++;
    if (t.netPnl > 0) s.wins++;
    else if (t.netPnl < 0) s.losses++;
    s.sumR += Number.isFinite(t.rMultiple) ? t.rMultiple : 0;
    const pnl = tradePnlAccount(t, toAccount, quoteOf?.(t), exitRates?.get(t.id));
    if (pnl) {
      s.netPnl += pnl.net;
      s.fees += pnl.fees;
    } else s.unconverted++;
  }
  return [...map.values()]
    .map(({ sumR, ...s }) => ({ ...s, winRate: s.trades ? s.wins / s.trades : 0, avgR: s.trades ? sumR / s.trades : 0 }))
    .sort((a, b) => b.trades - a.trades);
}

/** 方向別の成績 (買い / 売り (取引所で空売り可) / 空売り (paper 再現)) */
export interface SideSummary extends Omit<StrategySummary, "strategyId"> {
  /** "long" / "short" / "simulated_short" */
  side: "long" | "short" | "simulated_short";
  label: string;
}

const SIDE_ORDER: SideSummary["side"][] = ["long", "short", "simulated_short"];

/** paper で再現した空売り (live では実行できない取引) か */
export const isSimulatedShortTrade = (t: Pick<TradeRecord, "direction" | "simulatedShort">) => t.direction === "short" && t.simulatedShort === true;

/** live でも実行できる取引だけ (paper で再現した空売りを除く。bitbank 現物なら買いのみ) */
export const liveExecutableTrades = <T extends Pick<TradeRecord, "direction" | "simulatedShort">>(trades: T[]): T[] =>
  trades.filter((t) => !isSimulatedShortTrade(t));

/**
 * 方向別の成績 (件数のある方向だけ。買い → 売り → 空売り (paper 再現) の順)。
 * 空売り (paper 再現) は live では実行できないので、買い・取引所で可能な売りと分けて表示する
 */
export function summarizeBySide(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): SideSummary[] {
  const sideOf = (t: TradeRecord): SideSummary["side"] => (t.direction === "long" ? "long" : t.simulatedShort ? "simulated_short" : "short");
  const rows = summarizeByStrategy(
    trades.map((t) => ({ ...t, strategyId: sideOf(t) })),
    toAccount,
    quoteOf,
    exitRates,
  );
  return rows
    .map(({ strategyId, ...r }) => {
      const side = strategyId as SideSummary["side"];
      return { ...r, side, label: side === "long" ? sideLabel("long") : sideLabel("short", side === "simulated_short") };
    })
    .sort((a, b) => SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side));
}

/** 方向別の成績の表と「live で実際にできる成績」の注記 */
export function renderSideTable(rows: SideSummary[], ccy: string): string {
  if (rows.length === 0) return "  (トレードなし)";
  const table = formatTable(
    ["方向", "取引数", "勝率", `純損益(${ccy})`, `手数料(${ccy})`, "平均R"],
    rows.map((r) => [r.label, r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), fmtNum(r.fees, 0), r.avgR.toFixed(2)]),
  );
  const sim = rows.find((r) => r.side === "simulated_short");
  const live = rows.filter((r) => r.side !== "simulated_short");
  const liveN = live.reduce((a, r) => a + r.trades, 0);
  const liveWins = live.reduce((a, r) => a + r.wins, 0);
  const livePnl = live.reduce((a, r) => a + r.netPnl, 0);
  const lines = [table];
  lines.push(
    `  live で実際にできる成績 (${SIMULATED_SHORT_LABEL}を除く。現物は買いのみ): ${liveN} 件 / 勝率 ${fmtPct(liveN ? liveWins / liveN : 0, 1)} / 純損益 ${fmtSigned(livePnl)} ${ccy}`,
  );
  if (sim) {
    lines.push(
      `  ※ ${SIMULATED_SHORT_LABEL} = 取引所では空売りできない現物を paper でだけ売り建てた取引 (借入コストは手数料に含む)。live では空売りしません。`,
    );
  }
  return lines.join("\n");
}

/** 注文の種類別 (エントリーの成行 / 指値) の取引数・手数料の内訳・平均の手数料率 */
export interface OrderTypeSummary {
  orderType: "market" | "limit";
  label: string;
  trades: number;
  /** 決済が指値 (板に置いた利確) で約定した取引数 */
  limitExits: number;
  /** 純損益・手数料 (口座通貨) */
  netPnl: number;
  fees: number;
  /** liquidity 別の手数料 (口座通貨。maker は受け取りなら負)。内訳の無い古い取引の分は unclassified */
  makerFees: number;
  takerFees: number;
  unclassified: number;
  /** 平均の手数料率 (片道, bps) = Σ手数料 ÷ Σ(エントリー + 決済の約定代金) */
  avgFeeBps: number;
  unconverted: number;
}

const ORDER_TYPE_LABEL = { market: "成行", limit: "指値" } as const;

/** 注文の種類別の集計 (エントリーの注文の種類。記録の無い古い取引は成行) */
export function summarizeByOrderType(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): OrderTypeSummary[] {
  const map = new Map<"market" | "limit", OrderTypeSummary & { notional: number }>();
  for (const t of trades) {
    const k = t.entryOrderType ?? "market";
    let s = map.get(k);
    if (!s) {
      map.set(k, (s = {
        orderType: k, label: ORDER_TYPE_LABEL[k], trades: 0, limitExits: 0, netPnl: 0, fees: 0, makerFees: 0, takerFees: 0, unclassified: 0, avgFeeBps: 0, unconverted: 0, notional: 0,
      }));
    }
    s.trades++;
    if (t.exitOrderType === "limit") s.limitExits++;
    // 換算レートは tradePnlAccount と同じ (決済時点のレート、無ければ現在のレート)
    const er = exitRates?.get(t.id);
    const rate = er !== undefined && Number.isFinite(er) && er > 0 ? er : toAccount(quoteOf?.(t) ?? quoteCurrencyOfSymbol(t.symbol));
    if (!Number.isFinite(rate) || !(rate > 0)) {
      s.unconverted++;
      continue;
    }
    const pnl = { net: t.netPnl * rate, fees: t.fees * rate };
    s.netPnl += pnl.net;
    s.fees += pnl.fees;
    if (t.makerFees !== undefined || t.takerFees !== undefined) {
      const m = (t.makerFees ?? 0) * rate;
      const x = (t.takerFees ?? 0) * rate;
      s.makerFees += m;
      s.takerFees += x;
      s.unclassified += pnl.fees - m - x;
    } else s.unclassified += pnl.fees;
    const cs = t.contractSize ?? 1;
    const notional = Math.abs(t.qty) * cs * (Math.abs(t.entryPrice) + Math.abs(t.exitPrice)) * rate;
    if (Number.isFinite(notional)) s.notional += notional;
  }
  return [...map.values()]
    .map(({ notional, ...s }) => ({ ...s, unclassified: Math.abs(s.unclassified) < 1e-9 ? 0 : s.unclassified, avgFeeBps: notional > 0 ? (s.fees / notional) * 10_000 : 0 }))
    .sort((a, b) => (a.orderType === b.orderType ? 0 : a.orderType === "market" ? -1 : 1));
}

/** 注文の種類別の表 */
export function renderOrderTypeTable(rows: OrderTypeSummary[], ccy: string): string {
  if (rows.length === 0) return "  (トレードなし)";
  const table = formatTable(
    ["エントリー", "取引数", "決済が指値", `純損益(${ccy})`, `手数料(${ccy})`, "maker", "taker", "内訳なし", "平均手数料率(片道)"],
    rows.map((r) => [
      r.label, r.trades, r.limitExits, fmtSigned(r.netPnl), fmtNum(r.fees, 0), fmtSigned(r.makerFees, 1), fmtSigned(r.takerFees, 1), fmtNum(r.unclassified, 0),
      `${r.avgFeeBps.toFixed(2)}bps`,
    ]),
  );
  const maker = rows.reduce((a, r) => a + r.makerFees, 0);
  const taker = rows.reduce((a, r) => a + r.takerFees, 0);
  return `${table}\n  手数料の内訳 (全体): maker ${fmtSigned(maker, 1)} ${ccy} / taker ${fmtSigned(taker, 1)} ${ccy} (maker の負は受け取り)`;
}

/** 指値の約定率 (置いた数・約定・期限切れ・取消) */
export function renderLimitStats(s: LimitStats | undefined): string {
  if (!s) return "  (記録なし)";
  const canceled = Object.entries(s.entryCanceled ?? {}).filter(([, v]) => (v ?? 0) > 0);
  const canceledN = canceled.reduce((a, [, v]) => a + (v ?? 0), 0);
  const done = s.entryFilled + s.entryPartial + s.entryExpired + canceledN;
  const fillRate = done > 0 ? (s.entryFilled + s.entryPartial) / done : NaN;
  const label: Record<string, string> = {
    opposite_signal: "逆シグナル", stop_crossed: "損切り越え", halted: "停止", order_unknown: "状態不明の注文", account_unavailable: "口座取得不可", market_data: "気配の不具合",
  };
  const lines = [
    `  エントリー: 置いた ${s.entryPlaced} / 約定 ${s.entryFilled} / 一部約定 ${s.entryPartial} / 期限切れ ${s.entryExpired} / 取消 ${canceledN}` +
      (canceled.length ? ` (${canceled.map(([k, v]) => `${label[k] ?? k} ${v}`).join(", ")})` : "") +
      ` / 拒否 ${s.entryRejected}  約定率 ${fmtPct(fillRate, 1)}`,
    `  利確の指値: 置いた ${s.tpPlaced} / 約定 ${s.tpFilled} / 一部約定 ${s.tpPartial} / 決済のため取消 ${s.tpCanceled} / 拒否 ${s.tpRejected}`,
  ];
  if (s.since !== undefined) lines.push(`  (集計開始 ${fmtTime(s.since)})`);
  return lines.join("\n");
}

/** テンポ (エントリー頻度の目標) による区分: 探索 / テンポのモードの通常 / テンポ無効 */
export type TempoClass = "explore" | "tempo_normal" | "no_tempo";

export interface TempoSummary extends Omit<StrategySummary, "strategyId"> {
  kind: TempoClass;
  label: string;
  /** うち空売り (paper 再現。live では実行できない) の件数・純損益 (口座通貨) */
  simShortTrades: number;
  simShortNetPnl: number;
}

/** 区分の行に「うち空売り (paper 再現)」の件数・純損益を付ける (区分のキー → 件数・純損益) */
function simShortByKey(
  trades: TradeRecord[],
  keyOf: (t: TradeRecord) => string,
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): Map<string, { trades: number; netPnl: number }> {
  const rows = summarizeByStrategy(
    trades.filter(isSimulatedShortTrade).map((t) => ({ ...t, strategyId: keyOf(t) })),
    toAccount,
    quoteOf,
    exitRates,
  );
  return new Map(rows.map((r) => [r.strategyId, { trades: r.trades, netPnl: r.netPnl }]));
}

/** 「うち空売り (paper 再現)」の列 (該当する行が無ければ列を出さない) と注記 */
const SIM_SHORT_COLUMN = "うち空売り(paper再現)";
const simShortCell = (r: { simShortTrades: number; simShortNetPnl: number }) =>
  r.simShortTrades > 0 ? `${r.simShortTrades} 件 (${fmtSigned(r.simShortNetPnl)})` : "-";
const SIM_SHORT_NOTE =
  `  ※ うち空売り (paper 再現) = 取引所では空売りできない現物を paper でだけ売り建てた取引 (各区分の件数・純損益に含む)。live では空売りしません。live で実際にできる成績は「方向別の成績」を参照`;

const TEMPO_CLASS_ORDER: TempoClass[] = ["explore", "tempo_normal", "no_tempo"];
const TEMPO_CLASS_LABEL: Record<TempoClass, string> = {
  explore: "探索 (期待値 ≤ 0、縮小サイズ)",
  tempo_normal: "通常 (テンポ有効)",
  no_tempo: "通常 (テンポ無効)",
};

/**
 * 取引のテンポの区分。エンジンがテンポのモードでエントリーした取引は entryContext.features.tempoLevel を持ち、
 * 探索のエントリーは features.tempoExplore = 1 (古い取引・テンポ無効のときは印なし)
 */
export function tempoClassOf(t: Pick<TradeRecord, "entryContext">): TempoClass {
  const f = t.entryContext?.features;
  if (f && f.tempoExplore === 1) return "explore";
  if (f && typeof f.tempoLevel === "number") return "tempo_normal";
  return "no_tempo";
}

/** テンポの区分別の成績 (件数のある区分だけ。探索 → 通常 (テンポ有効) → 通常 (テンポ無効) の順) */
export function summarizeByTempo(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): TempoSummary[] {
  const rows = summarizeByStrategy(
    trades.map((t) => ({ ...t, strategyId: tempoClassOf(t) })),
    toAccount,
    quoteOf,
    exitRates,
  );
  const sim = simShortByKey(trades, tempoClassOf, toAccount, quoteOf, exitRates);
  return rows
    .map(({ strategyId, ...r }) => ({
      ...r, kind: strategyId as TempoClass, label: TEMPO_CLASS_LABEL[strategyId as TempoClass] ?? strategyId,
      simShortTrades: sim.get(strategyId)?.trades ?? 0, simShortNetPnl: sim.get(strategyId)?.netPnl ?? 0,
    }))
    .sort((a, b) => TEMPO_CLASS_ORDER.indexOf(a.kind) - TEMPO_CLASS_ORDER.indexOf(b.kind));
}

/** テンポの区分別の成績の表 (探索の取引が無ければその旨を添える) */
export function renderTempoTable(rows: TempoSummary[], ccy: string): string {
  if (rows.length === 0) return "  (トレードなし)";
  const sim = rows.some((r) => (r.simShortTrades ?? 0) > 0);
  const table = formatTable(
    ["区分", "取引数", "勝率", `純損益(${ccy})`, `手数料(${ccy})`, "平均R", ...(sim ? [SIM_SHORT_COLUMN] : [])],
    rows.map((r) => [
      r.label, r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), fmtNum(r.fees, 0), r.avgR.toFixed(2), ...(sim ? [simShortCell(r)] : []),
    ]),
  );
  const notes: string[] = [];
  if (!rows.some((r) => r.kind === "explore")) notes.push("  探索のエントリーはありません");
  notes.push("  ※ 探索 = テンポで期待値の下限を下げて入った、コスト控除後の期待値が 0 以下の取引 (TEMPO_EXPLORE_SIZE 倍のサイズ)");
  if (sim) notes.push(SIM_SHORT_NOTE);
  return [table, ...notes].join("\n");
}

// ───────── 読みの答え合わせ (読みの管理 THESIS_EXIT) ─────────

export interface ThesisRow extends Omit<StrategySummary, "strategyId"> {
  outcome: ThesisOutcome;
  label: string;
  /** うち空売り (paper 再現。live では実行できない) の件数・純損益 (口座通貨) */
  simShortTrades: number;
  simShortNetPnl: number;
}

export interface ThesisSummary {
  /** 区分別 (途中で読み外れ / 期限で読み外れ / 期限で読み当たり→延長 / 期限前に決着。件数のある区分だけ) */
  rows: ThesisRow[];
  /** 延長した取引の期限からの追加の保有時間の平均 (分) */
  extendedAvgExtraMinutes: number;
  /** 延長した取引の最終的な決済理由 */
  extendedExits: Partial<Record<ExitReason, number>>;
  /** 期限での的中率 = 延長 / (延長 + 期限で読み外れ)。どちらも 0 件なら NaN */
  deadlineHitRate: number;
  extended: number;
  timeout: number;
  /** 読みの管理の記録が無い取引 (古い取引・無効のとき・期限の無い建玉) */
  untracked: number;
}

const THESIS_ORDER: ThesisOutcome[] = ["failed_early", "timeout", "extended", "none"];

/** 読みの答え合わせの集計 (TradeRecord.thesisOutcome がある取引だけ) */
export function summarizeThesis(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): ThesisSummary {
  const tracked = trades.filter((t) => t.thesisOutcome !== undefined);
  const sim = simShortByKey(tracked, (t) => t.thesisOutcome!, toAccount, quoteOf, exitRates);
  const rows = summarizeByStrategy(
    tracked.map((t) => ({ ...t, strategyId: t.thesisOutcome! })),
    toAccount,
    quoteOf,
    exitRates,
  )
    .map(({ strategyId, ...r }) => ({
      ...r, outcome: strategyId as ThesisOutcome, label: THESIS_OUTCOME_LABEL[strategyId as ThesisOutcome] ?? strategyId,
      simShortTrades: sim.get(strategyId)?.trades ?? 0, simShortNetPnl: sim.get(strategyId)?.netPnl ?? 0,
    }))
    .sort((a, b) => THESIS_ORDER.indexOf(a.outcome) - THESIS_ORDER.indexOf(b.outcome));
  const ext = tracked.filter((t) => t.thesisOutcome === "extended");
  const extra = ext.map((t) => Math.max(0, t.exitTs - (t.thesisDeadlineTs ?? t.thesisExtendedAt ?? t.exitTs)) / 60_000);
  const extended = ext.length;
  const timeout = tracked.filter((t) => t.thesisOutcome === "timeout").length;
  return {
    rows,
    extendedAvgExtraMinutes: extra.length ? extra.reduce((a, b) => a + b, 0) / extra.length : 0,
    extendedExits: exitReasonCounts(ext),
    deadlineHitRate: extended + timeout > 0 ? extended / (extended + timeout) : NaN,
    extended,
    timeout,
    untracked: trades.length - tracked.length,
  };
}

/** 読みの答え合わせの表 (report / simulate 共通) */
export function renderThesisTable(s: ThesisSummary | undefined, ccy: string): string {
  if (!s || s.rows.length === 0) {
    return `  (読みの管理の記録がある取引はまだありません${s && s.untracked ? `。記録なし ${s.untracked} 件 (古い取引・THESIS_EXIT=false・期限の無い建玉)` : ""})`;
  }
  const sim = s.rows.some((r) => (r.simShortTrades ?? 0) > 0);
  const lines = [
    formatTable(
      ["区分", "取引数", "勝率", `純損益(${ccy})`, "平均R", ...(sim ? [SIM_SHORT_COLUMN] : [])],
      s.rows.map((r) => [r.label, r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), r.avgR.toFixed(2), ...(sim ? [simShortCell(r)] : [])]),
    ),
  ];
  lines.push(
    `  期限での的中率: ${fmtPct(s.deadlineHitRate, 1)} (延長 ${s.extended} / (延長 ${s.extended} + 期限で読み外れ ${s.timeout}))`,
  );
  if (s.extended > 0) {
    const exits = Object.entries(s.extendedExits).map(([k, v]) => `${EXIT_REASON_LABEL[k as ExitReason] ?? k} ${v}`).join(" / ");
    lines.push(`  延長した取引: 期限からの追加の保有 平均 ${s.extendedAvgExtraMinutes.toFixed(1)} 分 / 最終的な決済: ${exits || "-"}`);
  }
  if (s.untracked > 0) lines.push(`  ※ 読みの管理の記録が無い取引 ${s.untracked} 件は含みません (古い取引・THESIS_EXIT=false・期限の無い建玉)`);
  if (sim) lines.push(SIM_SHORT_NOTE);
  return lines.join("\n");
}

// ───────── 転換で決済 (REVERSAL_EXIT) ─────────

export interface ReversalRow extends Omit<StrategySummary, "strategyId" | "losses" | "fees"> {
  /** long: 押し安値割れ (買い) / short: 戻り高値超え (売り) / total: 合計 */
  key: "long" | "short" | "total";
  label: string;
  /** 決済時に値動きでプラスだった件数 (手数料前の損益 grossPnl > 0) */
  inProfit: number;
  /** 勝ち (純損益 > 0) の取引の、利確までの距離のうち取れた割合の平均 (値動きの R ÷ 計画の利確の R)。対象が無ければ NaN */
  tpCapture: number;
  /** tpCapture の対象 (利確のある勝ちの取引) の件数 */
  tpCaptureN: number;
}

export interface ReversalSummary {
  /** 方向別 (件数のある方向だけ) と合計 (最後の行) */
  rows: ReversalRow[];
  /** 合計 (rows の最後の行と同じ。転換で決済が 0 件なら件数 0 の行) */
  total: ReversalRow;
  /** うち空売り (paper 再現。live では実行できない) の件数・純損益 (口座通貨) */
  simShortTrades: number;
  simShortNetPnl: number;
}

/**
 * 利確までの距離のうち取れた割合 = 値動きの R ÷ 計画の利確の R = 方向 × (決済価格 − 建値) / |利確価格 − 建値|
 * (どちらも当初の損切り幅で割った R なので、損切り幅は約分される。手数料を含めない)。利確が無い・距離が 0 なら NaN
 */
export function tpCaptureOf(t: Pick<TradeRecord, "direction" | "entryPrice" | "exitPrice" | "takeProfit">): number {
  if (t.takeProfit === undefined || !Number.isFinite(t.takeProfit)) return NaN;
  const dist = Math.abs(t.takeProfit - t.entryPrice);
  if (!(dist > 0) || !Number.isFinite(t.exitPrice)) return NaN;
  return ((t.direction === "long" ? 1 : -1) * (t.exitPrice - t.entryPrice)) / dist;
}

/** 転換で決済 (exitReason === "reversal") の取引の集計 (方向別と合計) */
export function summarizeReversal(
  trades: TradeRecord[],
  toAccount: (ccy: string) => number,
  quoteOf?: (t: TradeRecord) => string | undefined,
  exitRates?: Map<string, number>,
): ReversalSummary {
  const rev = trades.filter((t) => t.exitReason === "reversal");
  const rowOf = (key: ReversalRow["key"], label: string, list: TradeRecord[]): ReversalRow => {
    const s = summarizeByStrategy(list.map((t) => ({ ...t, strategyId: key })), toAccount, quoteOf, exitRates)[0];
    const caps = list.filter((t) => t.netPnl > 0).map(tpCaptureOf).filter((x) => Number.isFinite(x));
    return {
      key, label, trades: list.length, wins: s?.wins ?? 0, winRate: s?.winRate ?? 0, netPnl: s?.netPnl ?? 0, avgR: s?.avgR ?? 0,
      unconverted: s?.unconverted ?? 0, inProfit: list.filter((t) => t.grossPnl > 0).length,
      tpCapture: caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : NaN, tpCaptureN: caps.length,
    };
  };
  const rows: ReversalRow[] = [];
  for (const dir of ["long", "short"] as const) {
    const list = rev.filter((t) => t.direction === dir);
    if (list.length) rows.push(rowOf(dir, `${reversalDetailLabel(dir)} (${dir === "long" ? "買い" : "売り"})`, list));
  }
  const total = rowOf("total", "合計", rev);
  rows.push(total);
  const sim = simShortByKey(rev, () => "reversal", toAccount, quoteOf, exitRates).get("reversal");
  return { rows, total, simShortTrades: sim?.trades ?? 0, simShortNetPnl: sim?.netPnl ?? 0 };
}

/** 転換で決済の表 (report / simulate 共通) */
export function renderReversalTable(s: ReversalSummary | undefined, ccy: string): string {
  if (!s || s.total.trades === 0) return "  (転換で決済した取引はまだありません)";
  const lines = [
    formatTable(
      ["区分", "取引数", "勝率", `純損益(${ccy})`, "平均R", "含み益で決済", "利確までの距離のうち取れた割合 (勝ち)"],
      s.rows.map((r) => [
        r.label, r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), r.avgR.toFixed(2), `${r.inProfit} 件`,
        r.tpCaptureN ? `${fmtPct(r.tpCapture, 1)} (${r.tpCaptureN} 件)` : "-",
      ]),
    ),
    "  ※ 含み益で決済 = 決済時に値動きでプラス (手数料前)。取れた割合 = 値動きの R ÷ 計画の利確の R (利確のある勝ちの取引の平均。100% で利確と同じ)",
  ];
  if (s.simShortTrades > 0) {
    lines.push(`  ※ うち空売り (paper 再現) ${s.simShortTrades} 件 (純損益 ${fmtSigned(s.simShortNetPnl)} ${ccy})。live では空売りしません`);
  }
  return lines.join("\n");
}

export function exitReasonCounts(trades: TradeRecord[]): Partial<Record<ExitReason, number>> {
  const out: Partial<Record<ExitReason, number>> = {};
  for (const t of trades) out[t.exitReason] = (out[t.exitReason] ?? 0) + 1;
  return out;
}

export interface EquityStats {
  first: number;
  last: number;
  max: number;
  min: number;
  maxDrawdown: number;
  points: number;
  from?: number;
  to?: number;
}

export function equityStats(points: EquityPoint[]): EquityStats | undefined {
  if (points.length === 0) return undefined;
  let peak = points[0].equity;
  let dd = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) dd = Math.max(dd, (peak - p.equity) / peak);
    max = Math.max(max, p.equity);
    min = Math.min(min, p.equity);
  }
  return { first: points[0].equity, last: points[points.length - 1].equity, max, min, maxDrawdown: dd, points: points.length, from: points[0].ts, to: points[points.length - 1].ts };
}

// ───────── 表示 ─────────

/** 全角文字を幅 2 として数える */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

const pad = (s: string, w: number, right: boolean) => {
  const fill = " ".repeat(Math.max(0, w - strWidth(s)));
  return right ? fill + s : s + fill;
};

/** 等幅の表。数値の列は右寄せ */
export function formatTable(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map((c) => (typeof c === "number" ? fmtNum(c) : c)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === "number" || /^[-+]?[\d,.]+[%R]?$/.test(String(r[i] ?? ""))));
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...cells.map((r) => strWidth(r[i] ?? ""))));
  const line = (r: string[]) => r.map((c, i) => pad(c ?? "", widths[i], numeric[i])).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}

export function fmtNum(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "-";
  const abs = Math.abs(x);
  const d = abs >= 1000 ? 0 : abs >= 1 ? digits : Math.max(digits, 4);
  return x.toLocaleString("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: d });
}

export const fmtPct = (x: number, digits = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "-");
export const fmtSigned = (x: number, digits = 0) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toLocaleString("ja-JP", { maximumFractionDigits: digits })}` : "-");
export const fmtTime = (ts: number | undefined) => (ts === undefined ? "-" : new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z");

export function renderStrategyTable(rows: StrategySummary[], ccy: string): string {
  if (rows.length === 0) return "  (トレードなし)";
  return formatTable(
    ["戦略", "取引数", "勝率", `純損益(${ccy})`, `手数料(${ccy})`, "平均R"],
    rows.map((r) => [strategyLabel(r.strategyId), r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), fmtNum(r.fees, 0), r.avgR.toFixed(2)]),
  );
}

export function renderCauses(c: CauseSummary): string {
  if (c.trades === 0) return "  (要因分析なし)";
  const codes = Object.keys(c.all) as CauseCode[];
  codes.sort((a, b) => (c.all[b] ?? 0) - (c.all[a] ?? 0));
  const head = `  ${c.trades} 件 (勝ち ${c.outcomes.win} / 負け ${c.outcomes.loss} / 引き分け ${c.outcomes.breakeven})`;
  const table = formatTable(
    ["要因", "件数", "負けで", "勝ちで", "重み計"],
    codes.map((k) => [`${CAUSE_LABEL[k] ?? k} (${k})`, c.all[k] ?? 0, c.loss[k] ?? 0, c.win[k] ?? 0, (c.weighted[k] ?? 0).toFixed(2)]),
  );
  return `${head}\n${table}`;
}

const SHADOW_EXIT_LABEL: Record<string, string> = {
  stop: "損切り", take_profit: "利確", time: "時間切れ", unwatched: "監視終了", trailing: "トレーリング",
  thesis_failed: "読み外れ(途中)", thesis_timeout: "読み外れ(期限)", thesis_cap: "延長の上限", reversal: REVERSAL_EXIT_LABEL,
};

function shadowGroupTable(title: string, rows: ShadowGroup[], limit: number, keyLabel: (key: string) => string = (k) => k): string {
  return formatTable(
    [title, "件数", "勝率", "平均純R", "純R合計"],
    rows.slice(0, limit).map((g) => [keyLabel(g.key), g.n, fmtPct(g.winRate, 1), fmtR(g.avgNetR), fmtR(g.sumNetR, 2)]),
  );
}

const fmtR = (x: number, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "-");

/** 見送ったシグナルの答え合わせ (仮想トレード) の表示 */
export function renderShadow(s: ShadowSummary | undefined, opts: { limit?: number } = {}): string {
  if (!s) return "  (集計なし)";
  const limit = opts.limit ?? 15;
  const c = s.counters;
  const out: string[] = [];
  const exits = Object.entries(s.exitReasons).map(([k, v]) => `${SHADOW_EXIT_LABEL[k] ?? k} ${v}`).join(" / ");
  out.push(
    `  決済 ${s.closed} 件 (勝率 ${fmtPct(s.winRate, 1)}, 平均純R ${fmtR(s.avgNetR)})  未決済 ${s.open} 件` + (exits ? `  決済理由: ${exits}` : ""),
  );
  out.push(
    `  作成 ${c.created} / 重複で見送り ${c.duplicate} / 上限で破棄 ${c.droppedCap} / 毎分上限で破棄 ${c.droppedRate} / 監視終了で破棄 ${c.unwatched} / 不正 ${c.invalid}`,
  );
  if (s.closed === 0) {
    out.push("  (決済済みの仮想トレードはまだありません)");
    return out.join("\n");
  }
  if (s.bySide && s.bySide.some((g) => g.key === SIMULATED_SHORT_LABEL)) out.push(shadowGroupTable("方向", s.bySide, limit), "");
  out.push(shadowGroupTable("見送り理由", s.byReason, limit));
  out.push("", shadowGroupTable("戦略", s.byStrategy, limit, strategyLabel));
  if (s.micro && s.micro.some((g) => g.n > 0)) {
    out.push(
      "",
      `  ${strategyLabel("scalp_micro")} / ${strategyLabel("scalp_rebound")} の答え合わせ`,
      formatTable(
        ["戦略", "見送り理由", "件数", "利確到達率", "ランダム時の勝率 p0", "平均R (コスト前)", "平均純R"],
        s.micro.slice(0, 2 * (limit + 1)).map((g) => [g.strategyId ? strategyLabel(g.strategyId) : "-", microReasonLabel(g.key), g.n, fmtPct(g.tpRate, 1), fmtPct(g.p0, 1), fmtR(g.avgGrossR), fmtR(g.avgNetR)]),
      ),
      "  ※ 利確到達率が p0 を安定して上回るなら、値動きに優位性があります。平均R (コスト前) が正でも平均純R が負なら、手数料が利益を上回っています。どれも発注していない記録です (コストで見送ったものは腕の学習にも使いません)。",
    );
  }
  out.push("  ※ 純R = 往復手数料・スプレッド・約定ずれ (片道 2bps 既定) を差し引いた値。平均純R が正の見送り理由は、フィルターが厳しすぎる可能性があります (設定は自動では変えません)。");
  return out.join("\n");
}

/** ニュースと値動きの答え合わせの表示 */
export function renderNewsCheck(n: NewsCheckSummary | undefined): string {
  if (!n) return "  (集計なし)";
  const out: string[] = [];
  out.push(`  記録 ${n.recorded} 件 / 判定待ち ${n.pending} 件 / 上限で破棄 ${n.droppedCap} / 監視終了で破棄 ${n.droppedUnwatched}`);
  const judged = n.sources.reduce((a, x) => a + x.n, 0);
  if (n.sources.length === 0 || judged + n.sources.reduce((a, x) => a + x.noise + x.expired, 0) === 0) {
    out.push("  (判定済みのニュースはまだありません)");
    return out.join("\n");
  }
  out.push(
    formatTable(
      ["情報源", "判定", "的中", "的中率", "ノイズ", ...n.horizons.map((h) => `${h} 的中/判定`)],
      n.sources.map((x) => [
        x.source, x.n, x.hits, fmtPct(x.n ? x.hitRate : NaN, 1), x.noise,
        ...n.horizons.map((h) => (x.byHorizon[h] ? `${x.byHorizon[h].hits}/${x.byHorizon[h].n}` : "0/0")),
      ]),
    ),
  );
  out.push(
    "",
    formatTable(
      ["時間", "判定", "的中", "的中率", "ノイズ", "期限切れ"],
      n.byHorizon.map((h) => [h.horizon, h.n, h.hits, fmtPct(h.n ? h.hitRate : NaN, 1), h.noise, h.expired]),
    ),
  );
  out.push("  ※ ノイズ = |変化率| < max(1 分足 ATR 比 × √分数 × 0.5, 往復コスト比) の動きは判定せず数えません。");
  return out.join("\n");
}

const fmtW = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(3)}` : "-");

/** 値動きの予想の答え合わせの表示 */
export function renderForecast(f: ForecastSummary | undefined): string {
  if (!f) return "  (集計なし)";
  const o = f.options;
  const out: string[] = [];
  out.push(
    `  mode ${f.mode} / 予想 ${f.recorded} 件 (${o.intervalMs / 60_000} 分ごと × ${f.horizons.join("・")}) / 判定待ち ${f.pending} 件 / 学習 ${f.learned} 件` +
      ` / 上限で破棄 ${f.droppedCap} / 監視終了で破棄 ${f.droppedUnwatched}  (集計は直近 ${Math.round(f.windowMs / 86_400_000)} 日)`,
  );
  const judged = f.byHorizon.reduce((a, g) => a + g.n + g.noise + g.flatPred - g.flatHits + g.expired, 0);
  if (judged === 0) {
    out.push("  (判定済みの予想はまだありません)");
  } else {
    const liveLabel = (g: { live: boolean; n: number }) => (g.live ? "LIVE (反映中)" : g.n < o.minSamples ? `学習中 (${g.n}/${o.minSamples})` : "未反映 (有意差なし)");
    out.push(
      formatTable(
        ["時間", "資産クラス", "判定", "的中", "的中率", "z", "Brier", "flat予想", "ノイズ", "期限切れ", "取引への反映"],
        f.byClass.map((g) => [
          g.horizon, g.assetClass ?? "-", g.n, g.hits, fmtPct(g.n ? g.hitRate : NaN, 1), g.z.toFixed(2), g.brierN ? g.brier.toFixed(4) : "-",
          g.flatPred, g.noise, g.expired, liveLabel(g),
        ]),
      ),
    );
    out.push(
      "",
      formatTable(
        ["時間", "判定", "的中率", "Brier", "flat予想 (うち結果も flat)", "ノイズ"],
        f.byHorizon.map((g) => [g.horizon, g.n, fmtPct(g.n ? g.hitRate : NaN, 1), g.brierN ? g.brier.toFixed(4) : "-", `${g.flatPred} (${g.flatHits})`, g.noise]),
      ),
    );
    const sym = f.bySymbol.filter((g) => g.n + g.noise > 0).slice(0, 30);
    if (sym.length) {
      out.push(
        "",
        formatTable(
          ["時間", "銘柄", "判定", "的中率", "Brier", "ノイズ"],
          sym.map((g) => [g.horizon, g.symbol ?? "-", g.n, fmtPct(g.n ? g.hitRate : NaN, 1), g.brierN ? g.brier.toFixed(4) : "-", g.noise]),
        ),
      );
    }
    out.push("", "  較正 (pUp を 0.1 刻みに分けたときの実際の上昇率。件数のある区間だけ)");
    for (const c of f.calibration) {
      const bins = c.bins.filter((b) => b.n > 0);
      out.push(
        `  ${c.horizon}: ` +
          (bins.length ? bins.map((b) => `${b.lo.toFixed(1)}-${b.hi.toFixed(1)} 上昇 ${fmtPct(b.upRate, 0)} (n=${b.n})`).join(" / ") : "(なし)"),
      );
    }
  }
  out.push("", "  特徴量の重み (オンラインのロジスティック回帰。news = ブリーフのバイアスの学習済みの重みで、情報源の信頼度とは別の指標)");
  out.push(
    f.models.length
      ? formatTable(
          ["時間|資産クラス", ...FORECAST_FEATURES.map((k) => FORECAST_FEATURE_LABEL[k]), "バイアス", "学習件数"],
          f.models.map((m) => [m.key, ...FORECAST_FEATURES.map((k) => fmtW(m.weights[k])), fmtW(m.bias), m.updates]),
        )
      : "  (まだ学習していません。初期値は全特徴量 +0.050、バイアス 0)",
  );
  const live = f.byClass.filter((g) => g.live).map((g) => `${g.horizon}/${g.assetClass}`);
  out.push(
    `  取引への反映: ${live.length ? `反映中 ${live.join(", ")}` : "なし (どの時間・資産クラスも実力は未確認。倍率 1.0)"}` +
      ` — 条件: 判定 ${o.minSamples} 件以上かつ的中率が 50% を有意に上回る (片側 95%, 重複を補正した z ≥ ${o.zCritical}。z = 二項検定の正規近似 ÷ √(予想時間 ÷ 予想の間隔))。` +
      `一致で最大 ${(1 + o.maxBoost).toFixed(1)} 倍、逆で最小 ${(1 - o.maxCut).toFixed(1)} 倍 (リスク管理の上限は不変)`,
  );
  out.push(`  ※ 的中率 = 方向の予想 (up/down) と方向の結果の組だけ。flat の予想 (|pUp−0.5| < ${o.flatThreshold}) と結果がノイズの範囲内 (|変化率| < max(1 分足 ATR 比 × √分数 × ${o.noiseAtrMult}, 往復コスト比)) のものは的中率に数えず、別に表示します。`);
  return out.join("\n");
}

/** 学習スナップショットの表示 (腕の成績・教訓・パラメータ調整・情報源信頼度・要因・仮想トレード・ニュース判定) */
export function renderLearning(
  s: Omit<LearningSnapshot, "shadow" | "news" | "forecast"> & Partial<Pick<LearningSnapshot, "shadow" | "news" | "forecast">>,
  opts: { arms?: number; lessons?: number; adjustments?: number } = {},
): string {
  const out: string[] = [];
  const arms = [...s.arms].sort((a, b) => b.n - a.n || (b.shadowN ?? 0) - (a.shadowN ?? 0)).slice(0, opts.arms ?? 15);
  out.push("■ 腕の成績 (戦略×レジーム×資産クラス。仮想 = 見送ったシグナルの仮想トレード、重み 0.25 で反映)");
  if (s.arms.some((a) => a.key.endsWith(SIMULATED_SHORT_ARM_SUFFIX))) {
    out.push(`  ※ 「${SIMULATED_SHORT_LABEL}」の腕 (内部キーの末尾 ${SIMULATED_SHORT_ARM_SUFFIX}) は買いの腕とは別に学習し、live では使いません`);
  }
  out.push(
    arms.length
      ? formatTable(
          ["腕", "件数", "仮想", "勝率", "期待R", "仮想平均R", "配分倍率", "状態"],
          arms.map((a) => [
            armLabel(a.key), a.n, a.shadowN ?? 0, fmtPct(a.winRate, 1), a.meanR.toFixed(3), (a.shadowN ?? 0) > 0 ? (a.shadowMeanR ?? 0).toFixed(3) : "-",
            a.weight.toFixed(2), a.disabled ? "停止" : "有効",
          ]),
        )
      : "  (まだありません)",
  );
  out.push("", "■ 有効な教訓");
  const lessons = s.lessons.slice(0, opts.lessons ?? 10);
  out.push(lessons.length ? lessons.map((l) => `  - [${l.scope}] ${l.text} (${l.origin === "llm" ? "AI" : "ルール"})`).join("\n") : "  (まだありません)");
  out.push("", "■ 最近のパラメータ調整");
  const adj = s.adjustments.slice(-(opts.adjustments ?? 10)).reverse();
  out.push(
    adj.length
      ? formatTable(
          ["日時", "戦略/資産", "パラメータ", "変更", "状態", "検証 (現行→候補)"],
          adj.map((a) => [
            fmtTime(a.createdAt), `${strategyLabel(a.strategyId)}/${a.assetClass}`, a.param, `${a.from} → ${a.to}`, ADJUSTMENT_STATUS_LABEL[a.status] ?? a.status,
            a.validation ? `${a.validation.baselineScore.toFixed(2)} → ${a.validation.candidateScore.toFixed(2)} (${a.validation.trades}件)` : "-",
          ]),
        )
      : "  (まだありません)",
  );
  out.push("", "■ 情報源の信頼度 (件数・的中はトレード由来、ニュース判定は値動きとの答え合わせ)");
  const src = Object.values(s.sources).sort((a, b) => b.n - a.n || (b.newsN ?? 0) - (a.newsN ?? 0));
  out.push(
    src.length
      ? formatTable(
          ["情報源", "件数", "的中", "ニュース判定", "ニュース的中", "スコア", "重み"],
          src.map((x) => [x.source, x.n, x.hits, x.newsN ?? 0, x.newsHits ?? 0, x.ewmaScore.toFixed(2), x.weight.toFixed(2)]),
        )
      : "  (まだありません)",
  );
  out.push(`  情報の効き具合: ${Object.entries(s.intelInfluence).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" / ")}`);
  out.push("", "■ 損益要因の集計");
  out.push(renderCauses(s.causes));
  out.push("", "■ 見送ったシグナルの答え合わせ (仮想トレード)");
  out.push(renderShadow(s.shadow));
  out.push("", "■ ニュースと値動きの答え合わせ");
  out.push(renderNewsCheck(s.news));
  out.push("", "■ 値動きの予想の答え合わせ");
  out.push(renderForecast(s.forecast));
  return out.join("\n");
}
