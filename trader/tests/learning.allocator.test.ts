import { describe, expect, it } from "vitest";
import type { AssetClass, RegimeLabel, ShadowTradeRecord, TradeRecord } from "../src/core/types";
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

/** 腕 KEY の仮想トレード (決済済み) */
function shadowOf(netR: number): ShadowTradeRecord {
  seq++;
  return {
    id: `sh${seq}`, mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", strategyId: "s1", horizon: "scalp", regime: "range",
    direction: "long", reason: "arm_disabled", confidence: 0.5, expectedEdgeBps: 30, entryTs: seq * 1000, entryPrice: 100, entryMid: 100,
    entrySpread: 0, stopLoss: 99, maxHoldMs: 60_000, takerFeeRate: 0, slippageBps: 0, exitTs: seq * 1000 + 500, exitPrice: 100 + netR,
    exitReason: netR > 0 ? "take_profit" : "stop", grossR: netR, costR: 0, netR, mfeR: Math.max(0, netR), maeR: Math.max(0, -netR),
  } as ShadowTradeRecord;
}

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
    expect(store.kvGet(`arm:paper:${KEY}`)).toMatchObject({ key: KEY, n: 20 }); // 状態は mode 別 (既定 paper)

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

  it("無効化は実取引のみの統計で n≥30 かつ 縮小推定 + z·SE < 0 (z=2.5)。状態は保存し、探索で一定確率だけ最小サイズを許す", () => {
    const store = new MemoryStore();
    const a = new StrategyAllocator(store);
    expect(a.opts.ucbZ).toBe(2.5);
    // 勝率 25% の +1/−1 (平均 −0.5) を 30 件: 旧方式 (z=1.645・縮小なし) なら止まったが、新方式ではまだ止めない
    for (let i = 0; i < 30; i++) a.update(trade(i % 4 === 0 ? 1 : -1));
    expect(a.get(KEY)!.n).toBe(30);
    expect(a.isDisabled(KEY)).toBe(false);
    expect(a.upperConfidenceR(KEY)).toBeGreaterThan(0);
    // 負けが続いて上側信頼限界が 0 を下回った更新で無効化し、transition を返す
    let res = a.update(trade(-1));
    let k = 31;
    while (!res.transition && k < 200) {
      res = a.update(trade(-1));
      k++;
    }
    expect(res.transition).toBe("disabled");
    expect(k).toBeLessThan(60);
    expect(a.upperConfidenceR(KEY)).toBeLessThan(0);
    expect(a.isDisabled(KEY)).toBe(true);
    expect(a.weight(KEY)).toBe(0);
    // 無効化状態は保存される (都度計算ではない)。再構築しても同じ
    expect(store.kvGet(`arm:paper:${KEY}`)).toMatchObject({ disabled: true, disableCount: 1 });
    expect(new StrategyAllocator(store).isDisabled(KEY)).toBe(true);
    expect(a.recoveryR(KEY)).toBeLessThan(0);
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

  it("逐次検定の誤停止: 期待 R +0.1 (+1.5R/−1R) の腕は 300 取引中に一度でも無効化される割合が 20% 未満、−0.2 は 80% 以上が無効化", () => {
    const rate = (ev: number, runs: number, seed: number) => {
      const rng = seeded(seed);
      const p = (ev + 1) / 2.5;
      let hit = 0;
      for (let k = 0; k < runs; k++) {
        const a = new StrategyAllocator(new MemoryStore());
        for (let i = 0; i < 300; i++) {
          if (a.update(trade(rng() < p ? 1.5 : -1)).transition === "disabled") {
            hit++;
            break;
          }
        }
      }
      return hit / runs;
    };
    expect(rate(0.1, 150, 21)).toBeLessThan(0.2);
    expect(rate(-0.2, 150, 22)).toBeGreaterThanOrEqual(0.8);
  });

  it("有効な腕では仮想トレードは配分倍率にだけ効き、無効化の判定 (上側信頼限界・状態) には使わない", () => {
    const a = new StrategyAllocator(new MemoryStore());
    for (let i = 0; i < 40; i++) a.update(trade(i % 2 === 0 ? 1 : -1));
    const ucb = a.upperConfidenceR(KEY);
    const w = a.weight(KEY);
    for (let i = 0; i < 300; i++) a.updateShadow(shadowOf(-1));
    expect(a.upperConfidenceR(KEY)).toBe(ucb);
    expect(a.isDisabled(KEY)).toBe(false);
    expect(a.weight(KEY)).toBeLessThan(w);
    expect(a.get(KEY)!.realN).toBe(40);
  });

  it("回復: 無効化中は実取引 + 仮想トレード (重み付き) の推定が 0 を越えたら戻す (ヒステリシス)。戻したら実取引の統計を数え直す", () => {
    const store = new MemoryStore();
    const a = new StrategyAllocator(store);
    let res = a.update(trade(-1));
    for (let i = 0; i < 200 && !res.transition; i++) res = a.update(trade(i % 5 === 0 ? 1 : -1));
    expect(a.isDisabled(KEY)).toBe(true);
    const r0 = a.recoveryR(KEY)!;
    expect(r0).toBeLessThan(0);
    // 少しの勝ちでは戻らない (止めた時点の推定を事前値として持つ)
    for (let i = 0; i < 3; i++) expect(a.updateShadow(shadowOf(1.5)).transition).toBeUndefined();
    expect(a.isDisabled(KEY)).toBe(true);
    expect(a.recoveryR(KEY)!).toBeGreaterThan(r0);
    // 負けの仮想トレードでは戻らない
    for (let i = 0; i < 50; i++) a.updateShadow(shadowOf(-1));
    expect(a.isDisabled(KEY)).toBe(true);
    // 勝ちが続けば戻る
    let rec: ReturnType<StrategyAllocator["updateShadow"]> | undefined;
    let n = 0;
    for (; n < 2000; n++) {
      rec = a.updateShadow(shadowOf(1.5));
      if (rec.transition) break;
    }
    expect(rec!.transition).toBe("recovered");
    expect(a.isDisabled(KEY)).toBe(false);
    expect(a.weight(KEY)).toBeGreaterThan(0);
    const st = a.get(KEY)!;
    expect(st).toMatchObject({ realN: 0, disabled: false });
    expect(st.recMeanR).toBeUndefined();
    expect(st.recoveredAt).toBeDefined();
    expect(st.n).toBeGreaterThanOrEqual(30); // 累計は消さない
    // 回復直後は実取引が minSamplesToDisable 件たまるまで止めない
    for (let i = 0; i < 29; i++) a.update(trade(-1));
    expect(a.isDisabled(KEY)).toBe(false);
  });

  it("旧データ互換: 実取引のみの統計・無効化状態が無い保存値は n / sumR / sumR2 から初期化し、既存の項目は消さない", () => {
    const store = new MemoryStore();
    // 旧方式なら無効 (n=40, ewmaR<0) だった腕。累計の平均 −0.2・分散 1.21 では新方式の条件 (縮小推定 + 2.5·SE < 0) を満たさない
    const legacy = { key: KEY, alpha: 5, beta: 9, n: 40, sumR: -8, sumR2: 50, ewmaR: -0.6, ewmaVarR: 0.5, updatedAt: 1, wN: 42, shadowN: 8, shadowWins: 2, shadowSumR: -3 };
    store.kvSet(`arm:paper:${KEY}`, legacy);
    store.kvSet("arm:paper:index", [KEY]);
    const a = new StrategyAllocator(store);
    const st = a.get(KEY)!;
    expect(st.realN).toBe(40);
    expect(st.realMeanR).toBeCloseTo(-0.2, 10);
    expect(st.realVarR).toBeCloseTo(50 / 40 - 0.04, 10);
    expect(st.disabled).toBe(false);
    expect(a.isDisabled(KEY)).toBe(false);
    // 読むだけでは書き換えない
    expect(store.kvGet(`arm:paper:${KEY}`)).toEqual(legacy);
    a.update(trade(-1));
    const saved = store.kvGet<Record<string, unknown>>(`arm:paper:${KEY}`)!;
    expect(saved).toMatchObject({ n: 41, shadowN: 8, shadowWins: 2, shadowSumR: -3, realN: 41, disabled: false });
    expect(saved.wN).toBeCloseTo(43, 10);
    // 累計が明確に負なら初期化時に無効化状態になる (回復判定の事前値も作る)
    const bad = armKey("s1", "trend_up", "crypto");
    store.kvSet(`arm:paper:${bad}`, { key: bad, alpha: 2, beta: 30, n: 100, sumR: -80, sumR2: 100, ewmaR: -0.8, ewmaVarR: 0.3, updatedAt: 5 });
    const b = new StrategyAllocator(store);
    expect(b.isDisabled(bad)).toBe(true);
    expect(b.recoveryR(bad)).toBeLessThan(0);
    expect(b.get(bad)).toMatchObject({ disabledAt: 5 });
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
