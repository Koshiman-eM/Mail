import { describe, expect, it } from "vitest";
import type { Lesson, ParamAdjustment, Store, TradeRecord } from "../src/core/types";
import { TerminalMap, isTerminalOrder, sweepOld } from "../src/core/sweep";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import { ShadowTracker, SHADOW_SAVE_INTERVAL_MS, shadowOpenKey } from "../src/learning/shadow";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);

describe.each<[string, () => Store]>([
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore(:memory:)", () => new SqliteStore(":memory:")],
])("pruneOperational: %s", (_n, make) => {
  it("運用ログだけを消し、学習データ (trades/attributions/lessons/adjustments/shadow/forecast/kv) は残す", () => {
    const s = make();
    const old = NOW - 400 * DAY;
    // 運用ログ (古いもの 1 + 新しいもの 1)
    s.audit({ ts: old, type: "a", data: {} });
    s.audit({ ts: NOW - DAY, type: "b", data: {} });
    for (const [id, t] of [["i_old", old], ["i_new", NOW - DAY]] as const) {
      s.saveIntel([{ id, source: "rss:t", kind: "news", title: id, publishedAt: t, fetchedAt: t, assets: ["BTC"], sentiment: 0 }]);
    }
    const brief = (t: number) => ({ generatedAt: t, riskOn: 0, summary: `b${t}`, biases: {}, watchlist: [], events: [], stub: true });
    s.saveBrief(brief(old));
    s.saveBrief(brief(NOW - DAY));
    const plan = (t: number) => ({ generatedAt: t, validUntil: t + 10, perSymbol: {}, blackouts: [], rationale: `p${t}` });
    s.savePlan(plan(old));
    s.savePlan(plan(old + 1));
    s.saveEquity({ ts: old, mode: "paper", equity: 1 });
    s.saveEquity({ ts: NOW - 100 * DAY, mode: "paper", equity: 2 });
    // 学習データ (どれも非常に古い)
    s.saveTrade({ id: "t1", mode: "paper", exitTs: old, entryTs: old - 1, strategyId: "s", symbol: "BTC/USDT", assetClass: "crypto" } as unknown as TradeRecord);
    s.saveAttribution({ tradeId: "t1", outcome: "win", causes: [], createdAt: old });
    s.saveLesson({ id: "l1", createdAt: old, scope: "global", text: "x", evidence: "", origin: "rule", status: "active" } as Lesson);
    s.saveAdjustment({ id: "a1", createdAt: old, strategyId: "x", assetClass: "crypto", param: "p", from: 1, to: 2, reason: "r", status: "applied" } as ParamAdjustment);
    s.kvSet("adjmeta:x", { n: 1 });
    s.kvSet("shadow:open:paper", []);

    const r = s.pruneOperational({ audit: NOW - 30 * DAY, intel: NOW - 30 * DAY, briefs: NOW - 30 * DAY, plans: NOW - 30 * DAY, equity: NOW - 180 * DAY });
    expect(r).toEqual({ audit: 1, intel: 1, briefs: 1, plans: 1, equity: 1 });
    expect(s.listAudit().map((e) => e.type)).toEqual(["b"]);
    expect(s.listIntel().map((i) => i.id)).toEqual(["i_new"]);
    expect(s.latestBrief()?.generatedAt).toBe(NOW - DAY);
    expect(s.latestPlan()?.generatedAt).toBe(old + 1); // 最新の 1 件は古くても残す
    expect(s.listEquity().map((p) => p.equity)).toEqual([2]);

    expect(s.listTrades()).toHaveLength(1);
    expect(s.listAttributions()).toHaveLength(1);
    expect(s.listLessons()).toHaveLength(1);
    expect(s.listAdjustments()).toHaveLength(1);
    expect(s.kvGet("adjmeta:x")).toEqual({ n: 1 });
    expect(s.kvGet("shadow:open:paper")).toEqual([]);
    // cutoff 未指定の表は触らない
    expect(s.pruneOperational({})).toEqual({ audit: 0, intel: 0, briefs: 0, plans: 0, equity: 0 });
    s.close();
  });

  it("listAdjustments({ limit }) は最新 N 件を昇順で返す", () => {
    const s = make();
    for (let i = 1; i <= 5; i++) {
      s.saveAdjustment({ id: `a${i}`, createdAt: i, strategyId: "x", assetClass: "crypto", param: "p", from: 1, to: 2, reason: "r", status: "applied" } as ParamAdjustment);
    }
    expect(s.listAdjustments({ limit: 2 }).map((a) => a.id)).toEqual(["a4", "a5"]);
    expect(s.listAdjustments().map((a) => a.id)).toHaveLength(5);
    s.close();
  });
});

describe("TerminalMap / sweepOld", () => {
  it("確定済みだけを件数・時間で削除し、未確定は残す", () => {
    let now = 0;
    const evicted: string[] = [];
    const m = new TerminalMap<{ status: string }>({ isTerminal: isTerminalOrder, maxEntries: 3, maxAgeMs: 1000, now: () => now, onEvict: (k) => evicted.push(k) });
    m.set("open1", { status: "open" });
    for (let i = 0; i < 5; i++) {
      now += 1;
      m.set(`f${i}`, { status: "filled" });
    }
    expect(m.has("open1")).toBe(true);
    expect([...m.keys()].filter((k) => k.startsWith("f")).length).toBeLessThanOrEqual(3);
    now += 20 * 60_000; // 時間切れ
    m.set("f9", { status: "filled" });
    expect(m.has("open1")).toBe(true);
    expect(m.has("f0")).toBe(false);
    expect(evicted.length).toBeGreaterThan(0);
  });

  it("sweepOld は古いキーを消す", () => {
    const m = new Map([["a", 0], ["b", 900]]);
    sweepOld(m, 1000, 500);
    expect([...m.keys()]).toEqual(["b"]);
  });
});

describe("ShadowTracker の保存の間引き", () => {
  const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
  const sig = { strategyId: "s", direction: "long" as const, confidence: 0.7, expectedEdgeBps: 15, stopLoss: 98.1, takeProfit: 140, maxHoldMs: 3_600_000, horizon: "scalp" as const };

  it("状態が変わらない tick は書かず、MFE 更新だけなら間隔を空け、決済は即保存、flush() は強制保存", () => {
    const store = new MemoryStore();
    let writes = 0;
    const orig = store.kvSet.bind(store);
    store.kvSet = ((k: string, v: unknown) => {
      if (k === shadowOpenKey("paper")) writes++;
      orig(k, v);
    }) as typeof store.kvSet;
    const T0 = 1_000_000_000_000;
    const tr = new ShadowTracker({ store, mode: "paper" });
    tr.record({ instrument: inst, quote: { bid: 99.9, ask: 100.1 }, signal: sig, regime: "range", reason: "r", now: T0 });
    tr.update(T0 + 1000, () => ({ bid: 99.9, ask: 100.1 })); // 新規追加分を保存
    const base = writes;
    tr.update(T0 + 2000, () => ({ bid: 99.9, ask: 100.1 })); // 変化なし
    tr.update(T0 + 3000, () => ({ bid: 99.9, ask: 100.1 }));
    expect(writes).toBe(base);
    tr.update(T0 + 4000, () => ({ bid: 101.9, ask: 102.1 })); // MFE 更新 → dirty だが間隔内
    expect(writes).toBe(base);
    tr.update(T0 + 1000 + SHADOW_SAVE_INTERVAL_MS, () => ({ bid: 101.9, ask: 102.1 }));
    expect(writes).toBe(base + 1);
    tr.update(T0 + 1000 + SHADOW_SAVE_INTERVAL_MS + 5000, () => ({ bid: 103.9, ask: 104.1 })); // 再び MFE 更新 (間隔内)
    expect(writes).toBe(base + 1);
    tr.flush(); // 終了処理
    expect(writes).toBe(base + 2);
    const saved = store.kvGet<{ mfeR: number }[]>(shadowOpenKey("paper"));
    expect(saved?.[0].mfeR).toBeGreaterThan(1);
    // 決済は即保存
    const closed = tr.update(T0 + 1000 + SHADOW_SAVE_INTERVAL_MS + 6000, () => ({ bid: 97, ask: 97.2 }));
    expect(closed).toHaveLength(1);
    expect(writes).toBe(base + 3);
  });
});
