import { describe, expect, it } from "vitest";
import type { AssetClass, RegimeLabel, TradeRecord } from "../src/core/types";
import { armKey, randBeta, StrategyAllocator } from "../src/learning/allocator";
import { MemoryStore } from "../src/storage/memory";

let seq = 0;
function trade(r: number, over: { strategyId?: string; regime?: RegimeLabel; assetClass?: AssetClass } = {}): TradeRecord {
  const net = r * 2; // リスク額 2
  seq++;
  return {
    id: `t${seq}`,
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: over.assetClass ?? "crypto",
    strategyId: over.strategyId ?? "s1",
    horizon: "scalp",
    direction: "long",
    qty: 1,
    entryTs: seq * 1000,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs: seq * 1000 + 500,
    exitPrice: 100 + net,
    intendedExitPrice: 100 + net,
    initialStop: 98,
    grossPnl: net,
    fees: 0,
    netPnl: net,
    returnPct: net / 100,
    rMultiple: r,
    mfePct: 0.01,
    maePct: 0.01,
    exitReason: r > 0 ? "take_profit" : "stop",
    entryContext: {
      regime: { label: over.regime ?? "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.5,
      expectedEdgeBps: 30,
      costBps: 5,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "t",
    },
  };
}

/** 再現可能な乱数 (mulberry32) */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY = armKey("s1", "range", "crypto");

describe("StrategyAllocator", () => {
  it("新しい腕は 1.0、キーは 戦略|レジーム|資産クラス", () => {
    const a = new StrategyAllocator(new MemoryStore());
    expect(KEY).toBe("s1|range|crypto");
    expect(a.weight(KEY)).toBe(1);
    expect(a.isDisabled(KEY)).toBe(false);
    expect(a.explorationWeight(KEY, () => 0.99)).toBe(1);
    expect(a.snapshot()).toEqual([]);
  });

  it("成績良好なら増 (上限 1.5)、悪ければ減。状態は kv に保存され再構築後も同じ", () => {
    const store = new MemoryStore();
    const a = new StrategyAllocator(store);
    for (let i = 0; i < 20; i++) a.update(trade(i % 4 === 3 ? -1 : 1.5));
    const w = a.weight(KEY);
    expect(w).toBeGreaterThan(1.2);
    expect(w).toBeLessThanOrEqual(1.5);
    const st = a.get(KEY)!;
    expect(st.n).toBe(20);
    expect(st.alpha).toBeGreaterThan(st.beta);
    expect(st.sumR).toBeCloseTo(15 * 1.5 - 5, 10);
    expect(store.kvGet(`arm:${KEY}`)).toMatchObject({ key: KEY, n: 20 });

    const b = new StrategyAllocator(store);
    expect(b.weight(KEY)).toBe(w);

    // 別の腕 (レジーム違い) は独立
    const bad = armKey("s1", "trend_up", "crypto");
    for (let i = 0; i < 10; i++) b.update(trade(i % 3 === 0 ? 0.5 : -1, { regime: "trend_up" }));
    expect(b.weight(bad)).toBeLessThan(1);
    expect(b.weight(bad)).toBeGreaterThanOrEqual(0.25);
    expect(b.isDisabled(bad)).toBe(false); // n < 30
    expect(b.snapshot().map((s) => s.key)).toEqual([KEY, bad]);
    expect(b.snapshot()[0]).toMatchObject({ n: 20, disabled: false, meanR: 0.875 });
  });

  it("n≥30 で期待 R の上側信頼限界 < 0 なら無効化。探索で一定確率だけ最小サイズを許す", () => {
    const a = new StrategyAllocator(new MemoryStore());
    for (let i = 0; i < 29; i++) a.update(trade(i % 4 === 0 ? 1 : -1));
    expect(a.isDisabled(KEY)).toBe(false);
    a.update(trade(-1));
    expect(a.get(KEY)!.n).toBe(30);
    expect(a.upperConfidenceR(KEY)).toBeLessThan(0);
    expect(a.isDisabled(KEY)).toBe(true);
    expect(a.weight(KEY)).toBe(0);
    expect(a.explorationWeight(KEY, () => 0.01)).toBe(0.25);
    expect(a.explorationWeight(KEY, () => 0.5)).toBe(0);
    expect(a.sample(KEY, () => 0.01)).toBe(0.25);
    // 乱数で約 5% が探索になる
    const rng = seeded(7);
    let explored = 0;
    for (let i = 0; i < 4000; i++) if (a.explorationWeight(KEY, rng) > 0) explored++;
    expect(explored / 4000).toBeGreaterThan(0.03);
    expect(explored / 4000).toBeLessThan(0.07);
    expect(a.snapshot()[0].disabled).toBe(true);
  });

  it("勝率と R が混在しても期待値が明確に負でなければ無効化しない", () => {
    const a = new StrategyAllocator(new MemoryStore());
    // 勝率 30%、勝ち +3R / 負け −1R (期待値 +0.2R)
    for (let i = 0; i < 40; i++) a.update(trade(i % 10 < 3 ? 3 : -1));
    expect(a.isDisabled(KEY)).toBe(false);
    expect(a.weight(KEY)).toBeGreaterThan(0.9);
  });

  it("トンプソンサンプリング: RNG 注入で再現可能・範囲内・良い腕ほど大きい", () => {
    const a = new StrategyAllocator(new MemoryStore());
    for (let i = 0; i < 25; i++) a.update(trade(1.2));
    const good = KEY;
    const fresh = armKey("s9", "range", "crypto");
    expect(a.sample(good, seeded(1))).toBe(a.sample(good, seeded(1)));
    const rng = seeded(3);
    let sg = 0;
    let sf = 0;
    for (let i = 0; i < 500; i++) {
      const g = a.sample(good, rng);
      const f = a.sample(fresh, rng);
      expect(g).toBeGreaterThanOrEqual(0.25);
      expect(g).toBeLessThanOrEqual(1.5);
      expect(f).toBeGreaterThanOrEqual(0.25);
      expect(f).toBeLessThanOrEqual(1.5);
      sg += g;
      sf += f;
    }
    expect(sg / 500).toBeGreaterThan(sf / 500);
    expect(sf / 500).toBeGreaterThan(0.85);
    expect(sf / 500).toBeLessThan(1.15);
  });

  it("randBeta の平均", () => {
    const rng = seeded(11);
    let s = 0;
    for (let i = 0; i < 3000; i++) s += randBeta(8, 2, rng);
    expect(s / 3000).toBeCloseTo(0.8, 1);
  });
});
