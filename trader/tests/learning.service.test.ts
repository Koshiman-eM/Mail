import { describe, expect, it } from "vitest";
import type { EntryContext, TradeRecord } from "../src/core/types";
import { TradeJournal } from "../src/learning/journal";
import { LearningService, type StrategyInfo } from "../src/learning/service";
import { MemoryStore } from "../src/storage/memory";
import { stubValidator } from "./helpers/validation";

const DAY = 86_400_000;
const T0 = 50 * DAY;

const S1: StrategyInfo = {
  defaultParams: { stopAtr: 1.5, tpAtr: 2, trailAtr: 0, entryThreshold: 0.5, maxHoldBars: 10 },
  paramBounds: { stopAtr: [1, 3], tpAtr: [1, 4], trailAtr: [0, 3], entryThreshold: [0.1, 1], maxHoldBars: [3, 30] },
  regimes: ["range"],
};

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 12, volatility: 0.01, volatilityPercentile: 0.4, spreadBps: 1 },
  intel: { asset: "BTC", sentiment: 0.4, confidence: 0.5, eventRisk: 0.1, sourceIds: [], sourceContrib: { "rss:a": 0.5 } },
  confidence: 0.6,
  expectedEdgeBps: 40,
  costBps: 10,
  params: S1.defaultParams,
  features: {},
  riskMultiplier: 1,
  reason: "t",
};

/** ストップで刈られる (少し有利に動いてから 98 で損切り) トレードを journal で作る */
function stoppedTrades(journal: TradeJournal, n: number): TradeRecord[] {
  const out: TradeRecord[] = [];
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * 3_600_000;
    const p = journal.open({
      mode: "paper",
      symbol: "BTC/USDT",
      venue: "paper",
      assetClass: "crypto",
      strategyId: "s1",
      horizon: "scalp",
      direction: "long",
      qty: 1,
      entryTs: ts,
      entryPrice: 100,
      intendedEntryPrice: 100,
      initialStop: 98,
      takeProfit: 104,
      entryContext: ctx,
    });
    journal.mark("BTC/USDT", 100.6, ts + 60_000);
    out.push(journal.close({ id: p.id, exitPrice: 98, intendedExitPrice: 98, exitTs: ts + 120_000, exitReason: "stop" }));
  }
  return out;
}

describe("LearningService", () => {
  it("決済 → 要因分析・配分・情報源 → 定期処理 (後追い値動き・tuner・振り返り) → snapshot", async () => {
    const store = new MemoryStore();
    // 区間ごとの成績が stopAtr に比例して良くなる検証器 (1.5 → 1.65 で全区間 +1.5R)
    const validate = stubValidator((p) => 10 * p.stopAtr);
    const svc = new LearningService({
      store,
      getStrategy: (id) => (id === "s1" ? S1 : undefined),
      validate,
      ai: { apiKey: "", model: "claude-opus-5-5" },
      // 刈られた後に 102.5 まで戻った
      priceAt: (symbol) => (symbol === "BTC/USDT" ? 102.5 : undefined),
    });
    const journal = new TradeJournal({ store });
    // 判断用 25 件 + 事後評価の比較対象 (それより前の 20 件。配分・信頼度の集計に影響しないよう保存だけする)
    const all = stoppedTrades(journal, 45);
    for (const t of all.slice(0, 20)) {
      store.saveTrade(t);
      store.saveAttribution(svc.attribute(t));
    }
    const trades = all.slice(20);

    for (const t of trades) svc.onTradeClosed(t);
    expect(store.listTrades()).toHaveLength(45);
    expect(store.listAttributions()).toHaveLength(45);
    // 後追いの値動きが無い段階では計画通りの損切り
    expect(store.getAttribution(trades[0].id)!.causes.map((c) => c.code)).toEqual(["good_process"]);
    expect(svc.allocator.get("s1|range|crypto")!.n).toBe(25);
    expect(svc.sourceReliability()["rss:a"]).toMatchObject({ n: 25, hits: 0 });
    expect(svc.sourceReliability()["rss:a"].weight).toBeLessThan(1);
    expect(store.listAudit({ type: "learning.trade_closed" })).toHaveLength(25);

    // 二重に呼んでも二重学習しない
    svc.onTradeClosed(trades[0]);
    expect(svc.allocator.get("s1|range|crypto")!.n).toBe(25);
    expect(svc.sourceReliability()["rss:a"].n).toBe(25);

    const now = T0 + 3 * DAY;
    const res = await svc.periodic(now);
    expect(res.postExitFilled).toBe(45);
    expect(res.reattributed).toBe(45);
    expect(store.listTrades()[0].postExitMovePct).toBeCloseTo((102.5 - 98) / 98, 12);
    expect(store.getAttribution(trades[0].id)!.causes.map((c) => c.code)).toEqual(["stop_too_tight"]);
    // stop_too_tight が検証データの基準より有意に多い → stopAtr +10% を区間検証して適用
    expect(res.adjustments).toHaveLength(1);
    expect(res.adjustments[0]).toMatchObject({ param: "stopAtr", from: 1.5, to: 1.65, status: "applied" });
    expect(validate.calls.map((p) => p.stopAtr)).toEqual([1.5, 1.65]);
    expect(svc.paramsFor("s1", "crypto")).toMatchObject({ stopAtr: 1.65, tpAtr: 2 });
    expect(svc.paramsFor("unknown", "crypto")).toBeUndefined();
    // 振り返り (ルールベース)
    expect(res.reflection?.origin).toBe("rule");
    expect(store.listLessons({ status: "active" }).length).toBeGreaterThan(0);
    expect(store.listLessons({ status: "active" }).some((l) => l.text.includes("損切りが近すぎ"))).toBe(true);

    // 間隔内の再実行では tuner・振り返りは走らない
    const again = await svc.periodic(now + 60_000);
    expect(again).toMatchObject({ postExitFilled: 0, reattributed: 0, adjustments: [], reverted: [] });
    expect(again.reflection).toBeUndefined();

    const snap = svc.snapshot({ now });
    expect(snap.arms).toHaveLength(1);
    expect(snap.arms[0]).toMatchObject({ key: "s1|range|crypto", n: 25 });
    expect(snap.lessons.length).toBeGreaterThan(0);
    expect(snap.adjustments.map((a) => a.status)).toEqual(["applied"]);
    expect(snap.sources["rss:a"].n).toBe(25);
    expect(Object.keys(snap.intelInfluence).sort()).toEqual(["crypto", "fx", "meme", "stock"]);
    expect(snap.causes.trades).toBe(45);
    expect(snap.causes.all.stop_too_tight).toBe(45);
    expect(snap.causes.outcomes.loss).toBe(45);

    const w = svc.armWeight("s1", "range", "crypto", () => 0.5);
    expect(w).toBeGreaterThanOrEqual(0.25);
    expect(w).toBeLessThan(1);
    expect(svc.armWeight("s2", "trend_up", "fx")).toBe(1);
    expect(svc.intelInfluence("crypto")).toBeGreaterThanOrEqual(0);
  });

  it("validate・priceAt なしでも動く。検証器が無ければ規則による調整はしない (基準比率も検証も無いので記録もしない)", async () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store, getStrategy: (id) => (id === "s1" ? S1 : undefined) });
    const trades = stoppedTrades(new TradeJournal(), 25).map((t) => ({ ...t, exitReason: "time" as const, exitPrice: 99.9 }));
    for (const t of trades) svc.onTradeClosed({ ...t, grossPnl: -0.1, netPnl: -0.1, returnPct: -0.001, rMultiple: -0.05 });
    const res = await svc.periodic(T0 + 2 * DAY);
    expect(res.postExitFilled).toBe(0);
    expect(res.adjustments).toEqual([]);
    expect(svc.paramsFor("s1", "crypto")!.maxHoldBars).toBe(10);
  });
});
