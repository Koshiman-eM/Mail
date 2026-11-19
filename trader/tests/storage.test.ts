import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { IntelItem, Lesson, ParamAdjustment, ShadowTradeRecord, Store, TradeRecord } from "../src/core/types";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import { createStore } from "../src/storage";

function trade(id: string, exitTs: number, over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id,
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: "crypto",
    strategyId: "scalp_a",
    horizon: "scalp",
    direction: "long",
    qty: 1,
    entryTs: exitTs - 60_000,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs,
    exitPrice: 101,
    intendedExitPrice: 101,
    initialStop: 99,
    grossPnl: 1,
    fees: 0.1,
    netPnl: 0.9,
    returnPct: 0.009,
    rMultiple: 0.9,
    mfePct: 0.012,
    maePct: 0.002,
    exitReason: "take_profit",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.6,
      expectedEdgeBps: 30,
      costBps: 10,
      params: { stopAtr: 1 },
      features: { x: 1 },
      riskMultiplier: 1,
      reason: "test",
    },
    ...over,
  };
}

function intel(id: string, publishedAt: number, assets: string[], kind: IntelItem["kind"] = "news"): IntelItem {
  return { id, source: "rss:test", kind, title: `title ${id}`, publishedAt, fetchedAt: publishedAt + 1, assets, sentiment: 0.2 };
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function shadowTrade(id: string, exitTs: number, over: Partial<ShadowTradeRecord> = {}): ShadowTradeRecord {
  return {
    id, mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", strategyId: "scalp_a", horizon: "scalp", regime: "range", direction: "long",
    reason: "risk: 期待値幅 #bps < コスト #bps × #", confidence: 0.6, expectedEdgeBps: 20, entryTs: exitTs - 60_000, entryPrice: 100.05, entryMid: 100,
    entrySpread: 0.1, stopLoss: 99, takeProfit: 102, maxHoldMs: 600_000, takerFeeRate: 0.001, slippageBps: 2, exitTs, exitPrice: 102,
    exitReason: "take_profit", grossR: 1.9, costR: 0.6, netR: 1.3, mfeR: 2, maeR: 0.1, ...over,
  };
}

describe.each<[string, () => Store]>([
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore(:memory:)", () => new SqliteStore(":memory:")],
])("%s", (_name, make) => {
  it("trades: 保存・フィルタ・昇順・limit は最新 N 件", () => {
    const s = make();
    s.saveTrade(trade("t1", 1000));
    s.saveTrade(trade("t3", 3000, { strategyId: "b", symbol: "USD/JPY", assetClass: "fx", mode: "live" }));
    s.saveTrade(trade("t2", 2000));
    expect(s.listTrades().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(s.listTrades({ since: 2000 }).map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(s.listTrades({ until: 2000 }).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.listTrades({ strategyId: "b" }).map((t) => t.id)).toEqual(["t3"]);
    expect(s.listTrades({ symbol: "BTC/USDT" }).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.listTrades({ assetClass: "fx" }).map((t) => t.id)).toEqual(["t3"]);
    expect(s.listTrades({ mode: "paper" }).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.listTrades({ limit: 2 }).map((t) => t.id)).toEqual(["t2", "t3"]);
    // 内容の往復
    expect(s.listTrades({ limit: 1 })[0]).toEqual(trade("t3", 3000, { strategyId: "b", symbol: "USD/JPY", assetClass: "fx", mode: "live" }));
    s.close();
  });

  it("trades: updateTrade は部分更新、同じ id の save は上書き", () => {
    const s = make();
    s.saveTrade(trade("t1", 1000));
    s.updateTrade("t1", { postExitMovePct: 0.02 });
    s.updateTrade("missing", { postExitMovePct: 0.5 });
    const t = s.listTrades()[0];
    expect(t.postExitMovePct).toBe(0.02);
    expect(t.netPnl).toBe(0.9);
    s.saveTrade(trade("t1", 1000, { netPnl: -5 }));
    expect(s.listTrades()).toHaveLength(1);
    expect(s.listTrades()[0].netPnl).toBe(-5);
    s.close();
  });

  it("返した値を書き換えても保存内容は変わらない", () => {
    const s = make();
    s.saveTrade(trade("t1", 1000));
    const t = s.listTrades()[0];
    t.netPnl = 999;
    t.entryContext.params.stopAtr = 99;
    expect(s.listTrades()[0].netPnl).toBe(0.9);
    expect(s.listTrades()[0].entryContext.params.stopAtr).toBe(1);
    s.close();
  });

  it("attributions", () => {
    const s = make();
    s.saveAttribution({ tradeId: "t1", outcome: "win", causes: [{ code: "good_process", weight: 1, evidence: "ok" }], createdAt: 10 });
    s.saveAttribution({ tradeId: "t2", outcome: "loss", causes: [], createdAt: 20 });
    s.saveAttribution({ tradeId: "t1", outcome: "loss", causes: [], createdAt: 10 });
    expect(s.getAttribution("t1")?.outcome).toBe("loss");
    expect(s.getAttribution("none")).toBeUndefined();
    expect(s.listAttributions().map((a) => a.tradeId)).toEqual(["t1", "t2"]);
    expect(s.listAttributions(15).map((a) => a.tradeId)).toEqual(["t2"]);
    s.close();
  });

  it("intel: 重複無視・新規件数・assets/kinds/since/limit・getIntel", () => {
    const s = make();
    expect(s.saveIntel([intel("a", 100, ["BTC"]), intel("b", 200, ["ETH", "BTC"]), intel("c", 300, ["USD", "JPY"], "calendar")])).toBe(3);
    expect(s.saveIntel([intel("a", 100, ["BTC"]), intel("d", 400, ["AAPL"], "social")])).toBe(1);
    expect(s.saveIntel([])).toBe(0);
    expect(s.listIntel().map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(s.listIntel({ assets: ["BTC"] }).map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.listIntel({ assets: ["JPY", "AAPL"] }).map((i) => i.id)).toEqual(["c", "d"]);
    expect(s.listIntel({ assets: ["BT"] })).toEqual([]);
    expect(s.listIntel({ kinds: ["calendar", "social"] }).map((i) => i.id)).toEqual(["c", "d"]);
    expect(s.listIntel({ since: 200, limit: 2 }).map((i) => i.id)).toEqual(["c", "d"]);
    expect(s.getIntel(["d", "zzz", "a", "d"]).map((i) => i.id)).toEqual(["d", "a"]);
    expect(s.getIntel([])).toEqual([]);
    expect(s.getIntel(["b"])[0]).toEqual(intel("b", 200, ["ETH", "BTC"]));
    s.close();
  });

  it("brief / plan は generatedAt 最新を返す", () => {
    const s = make();
    expect(s.latestBrief()).toBeUndefined();
    expect(s.latestPlan()).toBeUndefined();
    const brief = (t: number) => ({ generatedAt: t, riskOn: 0, summary: `b${t}`, biases: {}, watchlist: [], events: [], stub: true });
    s.saveBrief(brief(200));
    s.saveBrief(brief(100));
    expect(s.latestBrief()?.summary).toBe("b200");
    const plan = (t: number) => ({ generatedAt: t, validUntil: t + 10, perSymbol: {}, blackouts: [], rationale: `p${t}` });
    s.savePlan(plan(5));
    s.savePlan(plan(7));
    expect(s.latestPlan()?.rationale).toBe("p7");
    s.close();
  });

  it("lessons: upsert・status/scope/limit", () => {
    const s = make();
    const l = (id: string, createdAt: number, scope: string, status: Lesson["status"] = "active"): Lesson => ({
      id,
      createdAt,
      scope,
      text: id,
      evidence: "",
      origin: "rule",
      status,
    });
    s.saveLesson(l("l1", 1, "global"));
    s.saveLesson(l("l2", 2, "strategy:x"));
    s.saveLesson(l("l3", 3, "global"));
    s.saveLesson({ ...l("l1", 1, "global"), status: "retired" });
    expect(s.listLessons().map((x) => x.id)).toEqual(["l1", "l2", "l3"]);
    expect(s.listLessons({ status: "active" }).map((x) => x.id)).toEqual(["l2", "l3"]);
    expect(s.listLessons({ scope: "global" }).map((x) => x.id)).toEqual(["l1", "l3"]);
    expect(s.listLessons({ status: "active", limit: 1 }).map((x) => x.id)).toEqual(["l3"]);
    s.close();
  });

  it("adjustments: upsert・フィルタ", () => {
    const s = make();
    const a = (id: string, createdAt: number, strategyId: string, status: ParamAdjustment["status"]): ParamAdjustment => ({
      id,
      strategyId,
      assetClass: "crypto",
      param: "stopAtr",
      from: 1,
      to: 1.1,
      reason: "r",
      status,
      createdAt,
    });
    s.saveAdjustment(a("a1", 1, "x", "applied"));
    s.saveAdjustment(a("a2", 2, "y", "proposed"));
    s.saveAdjustment({ ...a("a1", 1, "x", "reverted"), validation: { baselineScore: 1, candidateScore: 2, trades: 30 } });
    expect(s.listAdjustments().map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(s.listAdjustments({ strategyId: "x" })[0].status).toBe("reverted");
    expect(s.listAdjustments({ strategyId: "x" })[0].validation?.trades).toBe(30);
    expect(s.listAdjustments({ status: "proposed" }).map((x) => x.id)).toEqual(["a2"]);
    expect(s.listAdjustments({ status: "applied" })).toEqual([]);
    s.close();
  });

  it("equity / audit", () => {
    const s = make();
    s.saveEquity({ ts: 2, equity: 110, mode: "paper" });
    s.saveEquity({ ts: 1, equity: 100, mode: "paper" });
    s.saveEquity({ ts: 3, equity: 1, mode: "backtest" });
    expect(s.listEquity({ mode: "paper" })).toEqual([
      { ts: 1, equity: 100, mode: "paper" },
      { ts: 2, equity: 110, mode: "paper" },
    ]);
    expect(s.listEquity({ since: 2 }).map((p) => p.ts)).toEqual([2, 3]);
    s.audit({ ts: 1, type: "order", data: { a: 1 } });
    s.audit({ ts: 2, type: "halt", data: { nested: { b: [1, 2] } } });
    s.audit({ ts: 3, type: "order", data: {} });
    expect(s.listAudit({ type: "order" }).map((e) => e.ts)).toEqual([1, 3]);
    expect(s.listAudit({ since: 2 }).map((e) => e.type)).toEqual(["halt", "order"]);
    expect(s.listAudit({ limit: 1 })[0].ts).toBe(3);
    expect(s.listAudit({ type: "halt" })[0].data).toEqual({ nested: { b: [1, 2] } });
    s.close();
  });

  it("shadow trades: upsert・フィルタ (since/mode/strategyId/reason)・exitTs の昇順・limit は最新 N 件・prune", () => {
    const s = make();
    s.saveShadowTrade(shadowTrade("b", 2_000));
    s.saveShadowTrade(shadowTrade("a", 1_000, { mode: "live", strategyId: "short_b", reason: "direction_bias" }));
    s.saveShadowTrade(shadowTrade("c", 3_000, { netR: -1.2, exitReason: "stop" }));
    expect(s.listShadowTrades().map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(s.listShadowTrades({ since: 2_000 }).map((t) => t.id)).toEqual(["b", "c"]);
    expect(s.listShadowTrades({ mode: "live" }).map((t) => t.id)).toEqual(["a"]);
    expect(s.listShadowTrades({ strategyId: "short_b" }).map((t) => t.id)).toEqual(["a"]);
    expect(s.listShadowTrades({ reason: "direction_bias" }).map((t) => t.id)).toEqual(["a"]);
    expect(s.listShadowTrades({ limit: 2 }).map((t) => t.id)).toEqual(["b", "c"]);
    // 同じ id は上書き
    s.saveShadowTrade(shadowTrade("b", 2_500, { netR: 0.5 }));
    const all = s.listShadowTrades();
    expect(all).toHaveLength(3);
    expect(all.find((t) => t.id === "b")).toMatchObject({ exitTs: 2_500, netR: 0.5 });
    expect(all.find((t) => t.id === "c")).toEqual(shadowTrade("c", 3_000, { netR: -1.2, exitReason: "stop" }));
    // 返した値を書き換えても保存内容は変わらない
    all[0].netR = 99;
    expect(s.listShadowTrades()[0].netR).not.toBe(99);
    expect(s.pruneShadowTrades(2_500)).toBe(1);
    expect(s.listShadowTrades().map((t) => t.id)).toEqual(["b", "c"]);
    expect(s.pruneShadowTrades(0)).toBe(0);
    s.close();
  });

  it("kv", () => {
    const s = make();
    expect(s.kvGet("x")).toBeUndefined();
    s.kvSet("x", { a: 1, b: [1, 2] });
    expect(s.kvGet<{ a: number }>("x")).toEqual({ a: 1, b: [1, 2] });
    s.kvSet("x", 5);
    expect(s.kvGet<number>("x")).toBe(5);
    s.kvSet("x", undefined);
    expect(s.kvGet("x")).toBeUndefined();
    s.close();
  });
});

describe("SqliteStore (ファイル)", () => {
  it("親ディレクトリを自動作成し、再オープン後もデータが残る", () => {
    const dir = mkdtempSync(join(tmpdir(), "trader-store-"));
    tmpDirs.push(dir);
    const path = join(dir, "nested", "deep", "t.db");
    const s1 = new SqliteStore(path);
    s1.saveTrade(trade("t1", 1000));
    s1.kvSet("arm:x", { n: 3 });
    s1.saveIntel([intel("a", 1, ["BTC"])]);
    s1.saveShadowTrade(shadowTrade("sh1", 1_500));
    s1.close();
    s1.close(); // 二重 close は無害
    expect(existsSync(path)).toBe(true);

    const s2 = new SqliteStore(path);
    expect(s2.listTrades().map((t) => t.id)).toEqual(["t1"]);
    expect(s2.kvGet("arm:x")).toEqual({ n: 3 });
    expect(s2.saveIntel([intel("a", 1, ["BTC"])])).toBe(0);
    expect(s2.listShadowTrades().map((t) => t.id)).toEqual(["sh1"]);
    s2.close();
  });

  it("createStore", () => {
    expect(createStore("memory")).toBeInstanceOf(MemoryStore);
    const s = createStore(":memory:");
    expect(s).toBeInstanceOf(SqliteStore);
    s.close();
  });

  it("transaction: trades と kv の書き込みをまとめて確定し、途中で例外なら両方とも巻き戻す (入れ子は外側に参加)", () => {
    const s = new SqliteStore(":memory:");
    expect(s.transaction(() => {
      s.saveTrade(trade("ok", 1_000));
      s.kvSet("k", 1);
      return s.transaction(() => 42);
    })).toBe(42);
    expect(() =>
      s.transaction(() => {
        s.saveTrade(trade("ng", 2_000));
        s.kvSet("k", 2);
        throw new Error("crash");
      }),
    ).toThrow("crash");
    expect(s.listTrades().map((t) => t.id)).toEqual(["ok"]);
    expect(s.kvGet("k")).toBe(1);
    s.close();
    // メモリ実装はそのまま実行する
    expect(new MemoryStore().transaction(() => "done")).toBe("done");
  });
});
