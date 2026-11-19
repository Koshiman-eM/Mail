/** レポート (simulate / report コマンド・ダッシュボード) 用の集計と日本語の表整形 */
import type { CauseCode, EquityPoint, ExitReason, Store, TradeRecord } from "../core/types";
import { CAUSE_LABEL } from "../learning/attribution";
import { FORECAST_FEATURES, FORECAST_FEATURE_LABEL, type ForecastSummary } from "../learning/forecast";
import type { NewsCheckSummary } from "../learning/newsCheck";
import type { CauseSummary, LearningSnapshot } from "../learning/service";
import type { ShadowGroup, ShadowSummary } from "../learning/shadow";
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

const SHADOW_EXIT_LABEL: Record<string, string> = { stop: "損切り", take_profit: "利確", time: "時間切れ", unwatched: "監視終了" };

function shadowGroupTable(title: string, rows: ShadowGroup[], limit: number): string {
  return formatTable(
    [title, "件数", "勝率", "平均純R", "純R合計"],
    rows.slice(0, limit).map((g) => [g.key, g.n, fmtPct(g.winRate, 1), fmtR(g.avgNetR), fmtR(g.sumNetR, 2)]),
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
  out.push(shadowGroupTable("見送り理由", s.byReason, limit));
  out.push("", shadowGroupTable("戦略", s.byStrategy, limit));
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
  out.push(
    arms.length
      ? formatTable(
          ["腕", "件数", "仮想", "勝率", "期待R", "仮想平均R", "配分倍率", "状態"],
          arms.map((a) => [
            a.key, a.n, a.shadowN ?? 0, fmtPct(a.winRate, 1), a.meanR.toFixed(3), (a.shadowN ?? 0) > 0 ? (a.shadowMeanR ?? 0).toFixed(3) : "-",
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
            fmtTime(a.createdAt), `${a.strategyId}/${a.assetClass}`, a.param, `${a.from} → ${a.to}`, ADJUSTMENT_STATUS_LABEL[a.status] ?? a.status,
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
