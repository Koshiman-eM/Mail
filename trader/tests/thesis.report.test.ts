/** 読みの答え合わせの集計・表示 (report / simulate / status)、要因分析での扱い。すべて合成データ (オフライン) */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReportText, main } from "../src/cli";
import { loadConfig } from "../src/core/config";
import type { EntryContext, TradeRecord } from "../src/core/types";
import { EXIT_REASON_LABEL, renderTempoTable, renderThesisTable, summarizeByTempo, summarizeThesis } from "../src/engine/report";
import { attributeTrade } from "../src/learning/attribution";
import { isStrategyTrailingExit, TUNER_RULES } from "../src/learning/tuner";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";

const M = 60_000;
const T0 = Date.UTC(2026, 0, 5);

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
  confidence: 0.6, expectedEdgeBps: 30, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "test",
};

function trade(id: string, o: Partial<TradeRecord>): TradeRecord {
  const net = o.netPnl ?? 1;
  return {
    id, mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 1,
    entryTs: T0, entryPrice: 100, intendedEntryPrice: 100, exitTs: T0 + 5 * M, exitPrice: 100 + net, intendedExitPrice: 100 + net, initialStop: 98,
    grossPnl: net + 0.2, fees: 0.2, netPnl: net, returnPct: net / 100, rMultiple: net / 2, mfePct: 0.01, maePct: 0.005, exitReason: "take_profit",
    entryContext: ctx, ...o,
  };
}

const th = (outcome: TradeRecord["thesisOutcome"], extra: Partial<TradeRecord> = {}): Partial<TradeRecord> => ({
  thesisExpectedMs: 10 * M, thesisDeadlineTs: T0 + 10 * M, thesisOutcome: outcome, ...extra,
});

const TRADES: TradeRecord[] = [
  trade("f1", { exitReason: "thesis_failed", netPnl: -1.2, exitTs: T0 + 6 * M, ...th("failed_early") }),
  trade("t1", { exitReason: "thesis_timeout", netPnl: -0.3, exitTs: T0 + 10 * M, ...th("timeout", { thesisNetRAtDeadline: -0.15 }) }),
  trade("t2", { exitReason: "thesis_timeout", netPnl: 0.1, exitTs: T0 + 10 * M, ...th("timeout", { thesisNetRAtDeadline: 0.05 }) }),
  trade("e1", { exitReason: "trailing", netPnl: 0.6, exitTs: T0 + 16 * M, ...th("extended", { thesisExtendedAt: T0 + 10 * M, thesisNetRAtDeadline: 0.4 }) }),
  trade("e2", { exitReason: "thesis_cap", netPnl: 2, exitTs: T0 + 40 * M, ...th("extended", { thesisExtendedAt: T0 + 10 * M, thesisNetRAtDeadline: 0.8 }) }),
  trade("n1", { exitReason: "take_profit", netPnl: 3, exitTs: T0 + 4 * M, ...th("none") }),
  trade("n2", { exitReason: "stop", netPnl: -2, exitTs: T0 + 2 * M, ...th("none") }),
  // 以前の取引 (読みの記録なし)
  trade("old", { exitReason: "time", netPnl: 0.2 }),
];

describe("読みの答え合わせの集計", () => {
  it("区分別の件数・勝率・純損益・平均R、延長の追加保有と最終的な決済、期限での的中率", () => {
    const s = summarizeThesis(TRADES, () => 1);
    expect(s.rows.map((r) => [r.outcome, r.label, r.trades])).toEqual([
      ["failed_early", "途中で読み外れ", 1],
      ["timeout", "期限で読み外れ", 2],
      ["extended", "期限で読み当たり→延長", 2],
      ["none", "期限前に決着", 2],
    ]);
    const timeout = s.rows.find((r) => r.outcome === "timeout")!;
    expect(timeout.winRate).toBeCloseTo(0.5, 9);
    expect(timeout.netPnl).toBeCloseTo(-0.2, 9);
    expect(timeout.avgR).toBeCloseTo((-0.15 + 0.05) / 2, 9);
    const ext = s.rows.find((r) => r.outcome === "extended")!;
    expect(ext.netPnl).toBeCloseTo(2.6, 9);
    // 期限 (10 分) からの追加の保有: 6 分と 30 分
    expect(s.extendedAvgExtraMinutes).toBeCloseTo(18, 9);
    expect(s.extendedExits).toEqual({ trailing: 1, thesis_cap: 1 });
    expect(s.deadlineHitRate).toBeCloseTo(0.5, 9);
    expect(s.untracked).toBe(1);
  });

  it("表: 区分・的中率・延長の内訳・記録なしの注記。記録が無ければその旨", () => {
    const text = renderThesisTable(summarizeThesis(TRADES, () => 1), "JPY");
    expect(text).toMatch(/区分\s+取引数\s+勝率\s+純損益\(JPY\)\s+平均R/);
    expect(text).toContain("途中で読み外れ");
    expect(text).toContain("期限で読み当たり→延長");
    expect(text).toContain("期限での的中率: 50.0% (延長 2 / (延長 2 + 期限で読み外れ 2))");
    expect(text).toContain("期限からの追加の保有 平均 18.0 分 / 最終的な決済: トレーリング 1 / 延長の上限 1");
    expect(text).toContain("記録が無い取引 1 件");
    expect(renderThesisTable(summarizeThesis([TRADES[7]], () => 1), "JPY")).toContain("読みの管理の記録がある取引はまだありません");
    expect(EXIT_REASON_LABEL.thesis_failed).toBe("読み外れ(途中)");
    expect(EXIT_REASON_LABEL.thesis_timeout).toBe("読み外れ(期限)");
    expect(EXIT_REASON_LABEL.thesis_cap).toBe("延長の上限");
  });

  it("report に「読みの答え合わせ」の節を出す (以前の取引も読み込める)", () => {
    const store = new MemoryStore();
    for (const t of TRADES) store.saveTrade(t);
    const text = buildReportText(loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }), store, T0 + 86_400_000);
    expect(text).toContain("■ 読みの答え合わせ (読みの管理 有効)");
    expect(text).toContain("期限での的中率: 50.0%");
    expect(text).toMatch(/決済理由: .*読み外れ\(期限\) 2/);
  });

  it("ParamTuner: trail_loosen は延長後の保護ストップでの決済 (thesisStopExit) を根拠に数えない", () => {
    const rule = TUNER_RULES.find((r) => r.id === "trail_loosen")!;
    const strategyTrail = trade("tr1", { exitReason: "trailing", returnPct: 0.001, netPnl: 0.1, postExitMovePct: 0.03 });
    expect(isStrategyTrailingExit(strategyTrail)).toBe(true);
    expect(rule.evidence(strategyTrail, attributeTrade(strategyTrail, { now: T0 }))).toBe(true);
    // 延長した取引でも、戦略のトレーリングで決済したもの (thesisStopExit なし) は数える
    const extendedStrategyTrail = { ...strategyTrail, id: "tr2", ...th("extended", { thesisExtendedAt: T0 + 10 * M }) };
    expect(rule.evidence(extendedStrategyTrail, attributeTrade(extendedStrategyTrail, { now: T0 }))).toBe(true);
    const thesisTrail = { ...extendedStrategyTrail, id: "tr3", thesisStopExit: true };
    expect(isStrategyTrailingExit(thesisTrail)).toBe(false);
    expect(rule.evidence(thesisTrail, attributeTrade(thesisTrail, { now: T0 }))).toBe(false);
  });

  it("ParamTuner: exit_sooner (含み益の吐き出し) も延長後の保護ストップでの決済 (thesisStopExit) を根拠に数えない", () => {
    const rule = TUNER_RULES.find((r) => r.id === "exit_sooner")!;
    // 最大含み益 2% (損切り幅 2%) から +0.1% まで戻して決済 → late_exit
    const giveback = trade("gb1", { exitReason: "trailing", exitPrice: 100.1, netPnl: 0.1, returnPct: 0.001, mfePct: 0.02 });
    const a = attributeTrade(giveback, { now: T0 });
    expect(a.causes.map((c) => c.code)).toContain("late_exit");
    expect(rule.evidence(giveback, a)).toBe(true);
    const byThesis = { ...giveback, id: "gb2", ...th("extended", { thesisExtendedAt: T0 + 10 * M }), thesisStopExit: true };
    const b = attributeTrade(byThesis, { now: T0 });
    expect(b.causes.map((c) => c.code)).toContain("late_exit");
    expect(rule.evidence(byThesis, b)).toBe(false);
  });

  it("空売り (paper 再現) は読みの答え合わせ・テンポの表で件数と純損益を注記する (各区分の数には含む)", () => {
    const sim = (id: string, o: Partial<TradeRecord>) => trade(id, { direction: "short", simulatedShort: true, ...o });
    const trades = [
      ...TRADES,
      sim("s1", { exitReason: "thesis_timeout", netPnl: -0.5, ...th("timeout") }),
      sim("s2", { exitReason: "trailing", netPnl: 1.5, ...th("extended", { thesisExtendedAt: T0 + 10 * M }), entryContext: { ...ctx, features: { tempoLevel: 0.2 } } }),
    ];
    const s = summarizeThesis(trades, () => 1);
    expect(s.rows.find((r) => r.outcome === "timeout")).toMatchObject({ trades: 3, simShortTrades: 1, simShortNetPnl: -0.5 });
    expect(s.rows.find((r) => r.outcome === "extended")).toMatchObject({ trades: 3, simShortTrades: 1, simShortNetPnl: 1.5 });
    const text = renderThesisTable(s, "JPY");
    expect(text).toMatch(/うち空売り\(paper再現\)/);
    expect(text).toMatch(/期限で読み外れ.*1 件 \(-1\)/);
    expect(text).toContain("live では空売りしません");
    const tempo = summarizeByTempo(trades, () => 1);
    expect(tempo.find((r) => r.kind === "tempo_normal")).toMatchObject({ trades: 1, simShortTrades: 1 });
    expect(tempo.find((r) => r.kind === "no_tempo")).toMatchObject({ simShortTrades: 1 });
    expect(renderTempoTable(tempo, "JPY")).toMatch(/うち空売り\(paper再現\)[\s\S]*live では空売りしません/);
    // 空売り (paper 再現) が無ければ列を出さない
    expect(renderThesisTable(summarizeThesis(TRADES, () => 1), "JPY")).not.toContain("うち空売り");
  });

  it("要因分析: 読みの管理の決済は時間切れと同じく time_decay の対象", () => {
    const small = trade("x", { exitReason: "thesis_timeout", exitPrice: 100.1, netPnl: 0.05, returnPct: 0.0005, mfePct: 0.002, ...th("timeout") });
    expect(attributeTrade(small, { now: T0 }).causes.map((c) => c.code)).toContain("time_decay");
    const tp = trade("y", { exitReason: "take_profit", exitPrice: 100.1, netPnl: 0.05, returnPct: 0.0005, mfePct: 0.002 });
    expect(attributeTrade(tp, { now: T0 }).causes.map((c) => c.code)).not.toContain("time_decay");
  });
});

describe("status: 読みの管理の設定と建玉の読みの期限", () => {
  it("設定の 1 行と、決済計画のある建玉の期限 (監視中 / 延長中) を出す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thesis-status-"));
    const dbPath = join(dir, "t.db");
    // VENUES=synthetic では合成データ用の DB (<ベース名>-synthetic.db) を読む
    const store = new SqliteStore(join(dir, "t-synthetic.db"));
    const journal = new TradeJournal({ store, mode: "paper" });
    const p = journal.open({
      mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 1,
      entryTs: T0, entryPrice: 100, intendedEntryPrice: 100, initialStop: 98, entryContext: ctx,
    });
    const q = journal.open({
      mode: "paper", symbol: "ETH/USDT", venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "short", qty: 1,
      entryTs: T0, entryPrice: 100, intendedEntryPrice: 100, initialStop: 102, entryContext: ctx,
    });
    store.kvSet("positions:exitPlans:paper", { [p.id]: { maxHoldMs: 10 * M }, [q.id]: { maxHoldMs: 10 * M, thesis: { extendedAt: T0 + 10 * M } } });
    store.close();
    const old = { DB_PATH: process.env.DB_PATH, TRADING_MODE: process.env.TRADING_MODE, THESIS_EXIT: process.env.THESIS_EXIT, VENUES: process.env.VENUES };
    process.env.DB_PATH = dbPath;
    delete process.env.TRADING_MODE;
    delete process.env.THESIS_EXIT;
    process.env.VENUES = "synthetic";
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await main(["status"], { out: (s) => out.push(s), err: (s) => err.push(s) });
      expect(err.join("\n")).toBe("");
      expect(code).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
    const text = out.join("\n");
    expect(text).toMatch(/読みの管理 \(THESIS_EXIT\): 有効 \(期限で 純R ≥ 0\.1 なら延長/);
    expect(text).toContain("BTC/USDT 買い 1 @ 100 (s, 2026-01-05 00:00Z) / 読みの期限 2026-01-05 00:10Z (監視中)");
    expect(text).toContain("ETH/USDT 売り 1 @ 100 (s, 2026-01-05 00:00Z) / 読みの期限 2026-01-05 00:10Z → 延長中 (上限 2026-01-05 00:40Z)");
  });
});
