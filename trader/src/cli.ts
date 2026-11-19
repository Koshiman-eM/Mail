/**
 * CLI: run / simulate / backtest / intel / report / resume / status
 * 依存なしの簡易引数解析。表示はすべて日本語。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./core/config";
import type { Store } from "./core/types";
import { isLoopbackHost, startDashboard, type DashboardServer } from "./dashboard/server";
import { formatBacktestRows, runBacktestCommand } from "./engine/backtestCommand";
import { createFxConverter, quoteCurrencyOfSymbol } from "./engine/fx";
import {
  equityStats, EXIT_REASON_LABEL, exitFxRates, exitReasonCounts, fmtNum, fmtPct, fmtSigned, fmtTime, renderLearning, renderStrategyTable, summarizeByStrategy,
} from "./engine/report";
import { PendingOrders } from "./engine/orders";
import { buildRuntime, resolveDbPath } from "./engine/setup";
import { formatSimulationReport, runSimulation } from "./engine/simulate";
import { createDefaultSources, IntelService } from "./intel/service";
import { TradeJournal } from "./learning/journal";
import { LearningService } from "./learning/service";
import { CcxtFeed } from "./market/feeds/ccxt";
import { RiskManager } from "./risk/manager";
import { requestResume } from "./risk/resumeRequest";
import { createStore } from "./storage";
import { getStrategy } from "./strategies/registry";
import type { ExitReason } from "./core/types";

// ───────── 引数解析 ─────────

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** `cmd --key value --key=value --flag pos` を解析する。値が "--" で始まる場合はフラグ扱い */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
      continue;
    }
    positionals.push(a);
  }
  const command = positionals.shift() ?? (flags.help ? "help" : "help");
  return { command, flags, positionals };
}

export class CliError extends Error {}

export function numberFlag(
  flags: ParsedArgs["flags"],
  name: string,
  def: number,
  o: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const v = flags[name];
  if (v === undefined) return def;
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new CliError(`--${name} には数値を指定してください (指定値: ${String(v)})`);
  if (o.integer && !Number.isInteger(n)) throw new CliError(`--${name} には整数を指定してください`);
  if (o.min !== undefined && n < o.min) throw new CliError(`--${name} は ${o.min} 以上にしてください`);
  if (o.max !== undefined && n > o.max) throw new CliError(`--${name} は ${o.max} 以下にしてください`);
  return n;
}

export function stringFlag(flags: ParsedArgs["flags"], name: string, def: string): string {
  const v = flags[name];
  if (v === undefined) return def;
  if (typeof v !== "string" || v === "") throw new CliError(`--${name} に値を指定してください`);
  return v;
}

export interface SimulateArgs {
  days: number;
  hours: number;
  seed: number;
  db: string;
  stepMs: number;
}

export function parseSimulateArgs(flags: ParsedArgs["flags"]): SimulateArgs {
  const hours = numberFlag(flags, "hours", 0, { min: 0, max: 24 * 365 });
  const days = numberFlag(flags, "days", hours > 0 ? 0 : 3, { min: 0, max: 365 });
  if (days <= 0 && hours <= 0) throw new CliError("--days または --hours に正の値を指定してください");
  return {
    days,
    hours,
    seed: numberFlag(flags, "seed", 1, { integer: true }),
    db: stringFlag(flags, "db", "memory"),
    stepMs: numberFlag(flags, "step", 15, { min: 1, max: 3600 }) * 1000,
  };
}

export interface BacktestArgs {
  strategy: string;
  symbol?: string;
  days: number;
  source: "synthetic" | "ccxt";
  seed: number;
}

export function parseBacktestArgs(flags: ParsedArgs["flags"]): BacktestArgs {
  const strategy = stringFlag(flags, "strategy", "");
  if (!strategy) throw new CliError("--strategy <戦略ID|all> を指定してください");
  if (strategy !== "all" && !getStrategy(strategy)) throw new CliError(`未知の戦略: ${strategy}`);
  const source = stringFlag(flags, "source", "synthetic");
  if (source !== "synthetic" && source !== "ccxt") throw new CliError("--source は synthetic または ccxt です");
  const symbol = flags.symbol === undefined ? undefined : stringFlag(flags, "symbol", "");
  return {
    strategy,
    ...(symbol ? { symbol } : {}),
    days: numberFlag(flags, "days", 30, { min: 0.01, max: 3650 }),
    source,
    seed: numberFlag(flags, "seed", 1, { integer: true }),
  };
}

// ───────── 出力 ─────────

export interface Io {
  out(s: string): void;
  err(s: string): void;
}
const consoleIo: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export const HELP = `自己学習型マルチアセット自動売買ツール

使い方: npm run trader -- <コマンド> [オプション]

  run                         実時間で起動 (既定は paper)。ダッシュボードも起動します
  simulate [--days 3] [--hours N] [--seed 1] [--db memory] [--step 15]
                              合成データ + 仮想時計で高速にペーパー運転 (ネット不要)
  backtest --strategy <ID|all> [--symbol SYM] [--days 30] [--source synthetic|ccxt] [--seed 1]
                              バックテスト (ccxt は CCXT_EXCHANGE の履歴を取得)
  intel                       情報収集を 1 回実行してブリーフを表示
  report                      評価額・戦略別成績・学習の状態を表示 (DB_PATH)
  resume                      キルスイッチ・日次停止を解除 (監査ログに記録)
  status                      設定と現在の状態を表示

実弾 (live) は TRADING_MODE=live と LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK の両方が必要です。`;

const venuesLine = (c: AppConfig) => `取引先: ${c.env.VENUES}${c.env.VENUES.split(",").some((v) => v.trim().startsWith("ccxt")) ? ` (ccxt: ${c.env.CCXT_EXCHANGE})` : ""}`;

function modeLines(c: AppConfig): { out: string[]; warn: string[] } {
  const out = [`モード: ${c.mode === "live" ? "実弾 (live)" : "ペーパー (paper)"}`];
  const warn: string[] = [];
  if (c.liveBlockedReason) warn.push(`警告: ${c.liveBlockedReason}`);
  if (c.mode === "live") warn.push("警告: 実弾モードです。実際の資金で発注します。");
  return { out, warn };
}

function riskLines(c: AppConfig): string[] {
  const r = c.risk;
  return [
    "リスク上限:",
    `  1 トレードのリスク ${fmtPct(r.riskPerTrade)} / 日次損失 ${fmtPct(r.maxDailyLoss)} / 最大ドローダウン ${fmtPct(r.maxDrawdown)}`,
    `  最大保有数 ${r.maxOpenPositions} / 1 銘柄 ${fmtPct(r.maxPositionPct, 0)} / 発注 ${r.maxOrdersPerMinute} 回/分 / 期待値幅 ≥ コスト × ${r.minEdgeToCostRatio}`,
    `  資産クラス上限: ${Object.entries(r.maxExposureByClass).map(([k, v]) => `${k} ${fmtPct(v, 0)}`).join(" / ")} / ミーム最低流動性 $${fmtNum(r.memeMinLiquidityUsd, 0)}`,
  ];
}

// ───────── コマンド ─────────

async function cmdRun(io: Io): Promise<number> {
  const config = loadConfig();
  const m = modeLines(config);
  m.out.forEach((l) => io.out(l));
  m.warn.forEach((l) => io.err(l));
  io.out(venuesLine(config));
  const rt = await buildRuntime(config);
  io.out(`銘柄: ${rt.instruments.map((i) => `${i.symbol} (${i.assetClass}, ${i.venue})`).join(", ")}`);
  io.out(`時間足: ${rt.timeframes.join(", ")} / 口座通貨: ${config.env.BASE_CURRENCY} / DB: ${resolveDbPath(config)}`);
  riskLines(config).forEach((l) => io.out(l));
  io.out(`AI: ${rt.ai ? `有効 (${rt.ai.model})` : "無効 (ルールベース)"}`);

  let dash: DashboardServer | undefined;
  try {
    dash = await startDashboard(
      {
        status: () => rt.engine.status(),
        store: rt.store,
        learning: rt.learning,
        clock: rt.clock,
        baseCurrency: config.env.BASE_CURRENCY,
        toAccount: (c) => rt.fx.toAccount(c),
        quoteCurrencyOf: (s) => rt.hub.instrument(s)?.quoteCurrency,
      },
      { host: config.env.DASHBOARD_HOST, port: config.env.DASHBOARD_PORT },
    );
    io.out(`ダッシュボード: ${dash.url} (閲覧専用)`);
    if (!isLoopbackHost(config.env.DASHBOARD_HOST)) io.err("警告: ダッシュボードがループバック以外で待ち受けています。認証が無いため外部公開は避けてください。");
  } catch (e) {
    io.err(`警告: ダッシュボードを起動できませんでした (${e instanceof Error ? e.message : String(e)})。取引は続行します`);
  }

  await rt.engine.start();
  io.out("起動しました。Ctrl+C で停止します (保有ポジションは自動決済しません)。");
  await new Promise<void>((done) => {
    let stopping = false;
    const onSignal = async (sig: string) => {
      if (stopping) return;
      stopping = true;
      io.out(`${sig} を受信: 停止します...`);
      try {
        await rt.engine.stop();
        await dash?.close();
      } finally {
        rt.close();
        io.out(`停止しました。保有ポジション ${rt.engine.journal.list().length} 件はそのままです。`);
        done();
      }
    };
    process.once("SIGINT", () => void onSignal("SIGINT"));
    process.once("SIGTERM", () => void onSignal("SIGTERM"));
  });
  return 0;
}

async function cmdSimulate(flags: ParsedArgs["flags"], io: Io): Promise<number> {
  const a = parseSimulateArgs(flags);
  const label = a.days > 0 ? `${a.days} 日${a.hours ? ` + ${a.hours} 時間` : ""}` : `${a.hours} 時間`;
  io.out(`シミュレーション開始: ${label} / 刻み ${a.stepMs / 1000} 秒 / シード ${a.seed} / DB ${a.db}`);
  const { report } = await runSimulation({
    days: a.days,
    hours: a.hours,
    seed: a.seed,
    db: a.db,
    stepMs: a.stepMs,
    onProgress: (p) =>
      io.err(`  ${fmtTime(p.now)} 評価額 ${fmtNum(p.equity, 0)} / 決済 ${p.trades} 件 / 保有 ${p.openPositions} 件 (${(((p.now - p.start) / (p.end - p.start)) * 100).toFixed(0)}%)`),
  });
  io.out(formatSimulationReport(report));
  return 0;
}

async function cmdBacktest(flags: ParsedArgs["flags"], io: Io): Promise<number> {
  const a = parseBacktestArgs(flags);
  const config = loadConfig();
  let feed;
  if (a.source === "ccxt") {
    io.out(`ccxt (${config.env.CCXT_EXCHANGE}) から履歴を取得します...`);
    feed = CcxtFeed.create(config.env.CCXT_EXCHANGE);
  }
  const symbol = a.symbol ?? (a.source === "ccxt" ? (config.env.CCXT_EXCHANGE === "bitflyer" ? "BTC/JPY" : "BTC/USDT") : "SYN/USDT");
  const rows = await runBacktestCommand({
    ...a,
    symbol,
    ...(feed ? { feed } : {}),
    minEdgeToCostRatio: config.risk.minEdgeToCostRatio,
    riskPerTrade: config.risk.riskPerTrade,
    maxPositionPct: config.risk.maxPositionPct,
  });
  io.out(`バックテスト: ${symbol} / ${a.days} 日 / ${a.source === "synthetic" ? `合成データ (シード ${a.seed})` : `ccxt ${config.env.CCXT_EXCHANGE}`}`);
  io.out(formatBacktestRows(rows));
  io.out("※ 損益はクオート通貨建て (初期評価額 1,000,000)。期間の前にウォームアップ用の足を付けています。");
  return 0;
}

/** 外部から集めた文字列を端末に出す前に、制御文字と双方向制御文字を取り除く (表示の乗っ取り防止) */
const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, "");

async function cmdIntel(io: Io): Promise<number> {
  const config = loadConfig();
  const store = createStore(resolveDbPath(config));
  try {
    const ai = config.ai.enabled ? { apiKey: config.ai.apiKey, model: config.ai.model } : undefined;
    const svc = new IntelService({
      store,
      sources: createDefaultSources({ env: { NEWS_RSS_FEEDS: config.env.NEWS_RSS_FEEDS, CRYPTOPANIC_TOKEN: config.env.CRYPTOPANIC_TOKEN } }),
      ...(ai ? { ai } : {}),
    });
    io.out("情報収集を実行しています...");
    const now = Date.now();
    const b = await svc.refresh(now);
    io.out(`=== マーケットブリーフ (${fmtTime(b.generatedAt)}, ${b.stub ? "ルールベース" : "AI 分析"}) ===`);
    io.out(`リスクオン指数: ${b.riskOn.toFixed(2)} (-1 リスクオフ 〜 1 リスクオン)`);
    io.out(`要約: ${cleanText(b.summary)}`);
    const biases = Object.values(b.biases).sort((x, y) => y.confidence - x.confidence).slice(0, 15);
    io.out("");
    io.out("■ 資産別のバイアス (信頼度の高い順)");
    for (const x of biases) {
      io.out(`  ${cleanText(x.asset).padEnd(8)} センチメント ${fmtSigned(x.sentiment, 2).padStart(6)} / 信頼度 ${x.confidence.toFixed(2)} / イベント ${x.eventRisk.toFixed(2)}${x.blackoutUntil && x.blackoutUntil > now ? ` / ${fmtTime(x.blackoutUntil)} まで停止` : ""}`);
    }
    if (biases.length === 0) io.out("  (なし)");
    io.out(`監視候補: ${b.watchlist.length ? b.watchlist.map(cleanText).join(", ") : "(なし)"}`);
    const ev = b.events.filter((e) => e.ts >= now - 3_600_000 && e.impact === "high").sort((x, y) => x.ts - y.ts).slice(0, 10);
    io.out("■ 重要イベント");
    for (const e of ev) io.out(`  ${fmtTime(e.ts)} ${cleanText(e.currency ?? "")} ${cleanText(e.title)}`);
    if (ev.length === 0) io.out("  (なし)");
    return 0;
  } finally {
    store.close();
  }
}

/** DB からの成績・学習レポート */
export function buildReportText(config: AppConfig, store: Store, now: number = Date.now()): string {
  const ccy = config.env.BASE_CURRENCY;
  const lines: string[] = [];
  lines.push(`=== レポート (${fmtTime(now)}, DB: ${resolveDbPath(config)}) ===`);
  for (const mode of ["paper", "live"] as const) {
    const st = equityStats(store.listEquity({ mode }));
    if (!st) continue;
    lines.push(
      `評価額 (${mode}): ${fmtNum(st.first, 0)} → ${fmtNum(st.last, 0)} ${ccy} (${fmtSigned(st.last - st.first)} / ${fmtPct(st.first ? st.last / st.first - 1 : 0)})` +
        `  最高 ${fmtNum(st.max, 0)} / 最低 ${fmtNum(st.min, 0)} / 最大DD ${fmtPct(st.maxDrawdown)}  期間 ${fmtTime(st.from)} 〜 ${fmtTime(st.to)}`,
    );
  }
  const trades = store.listTrades();
  // 保存済みの気配が無いので為替は概算表で換算する
  const fx = createFxConverter({ baseCurrency: ccy, getQuote: () => undefined });
  const wins = trades.filter((t) => t.netPnl > 0).length;
  lines.push(`取引数: ${trades.length} (勝率 ${fmtPct(trades.length ? wins / trades.length : 0, 1)})`);
  const reasons = Object.entries(exitReasonCounts(trades)).map(([k, v]) => `${EXIT_REASON_LABEL[k as ExitReason] ?? k} ${v}`);
  if (reasons.length) lines.push(`決済理由: ${reasons.join(" / ")}`);
  lines.push("", "■ 戦略別の成績 (口座通貨換算は決済時点のレート。記録が無いものは概算レート)");
  lines.push(renderStrategyTable(summarizeByStrategy(trades, (c) => fx.toAccount(c), (t) => quoteCurrencyOfSymbol(t.symbol), exitFxRates(store)), ccy));
  const learning = new LearningService({ store, getStrategy: (id) => getStrategy(id) });
  lines.push("", renderLearning(learning.snapshot({ now, adjustmentLimit: 20 })));
  return lines.join("\n");
}

function cmdReport(io: Io): number {
  const config = loadConfig();
  const store = createStore(resolveDbPath(config));
  try {
    io.out(buildReportText(config, store));
    return 0;
  } finally {
    store.close();
  }
}

/** キルスイッチ・日次停止の解除 (config.mode のリスク状態だけ)。解除した場合 true */
export function resumeTrading(config: AppConfig, store: Store, now: number = Date.now(), by = "cli"): { resumed: boolean; message: string } {
  const mode = config.mode;
  const risk = new RiskManager(config.risk, store, { mode });
  const st = risk.state();
  if (!st.killSwitch && st.haltedUntil === undefined) return { resumed: false, message: `停止状態ではありません (${mode}、変更なし)` };
  const last = store.listEquity({ mode }).at(-1);
  risk.resume({ ...(last ? { equity: last.equity } : {}), now, by });
  // 別プロセスで動作中のエンジンはメモリ上の状態を持つので、kv の再開要求でも依頼する (同じ mode のエンジンが次のティックで適用)
  requestResume(store, { at: now, by, mode });
  const what = st.killSwitch ? `キルスイッチ (${st.killSwitch.reason})` : `日次停止 (${fmtTime(st.haltedUntil)} まで)`;
  return { resumed: true, message: `${what} を解除しました。監査ログに記録しました。` };
}

function cmdResume(io: Io): number {
  const config = loadConfig();
  const store = createStore(resolveDbPath(config));
  try {
    const r = resumeTrading(config, store);
    io.out(r.message);
    if (r.resumed) io.out("※ 実行中のエンジンへは再開要求として伝えました。次のティックで自動的に反映されます (再起動は不要)。エンジンが停止中なら次回起動時の状態から再開します。");
    return 0;
  } finally {
    store.close();
  }
}

function cmdStatus(io: Io): number {
  const config = loadConfig();
  const m = modeLines(config);
  m.out.forEach((l) => io.out(l));
  m.warn.forEach((l) => io.err(l));
  io.out(venuesLine(config));
  io.out(`監視銘柄 (WATCHLIST): ${config.env.WATCHLIST || "(既定)"}`);
  const dbPath = resolveDbPath(config);
  io.out(`口座通貨: ${config.env.BASE_CURRENCY} / DB: ${dbPath} / AI: ${config.ai.enabled ? config.ai.model : "無効"}`);
  riskLines(config).forEach((l) => io.out(l));
  const store = createStore(dbPath);
  try {
    const now = Date.now();
    const mode = config.mode;
    const risk = new RiskManager(config.risk, store, { mode });
    const h = risk.isHalted(now);
    io.out(`停止状態 (${mode}): ${h.halted ? h.reason : "なし"}`);
    const eq = store.listEquity({ mode }).at(-1);
    io.out(`最新の評価額: ${eq ? `${fmtNum(eq.equity, 0)} ${config.env.BASE_CURRENCY} (${fmtTime(eq.ts)}, ${eq.mode})` : "(記録なし)"}`);
    const open = new TradeJournal({ store, mode }).list();
    io.out(`保有ポジション (${mode}): ${open.length} 件`);
    for (const p of open) io.out(`  ${p.symbol} ${p.direction === "long" ? "買い" : "売り"} ${p.qty} @ ${p.entryPrice} (${p.strategyId}, ${fmtTime(p.entryTs)})`);
    const pending = new PendingOrders({ store, mode }).list();
    if (pending.length) {
      io.out(`保留中の注文 (${mode}): ${pending.length} 件 (取引所で状態を確認してください)`);
      for (const o of pending) {
        io.out(`  ${o.symbol} ${o.kind === "entry" ? "エントリー" : "決済"} ${o.side} ${o.qty} clientId=${o.clientId}${o.orderId ? ` orderId=${o.orderId}` : ""} 状態 ${o.status} (${fmtTime(o.createdAt)})${o.lastError ? ` ${o.lastError}` : ""}`);
      }
    }
    const plan = store.latestPlan();
    io.out(`最新の計画: ${plan ? `${fmtTime(plan.generatedAt)} (有効期限 ${fmtTime(plan.validUntil)})` : "(なし)"}`);
    const brief = store.latestBrief();
    io.out(`最新のブリーフ: ${brief ? `${fmtTime(brief.generatedAt)} リスクオン ${brief.riskOn.toFixed(2)}` : "(なし)"}`);
    io.out(`決済済みトレード: ${store.listTrades().length} 件`);
    return 0;
  } finally {
    store.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2), io: Io = consoleIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.flags.help || args.command === "help") {
      io.out(HELP);
      return 0;
    }
    switch (args.command) {
      case "run":
        return await cmdRun(io);
      case "simulate":
        return await cmdSimulate(args.flags, io);
      case "backtest":
        return await cmdBacktest(args.flags, io);
      case "intel":
        return await cmdIntel(io);
      case "report":
        return cmdReport(io);
      case "resume":
        return cmdResume(io);
      case "status":
        return cmdStatus(io);
      default:
        io.err(`未知のコマンド: ${args.command}\n`);
        io.out(HELP);
        return 2;
    }
  } catch (e) {
    io.err(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof CliError ? 2 : 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
