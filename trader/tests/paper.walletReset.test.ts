import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, buildReportText, main, paperResetCommand, parsePaperResetArgs, prepareRunRuntime, settledTradesLine, CliError } from "../src/cli";
import type { Runtime } from "../src/engine/setup";
import { loadConfig } from "../src/core/config";
import type { EntryContext, Instrument, Store, TradeRecord } from "../src/core/types";
import { tradesPayload } from "../src/dashboard/server";
import { EXIT_REASON_LABEL, exitReasonLabel } from "../src/engine/report";
import { acquireEngineLock, engineLockKey, type EngineLock } from "../src/engine/lock";
import { pendingOrdersKey, resolveRequestsKey, restingTpKey } from "../src/engine/orders";
import { PAPER_SNAPSHOT_KEY } from "../src/engine/engine";
import { PaperBroker, type PaperSnapshot } from "../src/execution/paper";
import { fillPostExitMoves, openKvKey, TradeJournal, type OpenTradeInput } from "../src/learning/journal";
import { computeReflectionStats } from "../src/learning/reflection";
import { LearningService } from "../src/learning/service";
import { learnableTrades } from "../src/learning/tuner";
import { riskStateKey, RiskManager } from "../src/risk/manager";
import { riskLimitsKey } from "../src/risk/settings";
import { runSimulation } from "../src/engine/simulate";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import {
  executeWalletReset, freshPaperSnapshot, latestPaperReset, PAPER_EXIT_PLANS_KEY, PAPER_RESETS_KEY, PAPER_SNAPSHOT_KV_KEY, paperEngineRunning,
  performanceTrades, planWalletReset, readPaperResets, validateResetEquity, WALLET_RESET_KEYS, WalletResetError,
} from "../src/paper/walletReset";

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const DAY = 86_400_000;

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 15, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7,
  expectedEdgeBps: 40,
  costBps: 10,
  params: { stopAtr: 1.5 },
  features: {},
  riskMultiplier: 1,
  reason: "test",
};

const openInput = (over: Partial<OpenTradeInput> = {}): OpenTradeInput => ({
  mode: "paper", symbol: "BTC/JPY", venue: "paper", assetClass: "crypto", strategyId: "scalp_micro", horizon: "scalp", direction: "long",
  qty: 0.01, entryTs: NOW - 3_600_000, entryPrice: 10_000_000, intendedEntryPrice: 10_000_000, initialStop: 9_900_000, takeProfit: 10_200_000,
  entryContext: ctx, entryFees: 10, ...over,
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

const paperConfig = (over: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", DB_PATH: "memory", BASE_CURRENCY: "JPY", ...over });

/** 保有 2 件・決済計画・保留注文・利確の指値・キルスイッチ・リスク設定の上書きのある paper の DB */
function seededStore(store: Store = new MemoryStore()): { store: Store; ids: string[] } {
  const j = new TradeJournal({ store, mode: "paper" });
  const a = j.open(openInput());
  j.mark("BTC/JPY", 10_050_000, NOW - 1_800_000);
  const b = j.open(openInput({ symbol: "ETH/JPY", direction: "short", qty: 0.5, entryPrice: 500_000, intendedEntryPrice: 500_000, initialStop: 510_000, takeProfit: 480_000 }));
  // BTC は気配がある (建玉の最後の価格より新しい)、ETH は気配が無い (最後の価格 = 建値)
  const snap: PaperSnapshot = {
    version: 1, cash: "800000", realizedPnl: "-12345", seq: 42,
    positions: [{ symbol: "BTC/JPY", qty: "0.01", avg: "10000000", openedAt: 1 }, { symbol: "ETH/JPY", qty: "-0.5", avg: "500000", openedAt: 1 }, { symbol: "XRP/JPY", qty: "100", avg: "80", openedAt: 1 }],
    resting: [{ orderId: "o1", req: { clientId: "c1", symbol: "BTC/JPY", side: "sell", qty: "0.01", type: "limit", strategyId: "s" } as never, qty: "0.01", limitPrice: "10200000", createdAt: 1 }],
    results: { c0: { orderId: "o0", clientId: "c0", status: "filled", fills: [] } as never },
    quotes: { "BTC/JPY": { ts: NOW - 60_000, bid: 10_090_000, ask: 10_110_000 } },
    fxRates: { USD: "150" },
  };
  store.kvSet(PAPER_SNAPSHOT_KEY, snap);
  store.kvSet(PAPER_EXIT_PLANS_KEY, { [a.id]: { maxHoldMs: 600_000 }, [b.id]: { maxHoldMs: 600_000 } });
  store.kvSet(pendingOrdersKey("paper"), [{ clientId: "p1", symbol: "SOL/JPY", kind: "entry", side: "buy", qty: "1", status: "open", createdAt: 1 }]);
  store.kvSet(restingTpKey("paper"), [{ clientId: "tp1", tradeId: a.id, symbol: "BTC/JPY" }]);
  store.kvSet(resolveRequestsKey("paper"), [{ id: "r1", clientId: "p1", outcome: "none", at: 1, by: "cli" }]);
  store.saveEquity({ ts: NOW - 60_000, equity: 812_345, mode: "paper" });
  const config = paperConfig();
  const risk = new RiskManager(config.risk, store, { mode: "paper" });
  risk.onEquity(1_000_000, NOW - 2 * DAY);
  risk.trip("テストの最大DD", NOW - DAY);
  store.kvSet(riskLimitsKey("paper"), { values: { riskPerTrade: 0.002 }, updatedAt: 1 });
  // 学習データ (変わらないことを確かめる)
  store.kvSet("arms:paper", { "scalp_micro|range|crypto": { n: 12 } });
  store.kvSet("shadow:open:paper", [{ id: "sh1" }]);
  store.kvSet("forecast:model:paper", { w: [1, 2, 3] });
  store.kvSet("orders:limitStats:paper", { since: 1, placed: 10, filled: 4 });
  store.kvSet("engine:lock:live", { pid: 1, hostname: "h", startedAt: NOW, heartbeatAt: NOW });
  return { store, ids: [a.id, b.id] };
}

const kvDump = (store: Store) => Object.fromEntries(store.kvKeys("").map((k) => [k, JSON.stringify(store.kvGet(k))]));

describe("paper reset: 引数と拒否", () => {
  it("引数の解析と金額の検証", () => {
    expect(parsePaperResetArgs(["reset"], { equity: "100000" })).toEqual({ equity: 100_000, confirm: false });
    expect(parsePaperResetArgs(["reset"], { equity: "100000", confirm: true })).toEqual({ equity: 100_000, confirm: true });
    expect(() => parsePaperResetArgs(["reset"], {})).toThrow(/--equity/);
    expect(() => parsePaperResetArgs(["reset"], { equity: true })).toThrow(/--equity/);
    expect(() => parsePaperResetArgs(["reset"], { equity: "0" })).toThrow(CliError);
    expect(() => parsePaperResetArgs(["reset"], { equity: "-5" })).toThrow(/正の数値/);
    expect(() => parsePaperResetArgs(["reset"], { equity: "abc" })).toThrow(/正の数値/);
    expect(() => parsePaperResetArgs(["reset"], { equity: "1e5" })).toThrow(/正の数値/);
    expect(() => parsePaperResetArgs(["reset"], { equity: "100000", confirm: "yes" })).toThrow(/--confirm/);
    expect(() => parsePaperResetArgs(["reset"], { equity: "100000", force: true })).toThrow(/未知のオプション/);
    expect(() => parsePaperResetArgs([], { equity: "100000" })).toThrow(/使い方/);
    expect(() => parsePaperResetArgs(["wipe"], { equity: "100000" })).toThrow(/使い方/);
    expect(validateResetEquity("100_000")).toBe(100_000);
    expect(() => validateResetEquity(Number.NaN)).toThrow(WalletResetError);
  });

  it("main: paper reset の引数エラーは終了コード 2", async () => {
    const a = io();
    expect(await main(["paper", "reset"], a.io)).toBe(2);
    expect(a.err.join("\n")).toMatch(/--equity/);
  });

  it("TRADING_MODE=live では拒否し、何も書かない (確認語なし・ありの両方)", () => {
    for (const over of [{ TRADING_MODE: "live" }, { TRADING_MODE: "live", LIVE_TRADING_CONFIRM: "I_UNDERSTAND_REAL_MONEY_RISK" }] as Record<string, string>[]) {
      const { store } = seededStore();
      const before = kvDump(store);
      const a = io();
      let config;
      try {
        config = paperConfig(over);
      } catch {
        // live の確認語つきは NODE_ENV=test で設定エラーになる場合がある: mode だけ live にして確かめる
        config = { ...paperConfig(), mode: "live" as const };
      }
      expect(paperResetCommand(config, store, { equity: 100_000, confirm: true }, a.io, NOW)).toBe(2);
      expect(a.err.join("\n")).toMatch(/paper 専用/);
      expect(kvDump(store)).toEqual(before);
      expect(store.listAudit({ type: "paper.wallet_reset" })).toHaveLength(0);
    }
  });

  it("paper のエンジンが動作中 (heartbeat が新しい) なら拒否し、systemctl stop を案内する", () => {
    const { store } = seededStore();
    store.kvSet(engineLockKey("paper"), { pid: 999_999, hostname: "srv", startedAt: NOW - 60_000, heartbeatAt: NOW - 10_000 });
    const before = kvDump(store);
    const a = io();
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: true }, a.io, NOW)).toBe(1);
    expect(a.err.join("\n")).toMatch(/sudo systemctl stop trader/);
    // dry run も拒否
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: false }, io().io, NOW)).toBe(1);
    expect(kvDump(store)).toEqual(before);
    expect(() => executeWalletReset(store, { equity: 100_000, now: NOW })).toThrow(/動いています.*sudo systemctl stop trader/);
    expect(kvDump(store)).toEqual(before);
    // heartbeat が古い (停止済み) なら実行できる。live のロックは関係ない
    expect(paperEngineRunning(store, NOW + 120_000).running).toBe(false);
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: true }, io().io, NOW + 120_000)).toBe(0);
  });
});

describe("paper reset: dry run と実行", () => {
  it("--confirm なしは計画を表示するだけで何も書かない", () => {
    const { store } = seededStore();
    const before = kvDump(store);
    const trades = store.listTrades().length;
    const a = io();
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: false }, a.io, NOW)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("確認のみ");
    expect(text).toContain("現在の評価額 (paper): 812,345 円");
    expect(text).toContain("新しい評価額: 100,000 円");
    expect(text).toContain("記帳上だけ閉じる建玉: 2 件");
    expect(text).toMatch(/BTC\/JPY 買い 0\.01 建値 10000000 → 10100000 \(最後の気配の仲値\)/);
    expect(text).toMatch(/ETH\/JPY 売り 0\.5 建値 500000 → 500000 \(建玉の最後の価格\)/);
    expect(text).toContain("追跡外のペーパー口座の建玉 (消えます): XRP/JPY 100");
    expect(text).toContain("保留中の注文 1 件");
    expect(text).toContain("キルスイッチ (テストの最大DD)");
    expect(text).toContain("paper:snapshot");
    expect(text).toContain("--confirm");
    expect(kvDump(store)).toEqual(before);
    expect(store.listTrades()).toHaveLength(trades);
    expect(store.listAudit({ type: "paper.wallet_reset" })).toHaveLength(0);
  });

  it.each([
    ["memory", () => new MemoryStore()],
    ["sqlite", () => new SqliteStore(":memory:")],
  ] as const)("実行 (%s): 建玉を wallet_reset で閉じ、paper の口座のキーだけを書き換える (学習のキーは変えない)", (_name, mk) => {
    const { store, ids } = seededStore(mk());
    const before = kvDump(store);
    const a = io();
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: true }, a.io, NOW)).toBe(0);
    expect(a.out.join("\n")).toContain("リセットしました");

    // kv の差分は WALLET_RESET_KEYS だけ
    const after = kvDump(store);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
    expect(changed.every((k) => WALLET_RESET_KEYS.includes(k))).toBe(true);
    expect(changed).toEqual(
      [openKvKey("paper"), PAPER_EXIT_PLANS_KEY, pendingOrdersKey("paper"), restingTpKey("paper"), resolveRequestsKey("paper"), PAPER_SNAPSHOT_KV_KEY, riskStateKey("paper"), PAPER_RESETS_KEY].sort(),
    );
    for (const k of ["arms:paper", "shadow:open:paper", "forecast:model:paper", "orders:limitStats:paper", riskLimitsKey("paper"), "engine:lock:live"]) expect(after[k]).toBe(before[k]);

    // 建玉は記帳上だけ閉じる (学習から除外の印)
    const closed = store.listTrades({ mode: "paper" });
    expect(closed.map((t) => t.id).sort()).toEqual([...ids].sort());
    for (const t of closed) {
      expect(t.exitReason).toBe("wallet_reset");
      expect(t.learningExcluded).toBe(true);
      expect(t.exitTs).toBe(NOW);
    }
    const btc = closed.find((t) => t.symbol === "BTC/JPY")!;
    expect(btc.exitPrice).toBe(10_100_000);
    expect(btc.fees).toBe(10); // エントリー手数料のみ
    expect(closed.find((t) => t.symbol === "ETH/JPY")!.exitPrice).toBe(500_000);
    expect(new TradeJournal({ store, mode: "paper" }).list()).toEqual([]);
    expect(store.getAttribution(btc.id)).toBeUndefined();

    // 空になった口座の状態
    expect(store.kvGet(PAPER_EXIT_PLANS_KEY)).toEqual({});
    expect(store.kvGet(pendingOrdersKey("paper"))).toEqual([]);
    expect(store.kvGet(restingTpKey("paper"))).toEqual([]);
    expect(store.kvGet(resolveRequestsKey("paper"))).toBeUndefined();

    // スナップショットは PaperBroker が読める形で、評価額 = 新しい評価額
    const snap = store.kvGet<PaperSnapshot>(PAPER_SNAPSHOT_KEY)!;
    expect(snap).toMatchObject({ version: 1, cash: "100000", realizedPnl: "0", seq: 42, positions: [], resting: [], results: {}, fxRates: { USD: "150" } });
    const inst: Instrument = { symbol: "BTC/JPY", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY", tickSize: 1, lotSize: 0.0001, minQty: 0.0001, takerFeeRate: 0, makerFeeRate: 0, allowShort: false };
    const broker = new PaperBroker({ instruments: [inst], baseCurrency: "JPY", initialEquity: 1_000_000 });
    broker.restore(snap);
    expect(broker.markToMarket()).toMatchObject({ equity: 100_000, cash: 100_000, unrealized: 0, realized: 0 });

    // リスク状態は新しい評価額で初期化 (停止なし)、上書きのリスク上限は残る
    const risk = new RiskManager(paperConfig().risk, store, { mode: "paper" });
    expect(risk.state()).toMatchObject({ dayStartEquity: 100_000, peakEquity: 100_000, recentOrderTs: [] });
    expect(risk.state().killSwitch).toBeUndefined();
    expect(risk.state().haltedUntil).toBeUndefined();
    expect(risk.isHalted(NOW).halted).toBe(false);
    expect(risk.onEquity(100_000, NOW + 1000)).toMatchObject({ halted: false, killSwitch: false, drawdownPct: 0 });
    expect(risk.limits.riskPerTrade).toBe(0.002);

    // 履歴・監査ログ・評価額
    expect(readPaperResets(store)).toEqual([{ at: NOW, fromEquity: 812_345, toEquity: 100_000, closedCount: 2, by: "cli" }]);
    const audit = store.listAudit({ type: "paper.wallet_reset" });
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ mode: "paper", fromEquity: 812_345, toEquity: 100_000, closedCount: 2 });
    expect(store.listEquity({ mode: "paper" }).at(-1)).toEqual({ ts: NOW, equity: 100_000, mode: "paper" });
  });

  it("2 回目のリセットは履歴に追記し、建玉が無くても実行できる", () => {
    const { store } = seededStore();
    executeWalletReset(store, { equity: 100_000, now: NOW });
    const r = executeWalletReset(store, { equity: 200_000, now: NOW + DAY, by: "test" });
    expect(r.closed).toHaveLength(0);
    expect(readPaperResets(store).map((x) => x.toEquity)).toEqual([100_000, 200_000]);
    expect(latestPaperReset(store)).toMatchObject({ at: NOW + DAY, fromEquity: 100_000, toEquity: 200_000, closedCount: 0, by: "test" });
    expect(planWalletReset(store, { equity: 1, now: NOW + 2 * DAY }).previousResets).toBe(2);
  });

  it("途中で例外ならトランザクションで何も書かない (SQLite)", () => {
    const { store } = seededStore(new SqliteStore(":memory:"));
    const before = kvDump(store);
    const orig = store.saveEquity.bind(store);
    store.saveEquity = () => {
      throw new Error("disk full");
    };
    expect(() => executeWalletReset(store, { equity: 100_000, now: NOW })).toThrow(/disk full/);
    store.saveEquity = orig;
    expect(kvDump(store)).toEqual(before);
    expect(store.listTrades()).toHaveLength(0);
  });

  it("freshPaperSnapshot は前のスナップショットが無くても読める形", () => {
    const s = freshPaperSnapshot(100_000);
    expect(s).toEqual({ version: 1, cash: "100000", realizedPnl: "0", seq: 0, positions: [], resting: [], results: {}, quotes: {}, instruments: [], fxRates: {} });
  });

  it("実際のシミュレーションの DB でも学習のキーは変わらない", async () => {
    const store = new MemoryStore();
    await runSimulation({ hours: 1, stepMs: 30_000, seed: 3, store });
    const now = (store.listEquity({ mode: "paper" }).at(-1)?.ts ?? NOW) + 1000;
    const j = new TradeJournal({ store, mode: "paper" });
    j.open(openInput({ entryTs: now - 60_000 }));
    const before = kvDump(store);
    const tradesBefore = store.listTrades().length;
    const attsBefore = store.listAttributions().length;
    const r = executeWalletReset(store, { equity: 100_000, now });
    expect(r.closed.length).toBeGreaterThanOrEqual(1);
    const after = kvDump(store);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
    expect(changed.filter((k) => !WALLET_RESET_KEYS.includes(k))).toEqual([]);
    expect(Object.keys(before).filter((k) => !WALLET_RESET_KEYS.includes(k)).length).toBeGreaterThan(3);
    expect(store.listTrades().length).toBe(tradesBefore + r.closed.length);
    expect(store.listAttributions().length).toBe(attsBefore);
  }, 60_000);
});

// ───────── 学習・成績の集計から除外する ─────────

const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  id: `t-${Math.random()}`, mode: "paper", symbol: "BTC/JPY", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction: "long",
  qty: 1, entryTs: NOW - DAY, entryPrice: 100, intendedEntryPrice: 100, exitTs: NOW - DAY + 60_000, exitPrice: 99, intendedExitPrice: 99, initialStop: 99,
  grossPnl: -1, fees: 0, netPnl: -1, returnPct: -0.01, rMultiple: -1, mfePct: 0, maePct: 0.01, exitReason: "stop", entryContext: ctx, ...over,
});
const resetTrade = (over: Partial<TradeRecord> = {}) => trade({ exitReason: "wallet_reset", learningExcluded: true, netPnl: -50_000, rMultiple: -20, ...over });

describe("paper reset: 学習の各部品は wallet_reset の取引を使わない", () => {
  it("ParamTuner の learnableTrades", () => {
    const ok = trade();
    expect(learnableTrades([ok, resetTrade(), trade({ exitReason: "wallet_reset" }), trade({ learningExcluded: true })])).toEqual([ok]);
  });

  it("振り返りの集計 (computeReflectionStats)", () => {
    const store = new MemoryStore();
    store.saveTrade(trade());
    store.saveTrade(resetTrade());
    expect(computeReflectionStats({ store, now: NOW, windowMs: 30 * DAY, mode: "paper" }).total.n).toBe(1);
  });

  it("LearningService.onTradeClosed: 腕・要因分析・情報源の信頼度を更新しない", () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store, mode: "paper" });
    const t = resetTrade({ entryContext: { ...ctx, intel: { asset: "BTC", sentiment: 0.5, confidence: 0.8, eventRisk: 0, sourceIds: ["x"], sourceContrib: { rss: 0.5 } } as never } });
    const before = kvDump(store);
    svc.onTradeClosed(t);
    expect(store.getAttribution(t.id)).toBeUndefined();
    expect(kvDump(store)).toEqual(before);
    expect(svc.snapshot({ now: NOW }).arms).toEqual([]);
    // 通常の取引は腕を更新する (比較)
    svc.onTradeClosed(trade());
    expect(svc.snapshot({ now: NOW }).arms.length).toBe(1);
  });

  it("エグジット後の値動きの補完 (要因分析の再計算・信頼度の補正の元) から除く", () => {
    const store = new MemoryStore();
    const ok = trade();
    const ex = resetTrade();
    store.saveTrade(ok);
    store.saveTrade(ex);
    const filled = fillPostExitMoves(store, () => 101, undefined, { now: NOW });
    expect(filled.map((t) => t.id)).toEqual([ok.id]);
  });

  it("performanceTrades: 除外の取引を除き、paper はリセット以降だけ (live はそのまま)", () => {
    const old = trade({ exitTs: NOW - DAY });
    const ex = resetTrade({ exitTs: NOW });
    const after = trade({ exitTs: NOW + 1000 });
    const live = trade({ mode: "live", exitTs: NOW - DAY });
    const all = [old, ex, after, live];
    expect(performanceTrades(all, { at: NOW })).toEqual([after, live]);
    expect(performanceTrades(all, { at: NOW }, { allTime: true })).toEqual([old, after, live]);
    expect(performanceTrades(all, undefined)).toEqual([old, after, live]);
  });

  it("表示名は「リセットで決済」", () => {
    expect(EXIT_REASON_LABEL.wallet_reset).toBe("リセットで決済");
    expect(exitReasonLabel("wallet_reset", "long")).toBe("リセットで決済");
  });
});

describe("paper reset: report とダッシュボードはリセット以降の成績", () => {
  function storeWithReset() {
    const store = new MemoryStore();
    store.saveEquity({ ts: NOW - 2 * DAY, equity: 1_000_000, mode: "paper" });
    store.saveEquity({ ts: NOW - DAY, equity: 600_000, mode: "paper" });
    store.saveTrade(trade({ id: "old", netPnl: -400_000, exitTs: NOW - DAY }));
    // 前回のリセットで決済した取引 (最新のリセットより前: 既定の期間の除外件数には数えない)
    store.saveTrade(resetTrade({ id: "rst0", exitTs: NOW - 2 * DAY }));
    store.kvSet(PAPER_RESETS_KEY, [{ at: NOW, fromEquity: 600_000, toEquity: 100_000, closedCount: 1 }]);
    store.saveTrade(resetTrade({ id: "rst", exitTs: NOW }));
    store.saveEquity({ ts: NOW, equity: 100_000, mode: "paper" });
    store.saveTrade(trade({ id: "new", netPnl: 2_000, rMultiple: 1, exitReason: "take_profit", exitTs: NOW + 60_000 }));
    store.saveEquity({ ts: NOW + 60_000, equity: 102_000, mode: "paper" });
    return store;
  }

  it("report: 既定はリセット以降、--all で全期間。リセットで決済は集計から除外", () => {
    const store = storeWithReset();
    const config = paperConfig();
    const text = buildReportText(config, store, NOW + DAY);
    expect(text).toContain("最新の口座リセット");
    expect(text).toMatch(/評価額 \(paper\): 100,000 → 102,000/);
    expect(text).toContain("取引数: 1 (勝率 100.0%)");
    expect(text).toContain("リセットで決済: 1 件 (成績・学習の集計から除外)");
    expect(text).not.toMatch(/決済理由:.*リセットで決済/);
    const all = buildReportText(config, store, NOW + DAY, { allTime: true });
    expect(all).toMatch(/評価額 \(paper\): 1,000,000 → 102,000/);
    expect(all).toContain("取引数: 2 (勝率 50.0%)");
  });

  it("ダッシュボードの /api/trades: 集計はリセット以降・除外の取引なし、scope=all で全期間", () => {
    const store = storeWithReset();
    const deps = { store, status: () => ({ mode: "paper" }), learning: { snapshot: () => ({}) as never } };
    const p = tradesPayload(deps, 50, "paper");
    expect(p.scope).toBe("since_reset");
    expect(p.walletReset).toEqual({ at: NOW, toEquity: 100_000, fromEquity: 600_000 });
    expect(p.totalTrades).toBe(1);
    expect(p.trades.map((t) => t.id)).toEqual(["new"]);
    expect(p.byStrategy.reduce((s, x) => s + x.trades, 0)).toBe(1);
    expect(p.excludedTrades).toBe(1);
    const all = tradesPayload(deps, 50, "paper", { allTime: true });
    expect(all.scope).toBe("all");
    expect(all.totalTrades).toBe(2);
    expect(all.excludedTrades).toBe(2);
    expect(all.trades.map((t) => t.id)).toEqual(["new", "rst", "old", "rst0"]);
    expect(all.trades.find((t) => t.id === "rst")?.learningExcluded).toBe(true);
    expect(all.byStrategy.reduce((s, x) => s + x.trades, 0)).toBe(2);
    // live にはリセットの情報を付けない
    expect(tradesPayload(deps, 50, "live").walletReset).toBeUndefined();
  });
});

describe("paper reset: エンジンのロック (起動中のエンジンとの競合)", () => {
  it("リセットの間は engine:lock:paper を持ち、終わったら (例外でも) 返す", () => {
    const { store } = seededStore(new SqliteStore(":memory:"));
    const seen: (EngineLock | undefined)[] = [];
    const starts: boolean[] = [];
    const orig = store.saveEquity.bind(store);
    store.saveEquity = (p) => {
      seen.push(store.kvGet<EngineLock>(engineLockKey("paper")));
      // この間に起動したエンジンはロックを取れない (pid が生きている別プロセスとして)
      starts.push(acquireRunLock(store, "paper", io().io, NOW + 1000) !== undefined);
      orig(p);
    };
    executeWalletReset(store, { equity: 100_000, now: NOW, pid: 4242, hostname: "cli-host" });
    expect(seen[0]).toMatchObject({ pid: 4242, hostname: "cli-host", heartbeatAt: NOW });
    expect(starts).toEqual([false]);
    expect(store.kvGet(engineLockKey("paper"))).toBeUndefined();

    store.saveEquity = () => {
      throw new Error("boom");
    };
    expect(() => executeWalletReset(store, { equity: 100_000, now: NOW + DAY, pid: 4242, hostname: "cli-host" })).toThrow(/boom/);
    expect(store.kvGet(engineLockKey("paper"))).toBeUndefined();
  });

  it("起動中のエンジンがロックを持っていれば (heartbeat の前でも) リセットは拒否する", () => {
    const { store } = seededStore();
    // エンジンが acquireRunLock した直後 (まだ状態を読み込み中)
    expect(acquireEngineLock(store, "paper", { now: NOW, pid: 777, hostname: "engine-host" }).ok).toBe(true);
    const before = kvDump(store);
    const a = io();
    expect(paperResetCommand(paperConfig(), store, { equity: 100_000, confirm: true }, a.io, NOW + 1000)).toBe(1);
    expect(a.err.join("\n")).toMatch(/sudo systemctl stop trader/);
    expect(kvDump(store)).toEqual(before);
  });

  it("run: ロックを取ってからランタイムを組み立てる。組み立ての失敗ではロックを返して store を閉じる", async () => {
    const config = paperConfig();
    const store = new MemoryStore();
    let closed = 0;
    store.close = () => {
      closed++;
    };
    let lockAtBuild: unknown;
    const fakeRt = { engine: { mode: "paper" }, store, close: () => store.close() } as unknown as Runtime;
    const p = await prepareRunRuntime(config, io().io, {
      openStore: () => store,
      now: () => NOW,
      build: async (_c, o) => {
        expect(o.store).toBe(store);
        lockAtBuild = store.kvGet(engineLockKey("paper"));
        return fakeRt;
      },
    });
    expect(p).toBeDefined();
    expect(lockAtBuild).toMatchObject({ pid: process.pid, heartbeatAt: NOW });
    // ロック中は paper reset (別のプロセス) が拒否される
    expect(() => executeWalletReset(store, { equity: 100_000, now: NOW + 1000, pid: process.pid + 1, isPidAlive: () => true })).toThrow(WalletResetError);
    p!.heartbeat.stop();
    p!.releaseLock();
    expect(store.kvGet(engineLockKey("paper"))).toBeUndefined();

    // 組み立ての失敗
    await expect(
      prepareRunRuntime(config, io().io, {
        openStore: () => store,
        now: () => NOW,
        build: async () => {
          throw new Error("feed down");
        },
      }),
    ).rejects.toThrow(/feed down/);
    expect(store.kvGet(engineLockKey("paper"))).toBeUndefined();
    expect(closed).toBe(1);
  });

  it("run: リセット中 (ロックあり) なら組み立てずに終了する", async () => {
    const store = new MemoryStore();
    expect(acquireEngineLock(store, "paper", { now: NOW, pid: 1, hostname: "other-host" }).ok).toBe(true);
    let built = false;
    const a = io();
    const p = await prepareRunRuntime(paperConfig(), a.io, {
      openStore: () => store,
      now: () => NOW + 1000,
      build: async () => {
        built = true;
        throw new Error("呼ばれない");
      },
    });
    expect(p).toBeUndefined();
    expect(built).toBe(false);
    expect(a.err.join("\n")).toMatch(/動いています/);
  });
});

describe("paper reset: DB のロック競合", () => {
  it("別の接続が書き込み中 (SQLITE_BUSY) なら分かりやすいエラーで終了し、何も変えない", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallet-reset-"));
    const path = join(dir, "t.db");
    const a = new SqliteStore(path);
    const b = new SqliteStore(path);
    try {
      seededStore(a);
      const before = kvDump(a);
      const out = io();
      let code: number | undefined;
      // a が書き込みのトランザクションを持ったまま、b でリセットする (busy_timeout の待ちの後に SQLITE_BUSY)
      a.immediateTransaction(() => {
        code = paperResetCommand(paperConfig(), b, { equity: 100_000, confirm: true }, out.io, NOW);
      });
      expect(code).toBe(1);
      expect(out.err.join("\n")).toMatch(/DB が別のプロセスに使われていて書き込めませんでした/);
      expect(kvDump(b)).toEqual(before);
      expect(b.listTrades()).toHaveLength(0);
      // 競合が無くなれば実行できる
      expect(paperResetCommand(paperConfig(), b, { equity: 100_000, confirm: true }, io().io, NOW)).toBe(0);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("paper reset: status の決済済みトレードの件数", () => {
  it("リセットで決済した取引を数えず、paper はリセット以降", () => {
    const store = new MemoryStore();
    store.saveTrade(trade({ id: "old", exitTs: NOW - DAY }));
    expect(settledTradesLine(store, "paper")).toBe("決済済みトレード: 1 件");
    store.kvSet(PAPER_RESETS_KEY, [{ at: NOW, toEquity: 100_000, closedCount: 1 }]);
    store.saveTrade(resetTrade({ id: "rst", exitTs: NOW }));
    store.saveTrade(trade({ id: "new", exitTs: NOW + 1000 }));
    expect(settledTradesLine(store, "paper")).toMatch(/^決済済みトレード: 1 件 \(paper はリセット .* 以降\)$/);
    expect(settledTradesLine(store, "live")).toBe("決済済みトレード: 2 件");
  });
});
