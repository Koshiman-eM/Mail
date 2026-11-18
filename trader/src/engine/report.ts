/** レポート (simulate / report コマンド・ダッシュボード) 用の集計と日本語の表整形 */
import type { CauseCode, EquityPoint, ExitReason, Store, TradeRecord } from "../core/types";
import { CAUSE_LABEL } from "../learning/attribution";
import type { CauseSummary, LearningSnapshot } from "../learning/service";
import { quoteCurrencyOfSymbol } from "./fx";

export const EXIT_REASON_LABEL: Record<ExitReason, string> = {
  stop: "損切り",
  take_profit: "利確",
  trailing: "トレーリング",
  signal: "シグナル",
  time: "時間切れ",
  kill_switch: "キルスイッチ",
  manual: "手動",
};

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
    rows.map((r) => [r.strategyId, r.trades, fmtPct(r.winRate, 1), fmtSigned(r.netPnl), fmtNum(r.fees, 0), r.avgR.toFixed(2)]),
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

/** 学習スナップショットの表示 (腕の成績・教訓・パラメータ調整・情報源信頼度・要因) */
export function renderLearning(s: LearningSnapshot, opts: { arms?: number; lessons?: number; adjustments?: number } = {}): string {
  const out: string[] = [];
  const arms = [...s.arms].sort((a, b) => b.n - a.n).slice(0, opts.arms ?? 15);
  out.push("■ 腕の成績 (戦略×レジーム×資産クラス)");
  out.push(
    arms.length
      ? formatTable(
          ["腕", "件数", "勝率", "期待R", "配分倍率", "状態"],
          arms.map((a) => [a.key, a.n, fmtPct(a.winRate, 1), a.meanR.toFixed(3), a.weight.toFixed(2), a.disabled ? "停止" : "有効"]),
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
            fmtTime(a.createdAt), `${a.strategyId}/${a.assetClass}`, a.param, `${a.from} → ${a.to}`, ADJUSTMENT_STATUS_LABEL[a.status] ?? a.status,
            a.validation ? `${a.validation.baselineScore.toFixed(2)} → ${a.validation.candidateScore.toFixed(2)} (${a.validation.trades}件)` : "-",
          ]),
        )
      : "  (まだありません)",
  );
  out.push("", "■ 情報源の信頼度");
  const src = Object.values(s.sources).sort((a, b) => b.n - a.n);
  out.push(
    src.length
      ? formatTable(["情報源", "件数", "的中", "スコア", "重み"], src.map((x) => [x.source, x.n, x.hits, x.ewmaScore.toFixed(2), x.weight.toFixed(2)]))
      : "  (まだありません)",
  );
  out.push(`  情報の効き具合: ${Object.entries(s.intelInfluence).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" / ")}`);
  out.push("", "■ 損益要因の集計");
  out.push(renderCauses(s.causes));
  return out.join("\n");
}
