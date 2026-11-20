/**
 * エンジン統合 (paper): 転換で決済 (REVERSAL_*)。台本どおりの 1m 足と気配を返す feed で、
 * 利確・損切りの手前でエントリー後の押し安値を終値が割ったら決済することを確かめる。バックテストとの一致も見る。
 * 実在の取引所へは送信しない (オフライン)。
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest";
import { loadConfig } from "../src/core/config";
import type { Candle, Clock, Strategy, TradeRecord } from "../src/core/types";
import { createLogger } from "../src/core/logger";
import { PositionManager } from "../src/engine/positions";
import { DEFAULT_REVERSAL_SETTINGS } from "../src/engine/reversalExit";
import { buildRuntime } from "../src/engine/setup";
import { thesisSettingsFromEnv } from "../src/engine/thesis";
import { PaperBroker } from "../src/execution/paper";
import { TradeJournal } from "../src/learning/journal";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import {
  barTs, H, INST, LONG_LOSS, LONG_LOSS_BREAK, LONG_LOSS_LEVEL, LONG_PROFIT, LONG_PROFIT_BREAK, LONG_PROFIT_LEVEL, M, probe, scenarioBars, ScriptedFeed, SYM,
} from "./helpers/reversalScenario";

/** LONG_PROFIT の後: 下げ続けて損切り (97) に届く */
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0, 97.5, 96.5, 96.0, 96.0, 96.0, 96.0, 96.0, 96.0];

async function runtime(bars: Candle[], strategy: Strategy, env: Record<string, string> = {}, logs: string[] = []) {
  const clock: Clock & { t: number } = { t: barTs(H) + 1_000, now() { return this.t; } };
  const store = new MemoryStore();
  const feed = new ScriptedFeed(bars, clock);
  const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", LIMIT_ENTRY: "false", ...env });
  const base = createLogger("test");
  const logger = { ...base, warn: (m: string, d?: Record<string, unknown>) => void logs.push(m + (d ? ` ${JSON.stringify(d)}` : "")) };
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [strategy], markets: [{ feed, instruments: [INST] }], engine: { liveAccountCacheMs: 0 },
    logger,
  });
  const tickTo = async (t: number) => {
    clock.t = t;
    return rt.engine.tick(t);
  };
  return { rt, store, tickTo };
}

type World = Awaited<ReturnType<typeof runtime>>;

/** エントリーした足 (添字 H) の中で建玉ができるまで進める */
async function opened(w: World) {
  for (let s = 0; s < 8 && w.rt.engine.positions.list().length === 0; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
  const p = w.rt.engine.positions.list()[0];
  expect(p).toBeDefined();
  expect(p.entryTs).toBeGreaterThanOrEqual(barTs(H));
  expect(p.entryTs).toBeLessThan(barTs(H + 1));
  return p;
}

/** 足 from 〜 to の開始 + 1 秒に順に進める (建玉が無くなったら止める) */
async function run(w: World, from: number, to: number) {
  for (let k = from; k <= to && w.rt.engine.positions.list().length > 0; k++) await w.tickTo(barTs(k) + 1_000);
}

const close = async (w: World) => {
  await w.rt.engine.stop();
  w.rt.close();
};

const strip = (t: TradeRecord) => {
  const { id: _id, ...rest } = t;
  return rest;
};

describe("エンジン (paper): 転換で決済", () => {
  it("買い・含み益で利確の手前: エントリー後の押し安値を終値が割った次のティックで reversal (監査ログに水準・終値・スイングの足)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe());
    const p = await opened(w);
    // 割った足 (r12) が確定するまでは保有したまま
    await run(w, H + 1, H + LONG_PROFIT_BREAK);
    expect(w.rt.engine.positions.list()).toHaveLength(1);
    await w.tickTo(barTs(H + LONG_PROFIT_BREAK + 1) + 1_000);
    expect(w.rt.engine.positions.list()).toHaveLength(0);
    const [t] = w.store.listTrades();
    expect(t).toMatchObject({ exitReason: "reversal", direction: "long", strategyId: "rev_probe", thesisOutcome: "none" });
    expect(t.exitTs).toBe(barTs(H + LONG_PROFIT_BREAK + 1) + 1_000);
    // 利確 (106) の手前・建値より上で決済 (含み益)
    expect(t.exitPrice).toBeLessThan(t.takeProfit!);
    expect(t.exitPrice).toBeGreaterThan(p.entryPrice);
    expect(t.netPnl).toBeGreaterThan(0);
    const [a] = w.store.listAudit({ type: "position.reversal_exit" });
    expect(a.data).toMatchObject({
      tradeId: p.id, symbol: SYM, direction: "long", detail: "押し安値割れ", timeframe: "1m", level: LONG_PROFIT_LEVEL, close: 102.4,
      pivotTs: barTs(H + 7), barTs: barTs(H + LONG_PROFIT_BREAK), status: "closed", pivotN: 3, bufferAtr: 0,
    });
    expect(a.data.grossR as number).toBeGreaterThan(0);
    // 決済の監査ログ (engine.exit) の理由も reversal
    expect(w.store.listAudit({ type: "engine.exit" }).map((e) => e.data.reason)).toEqual(["reversal"]);
    // 状態表示に設定が出る
    expect((await w.rt.engine.status()).reversal).toEqual({ ...DEFAULT_REVERSAL_SETTINGS, strategies: [] });
    await close(w);
  }, 60_000);

  it("買い・含み損で損切りの手前: 押し安値割れで reversal (損切り 97 より上)", async () => {
    const w = await runtime(scenarioBars(LONG_LOSS, [99.3, 99.0, 98.5, 98.0]), probe());
    const p = await opened(w);
    await run(w, H + 1, H + LONG_LOSS_BREAK);
    expect(w.rt.engine.positions.list()).toHaveLength(1);
    await w.tickTo(barTs(H + LONG_LOSS_BREAK + 1) + 1_000);
    const [t] = w.store.listTrades();
    expect(t).toMatchObject({ exitReason: "reversal" });
    expect(t.exitPrice).toBeLessThan(p.entryPrice);
    expect(t.exitPrice).toBeGreaterThan(p.initialStop);
    expect(t.netPnl).toBeLessThan(0);
    expect(w.store.listAudit({ type: "position.reversal_exit" })[0].data).toMatchObject({ level: LONG_LOSS_LEVEL, close: 99.4, pivotTs: barTs(H + 5) });
    await close(w);
  }, 60_000);

  it("REVERSAL_EXIT=false は従来どおり (押し安値を割っても持ち続け、損切りで決済)。対象外の戦略 (REVERSAL_EXIT_STRATEGIES) も同じ", async () => {
    const results: TradeRecord[] = [];
    const envs: Record<string, string>[] = [{ REVERSAL_EXIT: "false" }, { REVERSAL_EXIT_STRATEGIES: "other_strategy" }];
    for (const env of envs) {
      const logs: string[] = [];
      const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe(), env, logs);
      await opened(w);
      await run(w, H + 1, H + LONG_PROFIT_BREAK + 1);
      // 押し安値割れの次のティックでも保有したまま
      expect(w.rt.engine.positions.list()).toHaveLength(1);
      await run(w, H + LONG_PROFIT_BREAK + 2, H + LONG_PROFIT.length + TAIL.length - 1);
      const [t] = w.store.listTrades();
      expect(t.exitReason).toBe("stop");
      expect(w.store.listAudit({ type: "position.reversal_exit" })).toHaveLength(0);
      results.push(t);
      if (env.REVERSAL_EXIT_STRATEGIES) {
        // 未登録の id は起動時に警告する
        expect(logs.some((l) => l.includes("REVERSAL_EXIT_STRATEGIES に未登録の戦略 id があります (無視されます): other_strategy"))).toBe(true);
      } else {
        expect(logs.some((l) => l.includes("REVERSAL_EXIT_STRATEGIES"))).toBe(false);
      }
      await close(w);
    }
    expect(strip(results[1])).toEqual(strip(results[0]));
  }, 60_000);

  it("REVERSAL_EXIT_STRATEGIES に戦略を入れれば対象 (reversal)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe(), { REVERSAL_EXIT_STRATEGIES: "rev_probe" });
    await opened(w);
    await run(w, H + 1, H + LONG_PROFIT_BREAK + 1);
    expect(w.store.listTrades()[0]?.exitReason).toBe("reversal");
    await close(w);
  }, 60_000);

  it("同じ確定足で戦略の決済シグナルも出たら signal を優先する (転換で決済の監査ログは残さない)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe({ flatFrom: barTs(H + LONG_PROFIT_BREAK + 1) }));
    await opened(w);
    await run(w, H + 1, H + LONG_PROFIT_BREAK + 1);
    expect(w.store.listTrades()[0]?.exitReason).toBe("signal");
    expect(w.store.listAudit({ type: "position.reversal_exit" })).toHaveLength(0);
    await close(w);
  }, 60_000);

  it("読みの管理で延長した建玉も対象 (答え合わせは延長)", async () => {
    // 読みの期限 5 分で延長 (延長後のトレーリングは 3R = 建値で守る)、上限は 20 分。押し安値割れ (13 分) が先
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe(), { MAX_HOLD_MINUTES: "5", THESIS_TRAIL_R: "3" });
    const p = await opened(w);
    await run(w, H + 1, H + LONG_PROFIT_BREAK);
    expect(w.rt.engine.positions.planOf(p.id).thesis?.extendedAt).toBeDefined();
    await w.tickTo(barTs(H + LONG_PROFIT_BREAK + 1) + 1_000);
    const [t] = w.store.listTrades();
    expect(t).toMatchObject({ exitReason: "reversal", thesisOutcome: "extended" });
    expect(t.thesisExtendedAt).toBeDefined();
    await close(w);
  }, 60_000);

  it("観測専用の戦略の仮想トレードも、戦略の主時間足で同じ足に reversal (エンジンが hub の足を渡す)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe(), { OBSERVE_ONLY_STRATEGIES: "rev_probe" });
    await w.tickTo(barTs(H) + 1_000);
    expect(w.rt.engine.positions.list()).toHaveLength(0);
    expect(w.rt.engine.shadow!.list()).toMatchObject([{ reason: "observe_only", reversalTf: "1m" }]);
    for (let k = H + 1; k <= H + LONG_PROFIT_BREAK + 1; k++) await w.tickTo(barTs(k) + 1_000);
    const [sh] = w.store.listShadowTrades();
    expect(sh).toMatchObject({ reason: "observe_only", exitReason: "reversal", exitTs: barTs(H + LONG_PROFIT_BREAK + 1) + 1_000 });
    expect(w.rt.engine.shadow!.size).toBe(0);
    await close(w);
  }, 60_000);

  it("バックテストと一致: 同じ足で、エントリーの足・決済の足・理由が同じ (バックテストは次の足の始値で決済)", async () => {
    const bars = scenarioBars(LONG_PROFIT, TAIL);
    const w = await runtime(bars, probe());
    await opened(w);
    await run(w, H + 1, H + LONG_PROFIT.length + TAIL.length - 1);
    const [live] = w.store.listTrades();
    await close(w);
    const bt = runBacktest({
      strategy: probe({ at: barTs(H) }), instrument: INST, candles: bars, baseTimeframe: "1m", spreadBps: 0.2, slippageBps: 0,
      thesis: thesisSettingsFromEnv(loadConfig({}).env), reversal: { ...DEFAULT_REVERSAL_SETTINGS },
    });
    expect(bt.trades).toHaveLength(1);
    const [b] = bt.trades;
    expect(b.exitReason).toBe("reversal");
    expect(live.exitReason).toBe(b.exitReason);
    const barOf = (ts: number) => Math.floor((ts - barTs(0)) / M);
    expect(barOf(b.entryTs)).toBe(H);
    expect(barOf(live.entryTs)).toBe(barOf(b.entryTs));
    expect(barOf(b.exitTs)).toBe(H + LONG_PROFIT_BREAK + 1);
    expect(barOf(live.exitTs)).toBe(barOf(b.exitTs));
    // 約定はどちらも決済の足の始値 (= 割った足の終値 102.4) 付近
    expect(b.exitPrice).toBeCloseTo(102.4, 1);
    expect(live.exitPrice).toBeCloseTo(b.exitPrice, 1);
    expect(bt.stats.reversalExits).toBe(1);
    expect(bt.stats.signalExits).toBe(0);
  }, 60_000);
});

describe("PositionManager.exitInProgress (転換で決済を重ねない)", () => {
  const ctx = {
    regime: { label: "range" as const, trend: 0, trendStrength: 0, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
    confidence: 0.7, expectedEdgeBps: 50, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "t",
  };
  const openOne = (journal: TradeJournal, symbol: string) =>
    journal.open({
      mode: "paper", symbol, venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 1,
      entryTs: barTs(0), entryPrice: 100, intendedEntryPrice: 100, initialStop: 97, entryContext: ctx,
    });

  it("決めた読みの決済・一部約定の残り・保留中の注文があれば理由を返す。無ければ undefined", () => {
    const store = new MemoryStore();
    const journal = new TradeJournal({ store, mode: "paper" });
    const a = openOne(journal, "A/USDT");
    const b = openOne(journal, "B/USDT");
    const c = openOne(journal, "C/USDT");
    openOne(journal, "D/USDT");
    store.kvSet("positions:exitPlans:paper", {
      [a.id]: { maxHoldMs: 10 * M, thesis: { exit: { reason: "thesis_timeout", at: barTs(10) } } },
      [b.id]: { retryExit: { reason: "stop", intendedPrice: 97 } },
      [c.id]: { maxHoldMs: 10 * M },
    });
    const paper = new PaperBroker({ instruments: [INST], baseCurrency: "USDT", initialEquity: 1_000_000, clock: { now: () => barTs(0) } });
    const pm = new PositionManager({ journal, brokerFor: () => paper, store });
    expect(pm.exitInProgress("A/USDT")).toMatch(/読みの決済 \(thesis_timeout\) を再試行中/);
    expect(pm.exitInProgress("B/USDT")).toMatch(/一部約定の残りを決済中/);
    expect(pm.exitInProgress("C/USDT")).toBeUndefined();
    expect(pm.exitInProgress("Z/USDT")).toBe("ポジションがありません");
    pm.pending.upsert({ clientId: "x1", symbol: "D/USDT", side: "sell", qty: "1", kind: "exit", createdAt: barTs(0), status: "unknown", unknownCount: 1 });
    expect(pm.exitInProgress("D/USDT")).toBe("保留中の注文があります");
  });
});
