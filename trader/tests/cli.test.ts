import { describe, expect, it, vi } from "vitest";
import { RESUME_REQUEST_KEY } from "../src/risk/resumeRequest";
import {
  acquireRunLock, buildReportText, CliError, HELP, main, numberFlag, parseArgs, parseBacktestArgs, parseResolveArgs, parseSimulateArgs, pendingOrdersText,
  requestOrderResolve, resumeTrading,
} from "../src/cli";
import { engineLockKey } from "../src/engine/lock";
import { learningMigrationFlagKey } from "../src/learning/migration";
import { PendingOrders, peekResolveRequests, type PendingOrder } from "../src/engine/orders";
import { loadConfig } from "../src/core/config";
import type { Candle } from "../src/core/types";
import { fetchCandlesPaged, formatBacktestRows, runBacktestCommand } from "../src/engine/backtestCommand";
import { exitFxRates, formatTable, strWidth, summarizeByStrategy } from "../src/engine/report";
import { formatSimulationReport, runSimulation } from "../src/engine/simulate";
import { RiskManager } from "../src/risk/manager";
import { MemoryStore } from "../src/storage/memory";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe("CLI の引数解析", () => {
  it("コマンド・--key value・--key=value・真偽フラグ・位置引数", () => {
    expect(parseArgs(["simulate", "x", "--days", "2", "--seed=7", "--verbose"])).toEqual({
      command: "simulate",
      flags: { days: "2", seed: "7", verbose: true },
      positionals: ["x"],
    });
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["run", "--a", "--b", "1"]).flags).toEqual({ a: true, b: "1" });
    expect(parseArgs(["backtest", "--", "--x"]).positionals).toEqual(["--x"]);
  });

  it("simulate の既定値と検証", () => {
    expect(parseSimulateArgs({})).toEqual({ days: 3, hours: 0, seed: 1, db: "memory", stepMs: 15_000 });
    expect(parseSimulateArgs({ days: "1", seed: "9", db: "./data/sim.db", step: "30" })).toEqual({ days: 1, hours: 0, seed: 9, db: "./data/sim.db", stepMs: 30_000 });
    expect(parseSimulateArgs({ hours: "6" })).toMatchObject({ days: 0, hours: 6 });
    expect(() => parseSimulateArgs({ days: "abc" })).toThrow(CliError);
    expect(() => parseSimulateArgs({ days: "-1" })).toThrow(/0 以上/);
    expect(() => parseSimulateArgs({ seed: "1.5" })).toThrow(/整数/);
    expect(() => parseSimulateArgs({ db: true })).toThrow(/値を指定/);
  });

  it("backtest の既定値と検証", () => {
    expect(parseBacktestArgs({ strategy: "all" })).toEqual({ strategy: "all", days: 30, source: "synthetic", seed: 1 });
    expect(parseBacktestArgs({ strategy: "short_ema_trend", symbol: "BTC/JPY", days: "7", source: "ccxt", seed: "3" })).toEqual({
      strategy: "short_ema_trend", symbol: "BTC/JPY", days: 7, source: "ccxt", seed: 3,
    });
    expect(() => parseBacktestArgs({})).toThrow(/--strategy/);
    expect(() => parseBacktestArgs({ strategy: "nope" })).toThrow(/未知の戦略/);
    expect(() => parseBacktestArgs({ strategy: "all", source: "csv" })).toThrow(/--source/);
  });

  it("main: help / 未知のコマンド / 引数エラーの終了コード", async () => {
    const a = io();
    expect(await main(["help"], a.io)).toBe(0);
    expect(a.out.join("\n")).toBe(HELP);
    const b = io();
    expect(await main(["dance"], b.io)).toBe(2);
    expect(b.err[0]).toMatch(/未知のコマンド/);
    const c = io();
    expect(await main(["simulate", "--days", "x"], c.io)).toBe(2);
    expect(c.err[0]).toMatch(/^エラー: --days/);
  });

  it("読み取り系コマンドは DB ファイルが無ければ新規作成せずエラー", async () => {
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbPath = join(tmpdir(), `nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    try {
      for (const argv of [["status"], ["report"], ["orders"], ["resume"]]) {
        const d = io();
        expect(await main(argv, d.io)).toBe(2);
        expect(d.err.join("\n")).toMatch(/DB_PATH が見つかりません: .*作業ディレクトリを確認してください/);
      }
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      if (old === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = old;
    }
  });
});

describe("simulate コマンド", () => {
  it("仮想数時間の短時間実行が例外なく終わり、日本語のレポートを出す", async () => {
    const a = io();
    const code = await main(["simulate", "--hours", "4", "--step", "30", "--seed", "1"], a.io);
    expect(a.err.filter((l) => l.startsWith("エラー"))).toEqual([]);
    expect(code).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("シミュレーション結果");
    expect(text).toContain("戦略別の成績");
    expect(text).toContain("学習の動き");
    expect(text).toContain("損益要因の集計");
    expect(text).toContain("■ 見送ったシグナルの答え合わせ (仮想トレード)");
    expect(text).toContain("■ ニュースと値動きの答え合わせ");
    expect(text).toMatch(/腕\s+件数\s+仮想/);
    expect(text).toContain("ニュース判定");
    // 値動きの予想の答え合わせ
    expect(text).toContain("■ 値動きの予想の答え合わせ");
    expect(text).toMatch(/値動きの予想: \d+ 件 \/ 判定 \d+ 件/);
    expect(text).toMatch(/時間\|資産クラス\s+トレンド\s+モメンタム\s+平均回帰\s+ニュース\s+戦略の合意\s+バイアス/);
    expect(text).toContain("取引への反映:");
    expect(text).toContain("較正 (pUp を 0.1 刻み");
  }, 60_000);

  it("runSimulation: レポートの中身 (paper のみ・要因分析済み)", async () => {
    const store = new MemoryStore();
    const progress = vi.fn();
    const { report, runtime } = await runSimulation({ hours: 3, stepMs: 30_000, seed: 2, store, onProgress: progress, progressEveryMs: 3_600_000 });
    expect(runtime.brokerSet.mode).toBe("paper");
    expect(report.ticks).toBe(3 * 120 + 1);
    expect(report.trades).toBe(store.listTrades().length);
    expect(report.attributedTrades).toBe(report.trades);
    expect(report.learning.learningRuns).toBe(3);
    // 見送ったシグナルの答え合わせ (保存件数と集計が一致)・ニュース判定 (合成データには情報が無いので 0 件)
    expect(report.learning.shadow.closed).toBe(store.listShadowTrades().length);
    expect(report.learning.shadow.counters.created).toBeGreaterThanOrEqual(report.learning.shadow.closed);
    expect(report.learning.news.recorded).toBe(0);
    // 値動きの予想: 5 分ごと × 3 時間 × 銘柄数。判定済みは保存件数と一致
    expect(report.learning.forecast.recorded).toBeGreaterThan(report.symbols.length * 3 * 30);
    const judged = report.learning.forecast.byHorizon.reduce((a, g) => a + g.n + g.noise + (g.flatPred - g.flatHits) + g.expired, 0);
    expect(judged).toBe(store.listForecastOutcomes().length);
    expect(report.learning.forecast.byClass.every((g) => !g.live)).toBe(true);
    expect(report.plans).toBeGreaterThanOrEqual(12);
    expect(report.finalEquity).toBeGreaterThan(0);
    expect(progress).toHaveBeenCalled();
    expect(formatSimulationReport(report)).toContain(`取引数: ${report.trades}`);
  }, 60_000);
});

describe("backtest コマンド", () => {
  it("合成データで単一戦略と all (板必須は対象外)", async () => {
    const one = await runBacktestCommand({ strategy: "short_ema_trend", days: 3, source: "synthetic", seed: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].baseTimeframe).toBe("15m");
    expect(one[0].metrics).toBeDefined();
    const all = await runBacktestCommand({ strategy: "all", days: 1, source: "synthetic", seed: 1 });
    expect(all.map((r) => r.strategyId)).toContain("pullback_15m");
    expect(all).toHaveLength(11);
    expect(all.find((r) => r.strategyId === "scalp_obi")?.note).toMatch(/板情報/);
    const table = formatBacktestRows(all);
    expect(table).toContain("勝率");
    expect(table.split("\n")).toHaveLength(all.length + 2);
    await expect(runBacktestCommand({ strategy: "nope", days: 1, source: "synthetic", seed: 1 })).rejects.toThrow(/未知の戦略/);
  }, 60_000);

  it("ccxt の履歴はページングして取得する", async () => {
    const all: Candle[] = Array.from({ length: 2500 }, (_, i) => ({ ts: i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const fetchCandles = vi.fn(async (_s: string, _tf: string, limit: number, since?: number) => all.filter((c) => c.ts >= (since ?? 0)).slice(0, limit));
    const out = await fetchCandlesPaged({ fetchCandles }, "BTC/USDT", "1m", 0, 2500 * 60_000, { pageLimit: 1000 });
    expect(out).toHaveLength(2500);
    expect(fetchCandles).toHaveBeenCalledTimes(3);
    expect(out[2499].ts).toBe(2499 * 60_000);
  });
});

describe("report / resume", () => {
  it("DB の成績と学習の状態を日本語で表示する", async () => {
    const store = new MemoryStore();
    await runSimulation({ hours: 2, stepMs: 30_000, seed: 2, store });
    const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" });
    const text = buildReportText(config, store, Date.UTC(2026, 0, 6));
    expect(text).toContain("評価額 (paper)");
    expect(text).toContain("■ 値動きの予想の答え合わせ");
    expect(text).toMatch(/mode paper \/ 予想 [1-9]\d* 件/);
    expect(text).toMatch(/15m\s+crypto\s+\d+/);
    expect(text).toMatch(/15m\|crypto\s+[+-]\d/);
    expect(text).toContain("取引への反映: なし");
    expect(text).toContain("戦略別の成績");
    expect(text).toContain("腕の成績");
    expect(text).toContain("有効な教訓");
    expect(text).toContain("最近のパラメータ調整");
    expect(text).toContain("情報源の信頼度");
    expect(text).toContain("損益要因の集計");
    expect(text).toContain("■ 見送ったシグナルの答え合わせ (仮想トレード)");
    expect(text).toContain("■ ニュースと値動きの答え合わせ");
    expect(text).toMatch(/腕\s+件数\s+仮想/);
  }, 60_000);

  it("resume: キルスイッチを解除して監査ログに残す", () => {
    const store = new MemoryStore();
    const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" });
    expect(resumeTrading(config, store).resumed).toBe(false);
    const risk = new RiskManager(config.risk, store);
    risk.trip("テスト", 1000);
    store.saveEquity({ ts: 1000, equity: 900_000, mode: "paper" });
    const r = resumeTrading(config, store, 2000);
    expect(r.resumed).toBe(true);
    expect(r.message).toMatch(/キルスイッチ/);
    expect(new RiskManager(config.risk, store).state().killSwitch).toBeUndefined();
    const audit = store.listAudit({ type: "risk.resume" });
    expect(audit).toHaveLength(1);
    expect(audit[0].data.by).toBe("cli");
    // 実行中のエンジンへ伝えるための再開要求が kv に残る
    expect(store.kvGet(RESUME_REQUEST_KEY)).toEqual({ at: 2000, by: "cli", mode: "paper" });
  });

  it("resume: 停止状態でなければ再開要求を書かない", () => {
    const store = new MemoryStore();
    const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" });
    expect(resumeTrading(config, store, 2000).resumed).toBe(false);
    expect(store.kvGet(RESUME_REQUEST_KEY)).toBeUndefined();
  });

  it("戦略別の成績は決済時点の為替で換算する (記録が無ければ現在のレート)", () => {
    const store = new MemoryStore();
    const t = (id: string, netPnl: number) =>
      ({ id, strategyId: "s", symbol: "BTC/USDT", netPnl, fees: 1, rMultiple: 1 }) as unknown as import("../src/core/types").TradeRecord;
    store.audit({ ts: 1, type: "engine.exit", data: { tradeId: "a", fxRate: 100 } });
    const rates = exitFxRates(store);
    expect(rates.get("a")).toBe(100);
    const [s] = summarizeByStrategy([t("a", 10), t("b", 10)], () => 150, undefined, rates);
    expect(s.netPnl).toBe(10 * 100 + 10 * 150);
    expect(s.fees).toBe(100 + 150);
  });

  it("表の整形は全角幅をそろえる", () => {
    expect(strWidth("勝率a")).toBe(5);
    const t = formatTable(["戦略", "件数"], [["abc", 1], ["日本", 20]]);
    const lines = t.split("\n");
    expect(lines[0]).toBe("戦略  件数");
    expect(lines[2]).toBe("abc      1");
    expect(lines[3]).toBe("日本    20");
  });
});

describe("orders (保留中の注文の一覧・手動での解消)", () => {
  const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }); // mode は paper
  const order = (o: Partial<PendingOrder> = {}): PendingOrder => ({
    clientId: "eng-x-1-1-abcd", orderId: "ord-9", symbol: "BTC/USDT", side: "sell", qty: "0.5", kind: "exit", createdAt: Date.UTC(2026, 0, 5),
    status: "unknown", unknownCount: 5, lastError: "照会に失敗: ETIMEDOUT", escalated: true,
    exit: { tradeId: "t1", reason: "stop", intendedPrice: 100 },
    ...o,
  });

  it("HELP に orders / orders resolve の使い方がある", () => {
    expect(HELP).toContain("orders resolve <clientId> --none");
    expect(HELP).toContain("orders resolve <clientId> --filled --qty <数量> --price <価格>");
  });

  it("引数の解析: --none か --filled (--qty・--price 必須) のどちらか一方", () => {
    const p = (argv: string[]) => {
      const a = parseArgs(["orders", "resolve", ...argv]);
      return parseResolveArgs(a.positionals.slice(1), a.flags);
    };
    expect(p(["c1", "--none"])).toEqual({ clientId: "c1", outcome: "none" });
    expect(p(["--none", "c1"])).toEqual({ clientId: "c1", outcome: "none" });
    expect(p(["c1", "--filled", "--qty", "0.25", "--price", "101.5"])).toEqual({ clientId: "c1", outcome: "filled", qty: "0.25", price: 101.5 });
    expect(() => p(["--none"])).toThrow(/clientId/);
    expect(() => p(["c1"])).toThrow(/--none/);
    expect(() => p(["c1", "--none", "--filled"])).toThrow(/どちらか一方/);
    expect(() => p(["c1", "--filled", "--price", "1"])).toThrow(/--qty/);
    expect(() => p(["c1", "--filled", "--qty", "1"])).toThrow(/--price/);
    expect(() => p(["c1", "--filled", "--qty", "-1", "--price", "1"])).toThrow(/正の数値/);
    expect(() => p(["c1", "--filled", "--qty", "1", "--price", "0"])).toThrow(/正の数値/);
    expect(() => p(["c1", "--none", "--qty", "1"])).toThrow(/--none には/);
  });

  it("main: 引数の誤りは終了コード 2 (DB を開く前に検証する)", async () => {
    const a = io();
    expect(await main(["orders", "resolve", "c1"], a.io)).toBe(2);
    expect(a.err[0]).toMatch(/^エラー: --none/);
    const b = io();
    expect(await main(["orders", "cancel"], b.io)).toBe(2);
    expect(b.err[0]).toMatch(/未知のサブコマンド/);
  });

  it("一覧は状態不明の注文に印を付け、解消の方法を案内する", () => {
    const store = new MemoryStore();
    expect(pendingOrdersText(config, store)).toMatch(/保留中の注文はありません \(paper\)/);
    new PendingOrders({ store, mode: "paper" }).upsert(order());
    const text = pendingOrdersText(config, store);
    expect(text).toContain("[状態不明] BTC/USDT 決済 sell 0.5 clientId=eng-x-1-1-abcd orderId=ord-9");
    expect(text).toContain("orders resolve <clientId> --none");
    expect(text).toContain("--filled --qty <数量> --price <価格>");
  });

  it("resolve: 要求を kv の要求キュー (mode 別) に積み、監査ログを残す。存在しない clientId・注文数量を超える --qty は拒否する", () => {
    const store = new MemoryStore();
    new PendingOrders({ store, mode: "paper" }).upsert(order());
    expect(() => requestOrderResolve(config, store, { clientId: "nope", outcome: "none" })).toThrow(CliError);
    expect(() => requestOrderResolve(config, store, { clientId: "eng-x-1-1-abcd", outcome: "filled", qty: "0.6", price: 100 })).toThrow(/超えています/);
    const r1 = requestOrderResolve(config, store, { clientId: "eng-x-1-1-abcd", outcome: "filled", qty: "0.5", price: 99.5 }, 1_000, "cli");
    expect(r1.message).toMatch(/次のティック/);
    const r2 = requestOrderResolve(config, store, { clientId: "eng-x-1-1-abcd", outcome: "none" }, 2_000, "cli");
    expect(r2.request.id).not.toBe(r1.request.id);
    expect(peekResolveRequests(store, "paper").map((r) => [r.outcome, r.qty, r.price])).toEqual([["filled", "0.5", 99.5], ["none", undefined, undefined]]);
    expect(peekResolveRequests(store, "live")).toEqual([]);
    expect(store.listAudit({ type: "order.manual_resolve_requested" })).toHaveLength(2);
    expect(pendingOrdersText(config, store)).toContain("適用待ちの解消要求: 2 件");
  });

  it("resume: 状態不明の保留注文が残っていれば、一覧と orders resolve の案内を警告として返す (解除自体は行う)", () => {
    const store = new MemoryStore();
    new RiskManager(config.risk, store).trip("テスト", 1_000);
    new PendingOrders({ store, mode: "paper" }).upsert(order());
    const r = resumeTrading(config, store, 2_000);
    expect(r.resumed).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/状態不明の注文が 1 件/);
    expect(r.warnings.join("\n")).toContain("clientId=eng-x-1-1-abcd");
    expect(r.warnings.join("\n")).toContain("orders resolve <clientId> --none");
    // 停止していなくても警告は返す
    const r2 = resumeTrading(config, store, 3_000);
    expect(r2.resumed).toBe(false);
    expect(r2.warnings.length).toBeGreaterThan(0);
  });
});

describe("CLI: 誤用防止 (数値・位置引数・--force)", () => {
  const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }); // paper
  const p = (argv: string[]) => {
    const a = parseArgs(["orders", "resolve", ...argv]);
    return parseResolveArgs(a.positionals.slice(1), a.flags);
  };

  it("数値は 10 進のみ: --seed= (空) / 16 進 / 指数 / 空白は拒否する", () => {
    expect(() => parseSimulateArgs(parseArgs(["simulate", "--seed="]).flags)).toThrow(/--seed に値を指定/);
    expect(() => parseSimulateArgs(parseArgs(["simulate", "--seed=0x10"]).flags)).toThrow(/10 進/);
    expect(() => parseSimulateArgs(parseArgs(["simulate", "--days", "1e1"]).flags)).toThrow(/10 進/);
    expect(() => numberFlag({ x: " 1" }, "x", 0)).toThrow(/10 進/);
    expect(parseSimulateArgs(parseArgs(["simulate", "--seed=-3", "--days", "0.5"]).flags)).toMatchObject({ seed: -3, days: 0.5 });
  });

  it("orders resolve: --qty / --price は 10 進の正の有限数だけ。0x10 を 16 として受け付けない", () => {
    expect(() => p(["c1", "--filled", "--qty", "0x10", "--price", "1"])).toThrow(/10 進/);
    expect(() => p(["c1", "--filled", "--qty", "1e3", "--price", "1"])).toThrow(/10 進/);
    expect(() => p(["c1", "--filled", "--qty", "Infinity", "--price", "1"])).toThrow(/10 進/);
    expect(() => p(["c1", "--filled", "--qty", "1", "--price", "0x10"])).toThrow(/10 進/);
    expect(() => p(["c1", "--filled", "--qty", "0", "--price", "1"])).toThrow(/正の数値/);
    expect(() => p(["c1", "--filled", "--qty=", "--price", "1"])).toThrow(/--qty/);
    expect(p(["c1", "--filled", "--qty", ".5", "--price", "101.25"])).toEqual({ clientId: "c1", outcome: "filled", qty: "0.5", price: 101.25 });
  });

  it("余分な位置引数・矛盾する clientId・未知のオプションはエラー。--force を解析する", async () => {
    expect(() => p(["c1", "c2", "--none"])).toThrow(/余分な引数/);
    expect(() => p(["c1", "--none", "c2"])).toThrow(/複数/);
    expect(() => p(["c1", "--none", "--qtty", "1"])).toThrow(/未知のオプション/);
    expect(p(["c1", "--none", "--force"])).toEqual({ clientId: "c1", outcome: "none", force: true });
    expect(p(["--force", "c1", "--none"])).toEqual({ clientId: "c1", outcome: "none", force: true });
    const a = io();
    expect(await main(["status", "extra"], a.io)).toBe(2);
    expect(a.err[0]).toMatch(/余分な引数/);
    const b = io();
    expect(await main(["orders", "list", "x"], b.io)).toBe(2);
    expect(b.err[0]).toMatch(/余分な引数/);
  });

  it("状態不明 (escalated) でない注文の resolve は --force が必要", () => {
    const store = new MemoryStore();
    new PendingOrders({ store, mode: "paper" }).upsert({
      clientId: "c-open", orderId: "o1", symbol: "BTC/USDT", side: "buy", qty: "1", kind: "entry", createdAt: 1, status: "open", unknownCount: 0,
    });
    expect(() => requestOrderResolve(config, store, { clientId: "c-open", outcome: "none" })).toThrow(/--force/);
    expect(peekResolveRequests(store, "paper")).toEqual([]);
    const r = requestOrderResolve(config, store, { clientId: "c-open", outcome: "none", force: true }, 1_000, "cli");
    expect(r.request.force).toBe(true);
    expect(store.listAudit({ type: "order.manual_resolve_requested" })[0].data).toMatchObject({ escalated: false, force: true });
  });
});

describe("CLI: エンジンの二重起動防止ロック", () => {
  it("同じ mode のロックが新しければ起動しない。古ければ奪取してログに残す。mode が違えば影響しない", () => {
    const store = new MemoryStore();
    const now = 1_000_000;
    const a = io();
    const owner = acquireRunLock(store, "live", a.io, now);
    expect(owner).toBeDefined();
    expect(store.kvGet(engineLockKey("live"))).toMatchObject({ pid: process.pid, startedAt: now, heartbeatAt: now });
    // 30 秒後に別のプロセスが起動 → 拒否 (保持者を「同じホストで生きている別プロセス」(親プロセス) にする)
    store.kvSet(engineLockKey("live"), { ...store.kvGet<object>(engineLockKey("live")), pid: process.ppid });
    const b = io();
    expect(acquireRunLock(store, "live", b.io, now + 30_000)).toBeUndefined();
    expect(b.err[0]).toMatch(/同じ mode \(live\) のエンジンが動いています \(pid \d+/);
    // paper は別のロック
    expect(acquireRunLock(store, "paper", io().io, now + 30_000)).toBeDefined();
    // heartbeat が 60 秒より古ければ奪取する
    const c = io();
    expect(acquireRunLock(store, "live", c.io, now + 61_000)).toBeDefined();
    expect(c.err[0]).toMatch(/古いエンジンのロックを引き継ぎました/);
    expect(store.listAudit({ type: "engine.lock_stolen" })).toHaveLength(1);
  });
});

describe("CLI: report は学習状態を取引 mode で読み、DB へ書き込まない", () => {
  it("移行のフラグ・監査ログを DB に書かない", () => {
    const store = new MemoryStore();
    store.kvSet("learning:lastTune", 123); // 旧キー (移行前)
    const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory" });
    const text = buildReportText(config, store, Date.UTC(2026, 0, 6));
    expect(text).toContain("学習状態: paper");
    expect(store.kvGet(learningMigrationFlagKey("paper"))).toBeUndefined();
    expect(store.kvKeys("learning:")).toEqual(["learning:lastTune"]); // 新キーへのコピーも書かない
    expect(store.listAudit()).toEqual([]);
    const live = buildReportText({ ...config, mode: "live" }, store, Date.UTC(2026, 0, 6));
    expect(live).toContain("学習状態: live");
    expect(store.kvGet(learningMigrationFlagKey("live"))).toBeUndefined();
  });
});
