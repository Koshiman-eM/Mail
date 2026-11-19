/**
 * 合成データ + 仮想時計による高速ペーパー運転 (ネット接続不要のデモ)。
 * 情報源は使わず (sources = [] のスタブ brief)、AI も使わない。学習ループは仮想時間 1 時間ごと。
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config";
import type { Clock, ExitReason, Lesson, ParamAdjustment, Store } from "../core/types";
import type { ArmSnapshot } from "../learning/allocator";
import type { CauseSummary, LearningSnapshot } from "../learning/service";
import { mulberry32 } from "../market/feeds/synthetic";
import { createStore, MemoryStore } from "../storage";
import { buildRuntime, syntheticDbPath, type Runtime } from "./setup";
import {
  equityStats, EXIT_REASON_LABEL, exitFxRates, exitReasonCounts, fmtNum, fmtPct, fmtSigned, fmtTime, renderLearning, renderSideTable, renderStrategyTable,
  summarizeBySide, summarizeByStrategy, type SideSummary, type StrategySummary,
} from "./report";

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
    AUTO_MEME_WATCH: "false",
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

  const runtime = await buildRuntime(config, {
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
  lines.push("", "■ 方向別の成績", renderSideTable(r.bySide ?? [], ccy));
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
  lines.push("", "※ 情報源は使っていません (スタブのブリーフ)。戦略別の損益は決済時点の為替 (合成の USD/JPY) で口座通貨へ換算。");
  return lines.join("\n");
}
