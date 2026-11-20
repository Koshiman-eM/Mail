/**
 * CLI: run / simulate / backtest / intel / report / resume / status / orders
 * 依存なしの簡易引数解析。表示はすべて日本語。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "./core/config";
import type { Store, TradeRecord } from "./core/types";
import { isLoopbackHost, startDashboard, type DashboardServer } from "./dashboard/server";
import { formatBacktestRows, runBacktestCommand } from "./engine/backtestCommand";
import { DEFAULT_REGIME_TIMEFRAMES, runRegimeCommand } from "./engine/regimeReport";
import { createFxConverter, quoteCurrencyOfSymbol } from "./engine/fx";
import {
  equityStats, EXIT_REASON_LABEL, exitFxRates, exitReasonCounts, fmtNum, fmtPct, fmtSigned, fmtTime, isSimulatedShortTrade, liveExecutableTrades,
  renderLearning, renderSideTable, renderStrategyTable, summarizeBySide, summarizeByStrategy,
} from "./engine/report";
import { D } from "./core/decimal";
import { peekResolveRequests, PendingOrders, requestResolve, type PendingOrder, type ResolveRequest } from "./engine/orders";
import { acquireEngineLock, releaseEngineLock, startEngineLockHeartbeat, type LockOwner } from "./engine/lock";
import { buildRuntime, parseVenues, resolveDbPath } from "./engine/setup";
import { formatSimulationReport, runSimulation } from "./engine/simulate";
import { createDefaultSources, IntelService } from "./intel/service";
import { TradeJournal } from "./learning/journal";
import { LearningService } from "./learning/service";
import { CcxtFeed } from "./market/feeds/ccxt";
import { GmoFeed } from "./market/feeds/gmo";
import { runGmoCheck } from "./market/gmo/check";
import { parseGmoSymbols } from "./market/gmo/client";
import { RiskManager } from "./risk/manager";
import { requestResume } from "./risk/resumeRequest";
import { riskOverrideLines } from "./risk/settings";
import { createStore } from "./storage";
import { ReadOnlyOverlayStore } from "./storage/readonly";
import { getStrategy } from "./strategies/registry";
import { TIMEFRAME_MS, type ExitReason, type Timeframe } from "./core/types";

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

/** 10 進の数値表記 (符号・小数点のみ。16 進・指数・空白・空文字は受け付けない) */
const DECIMAL_RE = /^-?(\d+(\.\d+)?|\.\d+)$/;
/** 10 進の正の数の表記 (数量・価格用) */
const POSITIVE_DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;

export function numberFlag(
  flags: ParsedArgs["flags"],
  name: string,
  def: number,
  o: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const v = flags[name];
  if (v === undefined) return def;
  if (typeof v !== "string" || v.trim() === "") throw new CliError(`--${name} に値を指定してください`);
  if (!DECIMAL_RE.test(v)) throw new CliError(`--${name} には 10 進の数値を指定してください (指定値: ${v})`);
  const n = Number(v);
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

export interface RegimeArgs {
  symbol: string;
  hours: number;
  timeframes: Timeframe[];
  stepMin: number;
}

export function parseRegimeArgs(flags: ParsedArgs["flags"]): RegimeArgs {
  const symbol = stringFlag(flags, "symbol", "");
  if (!symbol) throw new CliError("--symbol <銘柄> を指定してください (例: BTC/JPY)");
  const tfs = stringFlag(flags, "tf", DEFAULT_REGIME_TIMEFRAMES.join(","))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tfs) if (!(t in TIMEFRAME_MS) || t === "1s") throw new CliError(`--tf に未対応の時間足があります: ${t} (${Object.keys(TIMEFRAME_MS).filter((k) => k !== "1s").join(", ")})`);
  if (tfs.length === 0) throw new CliError("--tf に時間足を指定してください");
  return {
    symbol,
    hours: numberFlag(flags, "hours", 3, { min: 0.1, max: 168 }),
    timeframes: [...new Set(tfs)] as Timeframe[],
    stepMin: numberFlag(flags, "step", 5, { min: 1, max: 1440 }),
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
  regime --symbol SYM [--hours 3] [--tf 1m,15m,1h,4h] [--step 5]
                              各時刻の相場の状態 (レジーム) を運用と同じ判定で表示 (ccxt の履歴。先読みなし)
  intel                       情報収集を 1 回実行してブリーフを表示
  report                      評価額・戦略別成績・学習の状態を表示 (DB_PATH)
  resume                      キルスイッチ・日次停止を解除 (監査ログに記録)
  status                      設定と現在の状態を表示
  orders                      保留中の注文 (受付済み・未約定、状態不明) を一覧
  orders resolve <clientId> --none
                              状態不明の注文を「約定なし」として解消 (取引所で約定していないことを確認してから)
  orders resolve <clientId> --filled --qty <数量> --price <価格>
                              状態不明の注文を「約定した」として解消 (推定扱いで記録し、学習には使いません)
                              動作中のエンジンは次のティックで、停止中なら次回の起動時に適用します (監査ログに記録)
                              状態不明 (escalated) でない注文には --force が必要です。
                              --none で取消に失敗した場合は確定せず、建玉の照会で確定させます
  gmo check                   GMOコインの API の応答の形を確かめる (公開 API と、キーがあれば読み取り専用の非公開 API。
                              注文・取消は呼びません。キーは表示しません)

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
    "リスク上限 (.env):",
    `  1 トレードのリスク ${fmtPct(r.riskPerTrade)} / 日次損失 ${fmtPct(r.maxDailyLoss)} / 最大ドローダウン ${fmtPct(r.maxDrawdown)}`,
    `  最大保有数 ${r.maxOpenPositions} / 1 銘柄 ${fmtPct(r.maxPositionPct, 0)} / 発注 ${r.maxOrdersPerMinute} 回/分 / 期待値幅 ≥ コスト × ${r.minEdgeToCostRatio}`,
    `  資産クラス上限: ${Object.entries(r.maxExposureByClass).map(([k, v]) => `${k} ${fmtPct(v, 0)}`).join(" / ")} / ミーム最低流動性 $${fmtNum(r.memeMinLiquidityUsd, 0)}`,
  ];
}

/**
 * 読み取り系コマンド用: DB ファイルが無いときは新規作成せずエラーにする
 * (作業ディレクトリ違いで空の DB を作って「記録なし」と誤解するのを防ぐ)。メモリ DB は対象外
 */
function openExistingStore(dbPath: string): Store {
  if (dbPath !== "memory" && dbPath !== ":memory:" && !existsSync(dbPath)) {
    throw new CliError(`DB_PATH が見つかりません: ${resolve(dbPath)}。作業ディレクトリを確認してください`);
  }
  return createStore(dbPath);
}

// ───────── コマンド ─────────

/**
 * run 用: 同じ mode のエンジンの二重起動防止ロックを取得する (kv `engine:lock:<mode>`)。
 * 動いているエンジンがあれば (heartbeat が 60 秒以内) メッセージを出して undefined。古いロックは奪取してログに残す
 */
export function acquireRunLock(store: Store, mode: "paper" | "live", io: Io, now: number = Date.now()): LockOwner | undefined {
  const r = acquireEngineLock(store, mode, { now });
  if (!r.ok) {
    io.err(`エラー: ${r.message}。二重に起動しないため終了します`);
    return undefined;
  }
  if (r.stolen) {
    io.err(
      `警告: 古いエンジンのロックを引き継ぎました (pid ${r.stolen.pid}, host ${r.stolen.hostname}, ` +
        `最終 heartbeat ${Math.round((now - r.stolen.heartbeatAt) / 1000)} 秒前)。前回のエンジンが異常終了した可能性があります`,
    );
  }
  return { pid: r.lock.pid, hostname: r.lock.hostname, startedAt: r.lock.startedAt };
}

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
  riskOverrideLines(rt.store, rt.engine.mode, config.risk, fmtTime).forEach((l) => io.out(l));
  io.out(`AI: ${rt.ai ? `有効 (${rt.ai.model})` : "無効 (ルールベース)"}`);

  // 同じ mode のエンジンの二重起動防止 (同じ DB の kv にロックを書き、15 秒ごとに heartbeat を更新する)
  const mode = rt.engine.mode;
  const owner = acquireRunLock(rt.store, mode, io);
  if (!owner) {
    try {
      rt.close();
    } catch {
      /* 既に閉じている */
    }
    return 1;
  }
  const releaseLock = () => {
    try {
      releaseEngineLock(rt.store, mode, owner);
    } catch (e) {
      io.err(`警告: エンジンのロックの削除に失敗しました (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  // 起動中 (シグナル待ちに入る前) にロックを失った場合も、待ちに入った時点で停止する
  let lockLostReason: string | undefined;
  let onLockLost: (reason: string) => void = () => undefined;
  const heartbeat = startEngineLockHeartbeat(rt.store, mode, owner, {
    now: () => Date.now(),
    onLost: (reason) => {
      lockLostReason = reason;
      onLockLost(reason);
    },
    onError: (msg, failures) => io.err(`警告: エンジンのロックの heartbeat の更新に失敗しました (${failures} 回目): ${msg}`),
  });

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
        chartTimeframes: () => rt.hub.timeframes(),
        candles: (s, tf, n) => (rt.hub.timeframes() as string[]).includes(tf) ? rt.hub.chartCandles(s, tf as Timeframe, n) : undefined,
        // リスク設定タブ: 保存したら動作中の RiskManager に即座に読み直させる (エンジンの再起動は不要)
        riskSettings: { mode, envLimits: config.risk, onChange: () => rt.engine.risk.refreshLimits() },
      },
      { host: config.env.DASHBOARD_HOST, port: config.env.DASHBOARD_PORT, writeToken: config.env.DASHBOARD_WRITE_TOKEN },
    );
    io.out(`ダッシュボード: ${dash.url} (閲覧 + リスク設定の変更)`);
    if (!isLoopbackHost(config.env.DASHBOARD_HOST)) {
      io.err("警告: ダッシュボードがループバック以外で待ち受けています。認証が無いため外部公開は避けてください。");
      io.err(
        config.env.DASHBOARD_WRITE_TOKEN.length >= 16
          ? "  リスク設定の変更には DASHBOARD_WRITE_TOKEN の入力が必要です。"
          : "  DASHBOARD_WRITE_TOKEN (16 文字以上) が未設定のため、リスク設定は変更できません (閲覧のみ)。",
      );
    }
  } catch (e) {
    io.err(`警告: ダッシュボードを起動できませんでした (${e instanceof Error ? e.message : String(e)})。取引は続行します`);
  }

  try {
    await rt.engine.start();
  } catch (e) {
    // 起動に失敗したら後始末して異常終了 (systemd の Restart= で再起動できるようにする)
    io.err(`エラー: エンジンの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    await rt.engine.stop().catch(() => undefined);
    await dash?.close().catch(() => undefined);
    heartbeat.stop();
    releaseLock();
    try {
      rt.close();
    } catch {
      /* 既に閉じている */
    }
    throw e;
  }
  io.out("起動しました。Ctrl+C で停止します (保有ポジションは自動決済しません)。");
  return await new Promise<number>((done) => {
    let stopping = false;
    const onSignal = async (sig: string, code = 0) => {
      if (stopping) return;
      stopping = true;
      io.out(`${sig} を受信: 停止します...`);
      try {
        heartbeat.stop();
        await rt.engine.stop();
        await dash?.close();
      } finally {
        // ロックを失った (別のエンジンが奪取した) 場合は相手のロックを消さない (releaseEngineLock は自分のものだけ消す)
        releaseLock();
        rt.close();
        io.out(`停止しました。保有ポジション ${rt.engine.journal.list().length} 件はそのままです。`);
        done(code);
      }
    };
    onLockLost = (reason) => {
      io.err(`エラー: エンジンのロックを失いました (${reason})。二重に動作しないよう停止します`);
      void onSignal("LOCK_LOST", 1);
    };
    if (lockLostReason !== undefined) onLockLost(lockLostReason);
    process.once("SIGINT", () => void onSignal("SIGINT"));
    process.once("SIGTERM", () => void onSignal("SIGTERM"));
  });
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
  const symbol = a.symbol ?? (a.source === "ccxt" ? (["bitflyer", "bitbank", "coincheck", "zaif"].includes(config.env.CCXT_EXCHANGE) ? "BTC/JPY" : "BTC/USDT") : "SYN/USDT");
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

async function cmdRegime(flags: ParsedArgs["flags"], io: Io): Promise<number> {
  const a = parseRegimeArgs(flags);
  const config = loadConfig();
  // 運用中と同じ取引所の足で判定する (VENUES に gmo があれば GMOコイン、無ければ ccxt の CCXT_EXCHANGE)
  let useGmo = false;
  try {
    useGmo = parseVenues(config.env.VENUES).includes("gmo");
  } catch {
    /* VENUES が不正なら ccxt を使う */
  }
  const feed = useGmo
    ? new GmoFeed({ symbols: parseGmoSymbols(config.env.GMO_SYMBOLS), holdingFeeDaily: config.env.GMO_LEVERAGE_FEE_DAILY, allowSpotCandles: true })
    : CcxtFeed.create(config.env.CCXT_EXCHANGE);
  io.out(useGmo ? "GMOコインから履歴を取得します..." : `ccxt (${config.env.CCXT_EXCHANGE}) から履歴を取得します...`);
  io.out(await runRegimeCommand({ feed, symbol: a.symbol, hours: a.hours, timeframes: a.timeframes, stepMin: a.stepMin }));
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
  const toAcct = (c: string) => fx.toAccount(c);
  const quoteOf = (t: TradeRecord) => quoteCurrencyOfSymbol(t.symbol);
  const rates = exitFxRates(store);
  // 買い・取引所で可能な売りと、paper で再現した空売り (live では実行できない) を分けて表示する
  lines.push("", "■ 方向別の成績");
  lines.push(renderSideTable(summarizeBySide(trades, toAcct, quoteOf, rates), ccy));
  const simShorts = trades.filter(isSimulatedShortTrade);
  lines.push("", `■ 戦略別の成績${simShorts.length ? " (live で実行できる取引。空売り (paper 再現) を除く)" : ""} (口座通貨換算は決済時点のレート。記録が無いものは概算レート)`);
  lines.push(renderStrategyTable(summarizeByStrategy(liveExecutableTrades(trades), toAcct, quoteOf, rates), ccy));
  if (simShorts.length) {
    lines.push("", "■ 戦略別の成績 (空売り (paper 再現)。live では空売りしません)");
    lines.push(renderStrategyTable(summarizeByStrategy(simShorts, toAcct, quoteOf, rates), ccy));
  }
  // 学習状態は取引 mode (paper / live) 別。report は読み取り専用なので、起動時の移行などの書き込みは DB に反映しない
  const learning = new LearningService({ store: new ReadOnlyOverlayStore(store), mode: config.mode, getStrategy: (id) => getStrategy(id) });
  lines.push("", `学習状態: ${config.mode}`);
  lines.push(renderLearning(learning.snapshot({ now, adjustmentLimit: 20 })));
  return lines.join("\n");
}

function cmdReport(io: Io): number {
  const config = loadConfig();
  const store = openExistingStore(resolveDbPath(config));
  try {
    io.out(buildReportText(config, store));
    return 0;
  } finally {
    store.close();
  }
}

const RESOLVE_HINT = [
  "  約定していない: npm run trader -- orders resolve <clientId> --none",
  "  約定した:       npm run trader -- orders resolve <clientId> --filled --qty <数量> --price <価格>",
];

/** 保留中の注文 1 件の表示 */
function pendingOrderLine(o: PendingOrder): string {
  return (
    `  ${o.escalated ? "[状態不明] " : ""}${o.symbol} ${o.kind === "entry" ? "エントリー" : "決済"} ${o.side} ${o.qty} clientId=${o.clientId}` +
    `${o.orderId ? ` orderId=${o.orderId}` : ""} 状態 ${o.status}${o.unknownCount ? ` (不明 ${o.unknownCount} 回)` : ""} 発注 ${fmtTime(o.createdAt)}` +
    `${o.lastError ? ` ${cleanText(o.lastError)}` : ""}`
  );
}

/** 状態不明 (escalated) の保留注文の警告 (resume のときに表示する) */
function escalatedWarnings(store: Store, mode: "paper" | "live"): string[] {
  const esc = new PendingOrders({ store, mode }).escalated();
  if (esc.length === 0) return [];
  return [
    `警告: 状態不明の注文が ${esc.length} 件残っています (${mode})。解消するまで新規エントリーは止まったままです (決済は続けます)。`,
    ...esc.map(pendingOrderLine),
    "取引所で注文と建玉を確認し、次のどちらかで解消してください (エンジンは建玉の照会でも自動的に確定させます):",
    ...RESOLVE_HINT,
  ];
}

/**
 * キルスイッチ・日次停止の解除 (config.mode のリスク状態だけ)。解除した場合 resumed: true。
 * 状態不明の保留注文が残っていれば warnings に一覧と `orders resolve` の案内を入れる (解除自体は行う)
 */
export function resumeTrading(
  config: AppConfig,
  store: Store,
  now: number = Date.now(),
  by = "cli",
): { resumed: boolean; message: string; warnings: string[] } {
  const mode = config.mode;
  const risk = new RiskManager(config.risk, store, { mode });
  const st = risk.state();
  const warnings = escalatedWarnings(store, mode);
  if (!st.killSwitch && st.haltedUntil === undefined) return { resumed: false, message: `停止状態ではありません (${mode}、変更なし)`, warnings };
  const last = store.listEquity({ mode }).at(-1);
  risk.resume({ ...(last ? { equity: last.equity } : {}), now, by });
  // 別プロセスで動作中のエンジンはメモリ上の状態を持つので、kv の再開要求でも依頼する (同じ mode のエンジンが次のティックで適用)
  requestResume(store, { at: now, by, mode });
  const what = st.killSwitch ? `キルスイッチ (${st.killSwitch.reason})` : `日次停止 (${fmtTime(st.haltedUntil)} まで)`;
  return { resumed: true, message: `${what} を解除しました。監査ログに記録しました。`, warnings };
}

function cmdResume(io: Io): number {
  const config = loadConfig();
  const store = openExistingStore(resolveDbPath(config));
  try {
    const r = resumeTrading(config, store);
    io.out(r.message);
    if (r.resumed) io.out("※ 実行中のエンジンへは再開要求として伝えました。次のティックで自動的に反映されます (再起動は不要)。エンジンが停止中なら次回起動時の状態から再開します。");
    r.warnings.forEach((l) => io.err(l));
    return 0;
  } finally {
    store.close();
  }
}

/** `orders`: 保留中の注文と、まだ適用されていない解消の要求 (config.mode) */
export function pendingOrdersText(config: AppConfig, store: Store): string {
  const mode = config.mode;
  const pending = new PendingOrders({ store, mode }).list();
  const lines: string[] = [];
  if (pending.length === 0) lines.push(`保留中の注文はありません (${mode})`);
  else {
    lines.push(`保留中の注文 (${mode}): ${pending.length} 件`);
    lines.push(...pending.map(pendingOrderLine));
    if (pending.some((o) => o.escalated)) {
      lines.push("", "状態不明の注文がある間は新規エントリーを止めています (決済は続けます。建玉の照会で確定すれば自動で再開します)。");
      lines.push("取引所で注文と建玉を確認してから、次のどちらかで解消できます:", ...RESOLVE_HINT);
    }
  }
  const reqs = peekResolveRequests(store, mode);
  if (reqs.length) {
    lines.push("", `適用待ちの解消要求: ${reqs.length} 件 (動作中のエンジンは次のティック、停止中なら次回の起動時に適用)`);
    for (const r of reqs) lines.push(`  clientId=${r.clientId} ${r.outcome === "none" ? "約定なし" : `約定 ${r.qty} @ ${r.price}`} (${fmtTime(r.at)})`);
  }
  return lines.join("\n");
}

export interface ResolveArgs {
  clientId: string;
  outcome: "none" | "filled";
  qty?: string;
  price?: number;
  /** 状態不明 (escalated) ではない注文も解消する */
  force?: boolean;
}

/**
 * `orders resolve` の引数解析。--none と --filled のどちらか一方 (--filled は --qty と --price が必要)。
 * 数量・価格は 10 進の正の有限数だけを受け付ける。余分な位置引数はエラー
 */
export function parseResolveArgs(positionals: string[], flags: ParsedArgs["flags"]): ResolveArgs {
  if (positionals.length > 1) throw new CliError(`余分な引数があります: ${positionals.slice(1).join(" ")} (clientId は 1 つだけ指定してください)`);
  // `--none <clientId>` / `--force <clientId>` の書き方も受け付ける (値付きフラグとして解析されるため)
  const ids = [positionals[0], ...[flags.none, flags.filled, flags.force].map((v) => (typeof v === "string" ? v : undefined))].filter(
    (v): v is string => v !== undefined,
  );
  if (new Set(ids).size > 1) throw new CliError(`clientId が複数指定されています: ${[...new Set(ids)].join(", ")}`);
  const clientId = ids[0];
  if (!clientId) throw new CliError("解消する注文の clientId を指定してください (npm run trader -- orders で一覧)");
  const known = new Set(["none", "filled", "qty", "price", "force"]);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) throw new CliError(`orders resolve に未知のオプションがあります: ${unknown.map((k) => `--${k}`).join(" ")}`);
  const force = flags.force !== undefined;
  const none = flags.none !== undefined;
  const filled = flags.filled !== undefined;
  if (none === filled) throw new CliError("--none (約定なし) か --filled --qty <数量> --price <価格> (約定した) のどちらか一方を指定してください");
  if (none) {
    if (flags.qty !== undefined || flags.price !== undefined) throw new CliError("--none には --qty / --price を指定できません");
    return { clientId, outcome: "none", ...(force ? { force: true } : {}) };
  }
  const qtyStr = stringFlag(flags, "qty", "");
  if (!qtyStr) throw new CliError("--filled には --qty <約定数量> が必要です");
  if (!POSITIVE_DECIMAL_RE.test(qtyStr)) throw new CliError(`--qty には 10 進の正の数値を指定してください (指定値: ${qtyStr})`);
  const qty = D(qtyStr);
  if (!qty.isFinite() || !qty.gt(0)) throw new CliError(`--qty には正の数値を指定してください (指定値: ${qtyStr})`);
  if (flags.price === undefined) throw new CliError("--filled には --price <約定価格> が必要です");
  const priceStr = stringFlag(flags, "price", "");
  if (!POSITIVE_DECIMAL_RE.test(priceStr)) throw new CliError(`--price には 10 進の正の数値を指定してください (指定値: ${priceStr})`);
  const price = Number(priceStr);
  if (!Number.isFinite(price) || !(price > 0)) throw new CliError("--price には正の数値を指定してください");
  return { clientId, outcome: "filled", qty: qty.toString(), price, ...(force ? { force: true } : {}) };
}

/**
 * 保留中の注文の解消を要求する (kv `orders:resolveRequests:<mode>`)。
 * 動作中のエンジンは次のティックで、停止中なら次回の起動時に適用し、監査ログ order.manual_resolve を残す
 */
export function requestOrderResolve(config: AppConfig, store: Store, a: ResolveArgs, now: number = Date.now(), by = "cli"): { request: ResolveRequest; message: string } {
  const mode = config.mode;
  const o = new PendingOrders({ store, mode }).get(a.clientId);
  if (!o) throw new CliError(`保留中の注文が見つかりません (${mode}, clientId=${a.clientId})。npm run trader -- orders で一覧を確認してください`);
  if (!o.escalated && !a.force) {
    throw new CliError(
      `この注文は状態不明 (escalated) ではありません (状態 ${o.status})。エンジンの照会で確定するのを待ってください。` +
        "取引所で注文と建玉を確認したうえで強制的に解消する場合は --force を付けてください",
    );
  }
  if (a.outcome === "filled" && D(a.qty!).gt(D(o.qty))) {
    throw new CliError(`--qty (${a.qty}) が注文数量 (${o.qty}) を超えています`);
  }
  const request: ResolveRequest = {
    id: randomUUID(),
    clientId: a.clientId,
    outcome: a.outcome,
    ...(a.outcome === "filled" ? { qty: a.qty, price: a.price } : {}),
    ...(a.force ? { force: true } : {}),
    at: now,
    by,
  };
  requestResolve(store, mode, request);
  store.audit({
    ts: now,
    type: "order.manual_resolve_requested",
    data: {
      mode, clientId: a.clientId, symbol: o.symbol, kind: o.kind, outcome: a.outcome, ...(a.outcome === "filled" ? { qty: a.qty, price: a.price } : {}),
      escalated: Boolean(o.escalated), ...(a.force ? { force: true } : {}), by,
    },
  });
  const what = a.outcome === "none" ? "約定なし" : `約定 (数量 ${a.qty} / 価格 ${a.price}、推定扱い・学習には使いません)`;
  return {
    request,
    message:
      `${o.symbol} ${o.kind === "entry" ? "エントリー" : "決済"} (clientId=${a.clientId}) を「${what}」として解消する要求を登録しました。` +
      "動作中のエンジンは次のティックで、停止中なら次回の起動時に適用します (監査ログに記録)。",
  };
}

function cmdOrders(positionals: string[], flags: ParsedArgs["flags"], io: Io): number {
  const sub = positionals[0];
  if (sub !== undefined && sub !== "list" && sub !== "resolve") throw new CliError(`未知のサブコマンド: orders ${sub} (orders / orders resolve)`);
  if (sub !== "resolve" && positionals.length > 1) throw new CliError(`余分な引数があります: ${positionals.slice(1).join(" ")}`);
  const args = sub === "resolve" ? parseResolveArgs(positionals.slice(1), flags) : undefined;
  const config = loadConfig();
  const store = openExistingStore(resolveDbPath(config));
  try {
    if (!args) {
      io.out(pendingOrdersText(config, store));
      return 0;
    }
    io.out(requestOrderResolve(config, store, args).message);
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
  const store = openExistingStore(dbPath);
  try {
    const now = Date.now();
    const mode = config.mode;
    // .env の値 (上の riskLines) に対する、ダッシュボードの上書き値と実効値
    riskOverrideLines(store, mode, config.risk, fmtTime).forEach((l) => io.out(l));
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
      io.out(`保留中の注文 (${mode}): ${pending.length} 件 (取引所で状態を確認してください。解消は npm run trader -- orders)`);
      for (const o of pending) io.out(pendingOrderLine(o));
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

/** `gmo check`: GMOコインの API の応答の形を確かめる (GET だけ。注文・取消は呼ばない) */
async function cmdGmo(positionals: string[], io: Io): Promise<number> {
  const [sub, ...rest] = positionals;
  if (sub !== "check" || rest.length > 0) throw new CliError(`使い方: npm run trader -- gmo check (未知の引数: ${positionals.join(" ") || "(なし)"})`);
  const config = loadConfig();
  return runGmoCheck({
    env: { GMO_API_KEY: config.env.GMO_API_KEY, GMO_API_SECRET: config.env.GMO_API_SECRET, GMO_SYMBOLS: config.env.GMO_SYMBOLS },
    out: (s) => io.out(s),
  });
}

export async function main(argv: string[] = process.argv.slice(2), io: Io = consoleIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    if (args.flags.help || args.command === "help") {
      io.out(HELP);
      return 0;
    }
    if (args.command !== "orders" && args.command !== "gmo" && args.positionals.length > 0) {
      throw new CliError(`余分な引数があります: ${args.positionals.join(" ")} (${args.command} は位置引数を取りません)`);
    }
    switch (args.command) {
      case "run":
        return await cmdRun(io);
      case "simulate":
        return await cmdSimulate(args.flags, io);
      case "backtest":
        return await cmdBacktest(args.flags, io);
      case "regime":
        return await cmdRegime(args.flags, io);
      case "intel":
        return await cmdIntel(io);
      case "report":
        return cmdReport(io);
      case "resume":
        return cmdResume(io);
      case "status":
        return cmdStatus(io);
      case "orders":
        return cmdOrders(args.positionals, args.flags, io);
      case "gmo":
        return await cmdGmo(args.positionals, io);
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
      // 異常終了時は残ったタイマー等があっても確実に終わらせる
      if (code !== 0) setTimeout(() => process.exit(code), 500).unref();
    },
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
