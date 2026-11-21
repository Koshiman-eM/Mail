/**
 * 合成データ + 仮想時計による高速ペーパー運転 (ネット接続不要のデモ)。
 * 情報源は使わず (sources = [] のスタブ brief)、AI も使わない。学習ループは仮想時間 1 時間ごと。
 */
import { resolve } from "node:path";
import { loadConfig } from "../appConfig";
import type { Clock, ExitReason, Lesson, ParamAdjustment, Store } from "../core/types";
import type { ArmSnapshot } from "../learning/allocator";
import type { CauseSummary, LearningSnapshot } from "../learning/service";
import { mulberry32 } from "../market/feeds/synthetic";
import { createStore, MemoryStore } from "../storage";
import { configuredStrategies } from "../strategies/registry";
import { structureSettingsFromEnv } from "../structure/settings";
import { isStructureWrapped, withFilterCounter } from "../structure/wrap";
import { buildRuntime, syntheticDbPath, type Runtime } from "./setup";
import { readLimitStats, type LimitStats } from "./orders";
import { effectiveLimitTakeProfit } from "./limitOrders";
import {
  equityStats, EXIT_REASON_LABEL, exitFxRates, exitReasonCounts, fmtNum, fmtPct, fmtSigned, fmtTime, renderLearning, renderLimitStats, renderOrderTypeTable,
  renderReversalTable, renderSideTable, renderStrategyTable, renderTempoTable, renderThesisTable, summarizeByOrderType, summarizeBySide, summarizeByStrategy,
  summarizeByTempo, summarizeReversal, summarizeThesis, type OrderTypeSummary, type ReversalSummary, type SideSummary, type StrategySummary, type TempoSummary,
  type ThesisSummary,
} from "./report";
import { formatTempoLine, type TempoStatusView } from "./tempo";
import { formatThesisSettings, thesisSettingsFromEnv, type ThesisSettings } from "./thesis";
import { formatReversalSettings, reversalSettingsFromEnv, type ReversalSettings } from "./reversalExit";

const HOUR = 3_600_000;
/** 既定の開始時刻 (再現性のため固定。月曜 00:00 UTC) */
export const DEFAULT_SIM_START = Date.UTC(2026, 0, 5);

export interface SimulationOptions {
  /** 期間 (日)。hours と併用時は合算 */
  days?: number;
  hours?: number;
  seed?: number;
  /** "memory" または DB ファイルのパス */
  db?: string;
  /** 仮想時間の刻み (既定 15 秒) */
  stepMs?: number;
  start?: number;
  /** 設定の元 (既定 process.env)。モード・取引先は常に paper / synthetic に固定する */
  env?: Record<string, string | undefined>;
  /** 合成フィードの履歴 */
  historyMs?: number;
  /** 進捗の通知 (仮想時間で progressEveryMs ごと) */
  onProgress?: (p: SimulationProgress) => void;
  progressEveryMs?: number;
  /** テスト用: 外から渡す store (渡した場合は閉じない) */
  store?: Store;
}

export interface SimulationProgress {
  now: number;
  start: number;
  end: number;
  equity: number;
  trades: number;
  openPositions: number;
}

export interface SimulationReport {
  seed: number;
  start: number;
  end: number;
  stepMs: number;
  ticks: number;
  elapsedMs: number;
  baseCurrency: string;
  symbols: string[];
  initialEquity: number;
  finalEquity: number;
  netPnl: number;
  returnPct: number;
  maxDrawdown: number;
  trades: number;
  winRate: number;
  byStrategy: StrategySummary[];
  /** 方向別 (買い / 売り / 空売り (paper 再現)) */
  bySide: SideSummary[];
  /** 注文の種類別 (成行 / 指値) と手数料の maker / taker の内訳 */
  byOrderType: OrderTypeSummary[];
  /** 指値の利用: 設定と約定率の集計 */
  limitOrders: { limitEntry: boolean; limitTakeProfit: boolean; stats: LimitStats };
  /** エントリー頻度 (テンポ) と最大保有 (TARGET_ENTRIES_PER_HOUR / MAX_HOLD_MINUTES ほか。無効でも件数は出す) */
  tempo?: {
    /** 期間中のエントリー数 (決済済み + 保有中のうち期間内にエントリーしたもの) と 1 時間あたり */
    entries: number;
    entriesPerHour: number;
    /** 平均保有時間 (分。決済済みの取引) */
    avgHoldMinutes: number;
    /** 期間の終わりのテンポの状態 */
    status: TempoStatusView;
    maxHoldMinutes: number;
    exploreSize: number;
    /** テンポの上限 (tempo_cap)・最大保有の対象外 (hold_limit) で見送った回数 (見送り理由の集計) */
    capSkips: number;
    holdLimitSkips: number;
    /** 探索 / 通常の成績 */
    byTempo: TempoSummary[];
  };
  /** 読みの管理 (THESIS_*): 設定と読みの答え合わせ */
  thesis?: { settings: ThesisSettings; summary: ThesisSummary };
  /** 転換で決済 (REVERSAL_*): 設定と成績 */
  reversal?: { settings: ReversalSettings; summary: ReversalSummary };
  exitReasons: Partial<Record<ExitReason, number>>;
  causes: CauseSummary;
  attributedTrades: number;
  openPositions: number;
  killSwitch?: { at: number; reason: string };
  learning: {
    arms: ArmSnapshot[];
    adjustments: ParamAdjustment[];
    lessons: Lesson[];
    intelInfluence: LearningSnapshot["intelInfluence"];
    learningRuns: number;
    sources: LearningSnapshot["sources"];
    /** 見送ったシグナルの答え合わせ (仮想トレード) */
    shadow: LearningSnapshot["shadow"];
    /** ニュースと値動きの答え合わせ (合成データには情報が無いので通常 0 件) */
    news: LearningSnapshot["news"];
    /** 値動きの予想の答え合わせ */
    forecast: LearningSnapshot["forecast"];
  };
  plans: number;
  /** 相場構造のフィルター (STRUCTURE_MODE) */
  structure?: {
    mode: "off" | "filter";
    /** ラップした戦略 */
    strategies: string[];
    /** フィルターで通さなかったシグナルの件数 (理由別。仮想トレードの重複の除外前) */
    filtered: Record<string, number>;
  };
}

/** シミュレーション用の設定 (paper・synthetic・AI なしに固定) */
export function simulationConfig(env: Record<string, string | undefined>, db: string) {
  return loadConfig({
    ...env,
    TRADING_MODE: "paper",
    LIVE_TRADING_CONFIRM: "",
    VENUES: "synthetic",
    WATCHLIST: "",
    ANTHROPIC_API_KEY: "",
    DB_PATH: db,
  });
}

/**
 * simulate が使えない DB か。DB_PATH (実運転用) とその合成データ用 (<ベース名>-synthetic.db) は拒否する
 * (仮想時間の取引・追跡ポジション・リスク状態を運転中の DB に混ぜない)。memory / :memory: は可。
 */
export function assertSimulationDb(db: string, env: Record<string, string | undefined>): void {
  if (db === "memory" || db === ":memory:") return;
  const dbPath = loadConfig(env).env.DB_PATH;
  const guarded = [dbPath, syntheticDbPath(dbPath)].filter((p) => p !== "" && p !== "memory" && p !== ":memory:").map((p) => resolve(p));
  if (guarded.includes(resolve(db))) {
    throw new Error(`simulate は DB_PATH (${dbPath}) と同じファイル (合成データ用を含む) を使えません。--db に別のファイルを指定してください`);
  }
}

export async function runSimulation(o: SimulationOptions = {}): Promise<{ report: SimulationReport; runtime: Runtime }> {
  const seed = o.seed ?? 1;
  const durationMs = Math.round(((o.days ?? (o.hours === undefined ? 3 : 0)) * 24 + (o.hours ?? 0)) * HOUR);
  if (!(durationMs > 0)) throw new Error("期間が 0 です (--days / --hours を確認してください)");
  const stepMs = Math.max(1_000, Math.round(o.stepMs ?? 15_000));
  const db = o.db ?? "memory";
  if (!o.store) assertSimulationDb(db, o.env ?? process.env);
  const config = simulationConfig(o.env ?? process.env, db);
  const store = o.store ?? (db === "memory" ? new MemoryStore() : createStore(db));

  // 既存の DB に追記する場合は時刻が逆行しないよう続きから始める
  const lastEq = store.listEquity({ mode: "paper" }).at(-1);
  const start = Math.max(o.start ?? DEFAULT_SIM_START, lastEq ? lastEq.ts + stepMs : 0);
  const end = start + durationMs;
  const clock: Clock & { t: number } = { t: start, now() { return this.t; } };
  // 相場構造のフィルター: 運用と同じ一覧 (configuredStrategies) を使い、通さなかった件数だけ数える (判定は変えない)
  const structure = structureSettingsFromEnv(config.env);
  const structureFiltered: Record<string, number> = {};
  const strategies = configuredStrategies(structure).map((s) => (isStructureWrapped(s) ? withFilterCounter(s, structureFiltered) : s));

  const runtime = await buildRuntime(config, {
    strategies,
    clock,
    store,
    intelSources: [],
    seed,
    ai: null,
    rng: mulberry32(seed ^ 0x5eed),
    ...(o.historyMs !== undefined ? { syntheticHistoryMs: o.historyMs } : {}),
    // デモで学習の動きが見えるよう振り返りは 6 時間ごと
    learning: { tuneEveryMs: HOUR, reflectEveryMs: 6 * HOUR, reflectWindowMs: 7 * 86_400_000 },
    engine: { learnEveryMs: HOUR, intelEveryMs: config.env.INTEL_LOOP_MS },
  });
  const { engine } = runtime;

  const t0 = Date.now();
  let ticks = 0;
  let learningRuns = 0;
  let plans = 0;
  let lastLearn = start;
  let lastIntel: number | undefined;
  let lastProgress = start;
  const progressEvery = o.progressEveryMs ?? 6 * HOUR;
  let equity = config.env.PAPER_INITIAL_EQUITY;

  for (let now = start; now <= end; now += stepMs) {
    clock.t = now;
    const r = await engine.tick(now);
    equity = r.equity;
    ticks++;
    if (lastIntel === undefined || now - lastIntel >= config.env.INTEL_LOOP_MS) {
      lastIntel = now;
      if (await engine.runIntel(now)) plans++;
    }
    if (now - lastLearn >= HOUR) {
      lastLearn = now;
      if (await engine.runLearning(now)) learningRuns++;
    }
    if (o.onProgress && now - lastProgress >= progressEvery) {
      lastProgress = now;
      o.onProgress({ now, start, end, equity, trades: store.listTrades({ since: start }).length, openPositions: engine.positions.list().length });
    }
  }
  clock.t = end;
  await engine.stop();

  const trades = store.listTrades({ since: start });
  // エントリー頻度: 期間内にエントリーした取引 (決済済み + 保有中)。見送り理由の集計からテンポの上限・最大保有の件数を数える
  const openEntries = engine.positions.list().filter((p) => p.entryTs >= start).length;
  const entries = trades.filter((t) => t.entryTs >= start).length + openEntries;
  const skipCount = (key: string) =>
    store.listAudit({ type: "engine.skip_summary", since: start }).reduce((a, e) => {
      const r = (e.data.reasons as Record<string, { count?: number }> | undefined)?.[key];
      return a + (typeof r?.count === "number" ? r.count : 0);
    }, 0);
  const holdSum = trades.reduce((a, t) => a + Math.max(0, t.exitTs - t.entryTs), 0);
  const eqStats = equityStats(store.listEquity({ since: start, mode: "paper" }));
  const finalAcct = await engine.account(end, true);
  // 新しい DB なら初期資金、既存の DB に追記した場合は開始前の最後の評価額
  const initialEquity = lastEq ? lastEq.equity : config.env.PAPER_INITIAL_EQUITY;
  const finalEquity = finalAcct.equity;
  const quoteOf = (t: { symbol: string }) => runtime.hub.instrument(t.symbol)?.quoteCurrency;
  const snapshot = runtime.learning.snapshot({ now: end, causeWindowMs: end - start + HOUR, adjustmentLimit: 50, lessonLimit: 20 });
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const report: SimulationReport = {
    seed,
    start,
    end,
    stepMs,
    ticks,
    elapsedMs: Date.now() - t0,
    baseCurrency: config.env.BASE_CURRENCY,
    symbols: runtime.instruments.map((i) => i.symbol),
    initialEquity,
    finalEquity,
    netPnl: finalEquity - initialEquity,
    returnPct: initialEquity > 0 ? finalEquity / initialEquity - 1 : 0,
    maxDrawdown: eqStats?.maxDrawdown ?? 0,
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    byStrategy: summarizeByStrategy(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    bySide: summarizeBySide(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    byOrderType: summarizeByOrderType(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    limitOrders: { limitEntry: config.env.LIMIT_ENTRY, limitTakeProfit: effectiveLimitTakeProfit(config.env, "paper"), stats: readLimitStats(store, "paper") },
    tempo: {
      entries,
      entriesPerHour: entries / ((end - start) / HOUR),
      avgHoldMinutes: trades.length ? holdSum / trades.length / 60_000 : 0,
      status: engine.tempoStatus(end),
      maxHoldMinutes: config.env.MAX_HOLD_MINUTES,
      exploreSize: config.env.TEMPO_EXPLORE_SIZE,
      capSkips: skipCount("tempo_cap"),
      holdLimitSkips: skipCount("hold_limit"),
      byTempo: summarizeByTempo(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    },
    thesis: {
      settings: thesisSettingsFromEnv(config.env),
      summary: summarizeThesis(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    },
    reversal: {
      settings: reversalSettingsFromEnv(config.env),
      summary: summarizeReversal(trades, (c) => runtime.fx.toAccount(c), quoteOf, exitFxRates(store, start)),
    },
    exitReasons: exitReasonCounts(trades),
    causes: snapshot.causes,
    attributedTrades: trades.filter((t) => store.getAttribution(t.id) !== undefined).length,
    openPositions: engine.positions.list().length,
    ...(runtime.risk.state().killSwitch ? { killSwitch: runtime.risk.state().killSwitch } : {}),
    learning: {
      arms: snapshot.arms,
      adjustments: snapshot.adjustments,
      lessons: snapshot.lessons,
      intelInfluence: snapshot.intelInfluence,
      learningRuns,
      sources: snapshot.sources,
      shadow: runtime.learning.shadowSummary({ now: end, windowMs: end - start + HOUR }),
      news: snapshot.news,
      forecast: snapshot.forecast,
    },
    plans,
    structure: {
      mode: structure.mode,
      strategies: strategies.filter(isStructureWrapped).map((s) => s.id),
      filtered: { ...structureFiltered },
    },
  };
  if (!o.store) runtime.close();
  return { report, runtime };
}

/** シミュレーション結果の日本語表示 */
export function formatSimulationReport(r: SimulationReport): string {
  const ccy = r.baseCurrency;
  const days = (r.end - r.start) / 86_400_000;
  const lines: string[] = [];
  lines.push("=== シミュレーション結果 (ペーパー・合成データ) ===");
  lines.push(
    `期間: ${fmtTime(r.start)} 〜 ${fmtTime(r.end)} (${days >= 1 ? `${+days.toFixed(2)} 日` : `${+(days * 24).toFixed(1)} 時間`}, ` +
      `刻み ${r.stepMs / 1000} 秒, ${r.ticks} ティック, 実時間 ${(r.elapsedMs / 1000).toFixed(1)} 秒, シード ${r.seed})`,
  );
  lines.push(`銘柄: ${r.symbols.join(", ")}`);
  lines.push(
    `評価額: ${fmtNum(r.initialEquity, 0)} → ${fmtNum(r.finalEquity, 0)} ${ccy} (${fmtSigned(r.netPnl)} / ${fmtSigned(r.returnPct * 100, 2)}%)  最大ドローダウン ${fmtPct(r.maxDrawdown)}`,
  );
  lines.push(`取引数: ${r.trades} (勝率 ${fmtPct(r.winRate, 1)})  要因分析済み ${r.attributedTrades} 件  保有中 ${r.openPositions} 件`);
  const reasons = Object.entries(r.exitReasons).map(([k, v]) => `${EXIT_REASON_LABEL[k as ExitReason] ?? k} ${v}`);
  if (reasons.length) lines.push(`決済理由: ${reasons.join(" / ")}`);
  if (r.killSwitch) lines.push(`キルスイッチ: ${r.killSwitch.reason} (${fmtTime(r.killSwitch.at)})`);
  if (r.structure) {
    const st = r.structure;
    const total = Object.values(st.filtered).reduce((a, b) => a + b, 0);
    lines.push(
      st.mode === "filter"
        ? `相場構造のフィルター: ${st.strategies.length} 戦略 / 通さなかったシグナル ${total} 件` +
            (total ? ` (${Object.entries(st.filtered).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" / ")})` : "")
        : "相場構造のフィルター: off",
    );
  }
  if (r.tempo) {
    const tp = r.tempo;
    lines.push(
      `エントリー頻度: ${tp.entries} 回 (平均 ${tp.entriesPerHour.toFixed(2)} 回/時${tp.status.enabled ? ` / 目標 ${+tp.status.target.toFixed(2)} 回/時` : ""})` +
        `  平均保有 ${tp.avgHoldMinutes.toFixed(1)} 分`,
      `${formatTempoLine(tp.status, tp.maxHoldMinutes)} (期間の終わり)`,
      `  見送り: テンポの上限 ${tp.capSkips} 件 / 最大保有の対象外 (中期・長期) ${tp.holdLimitSkips} 件` +
        (tp.status.enabled ? ` / 探索のサイズ ${tp.exploreSize} 倍` : ""),
    );
  }
  lines.push("", "■ 方向別の成績", renderSideTable(r.bySide ?? [], ccy));
  if (r.limitOrders) {
    lines.push(
      "",
      `■ 注文の種類と手数料 (指値のエントリー ${r.limitOrders.limitEntry ? "有効" : "無効"} / 利確の指値 ${r.limitOrders.limitTakeProfit ? "有効" : "無効"})`,
      renderOrderTypeTable(r.byOrderType ?? [], ccy),
      "  指値の約定率:",
      renderLimitStats(r.limitOrders.stats),
    );
  }
  if (r.tempo) lines.push("", "■ テンポの探索と通常のエントリー", renderTempoTable(r.tempo.byTempo, ccy));
  if (r.thesis) lines.push("", `■ 読みの答え合わせ (読みの管理 ${formatThesisSettings(r.thesis.settings)})`, renderThesisTable(r.thesis.summary, ccy));
  if (r.reversal) lines.push("", `■ 転換で決済 (${formatReversalSettings(r.reversal.settings)})`, renderReversalTable(r.reversal.summary, ccy));
  lines.push("", "■ 戦略別の成績 (全方向)", renderStrategyTable(r.byStrategy, ccy));
  lines.push("", `■ 学習の動き (学習ループ ${r.learning.learningRuns} 回 / 計画の更新 ${r.plans} 回)`);
  const applied = r.learning.adjustments.filter((a) => a.status === "applied").length;
  lines.push(`  腕 ${r.learning.arms.length} 本を更新 / パラメータ調整 ${r.learning.adjustments.length} 件 (適用 ${applied}) / 有効な教訓 ${r.learning.lessons.length} 件`);
  const sh = r.learning.shadow;
  lines.push(
    `  仮想トレード (見送ったシグナル): 決済 ${sh.closed} 件 / 未決済 ${sh.open} 件 / 平均純R ${sh.avgNetR.toFixed(3)}` +
      `  ニュース判定: ${r.learning.news.sources.reduce((a, x) => a + x.n, 0)} 件`,
  );
  const fh = r.learning.forecast.byHorizon;
  const fn = fh.reduce((a, g) => a + g.n, 0);
  const fhits = fh.reduce((a, g) => a + g.hits, 0);
  lines.push(
    `  値動きの予想: ${r.learning.forecast.recorded} 件 / 判定 ${fn} 件 (的中率 ${fn ? fmtPct(fhits / fn, 1) : "-"}) / ` +
      fh.map((g) => `${g.horizon} ${g.n ? fmtPct(g.hitRate, 1) : "-"} (n=${g.n}, Brier ${g.brierN ? g.brier.toFixed(3) : "-"})`).join(" / ") +
      ` / 取引に反映中 ${r.learning.forecast.byClass.filter((g) => g.live).length} 件`,
  );
  lines.push("");
  lines.push(
    renderLearning(
      {
        generatedAt: r.end,
        arms: r.learning.arms,
        lessons: r.learning.lessons,
        adjustments: r.learning.adjustments,
        sources: r.learning.sources,
        intelInfluence: r.learning.intelInfluence,
        causes: r.causes,
        shadow: r.learning.shadow,
        news: r.learning.news,
        forecast: r.learning.forecast,
      },
      { arms: 12, lessons: 8, adjustments: 10 },
    ),
  );
  lines.push("", "※ 情報源は使っていません (スタブのブリーフ)。戦略別の損益は決済時点の為替 (概算表の 1 USD = 150 JPY) で口座通貨へ換算。");
  return lines.join("\n");
}
