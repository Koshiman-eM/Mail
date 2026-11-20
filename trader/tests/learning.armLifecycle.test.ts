import { describe, expect, it } from "vitest";
import type { IntelBias, ShadowTradeRecord, TradeRecord } from "../src/core/types";
import { armKey } from "../src/learning/allocator";
import { observeInfluenceWeighted } from "../src/learning/influence";
import { SourceReliabilityTracker } from "../src/learning/reliability";
import { LearningService } from "../src/learning/service";
import { MemoryStore } from "../src/storage/memory";

const KEY = armKey("s1", "range", "crypto");
let seq = 0;

function trade(r: number, over: { intel?: IntelBias; direction?: "long" | "short" } = {}): TradeRecord {
  seq++;
  const dir = over.direction ?? "long";
  const net = r * 2;
  const exit = dir === "long" ? 100 + net : 100 - net;
  return {
    id: `t${seq}`, mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp",
    direction: dir, qty: 1, entryTs: seq * 1000, entryPrice: 100, intendedEntryPrice: 100, exitTs: seq * 1000 + 500, exitPrice: exit,
    intendedExitPrice: exit, initialStop: dir === "long" ? 98 : 102, grossPnl: net, fees: 0, netPnl: net, returnPct: net / 100, rMultiple: r,
    mfePct: 0.01, maePct: 0.01, exitReason: r > 0 ? "take_profit" : "stop",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      ...(over.intel ? { intel: over.intel } : {}),
      confidence: 0.5, expectedEdgeBps: 30, costBps: 5, params: {}, features: {}, riskMultiplier: 1, reason: "t",
    },
  };
}

function shadow(netR: number, over: Partial<ShadowTradeRecord> = {}): ShadowTradeRecord {
  seq++;
  return {
    id: `sh${seq}`, mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", strategyId: "s1", horizon: "scalp", regime: "range",
    direction: "short", reason: "arm_disabled", confidence: 0.5, expectedEdgeBps: 30, entryTs: seq * 1000, entryPrice: 100, entryMid: 100,
    entrySpread: 0, stopLoss: 101, maxHoldMs: 60_000, takerFeeRate: 0, slippageBps: 0, exitTs: seq * 1000 + 500, exitPrice: 100 - netR,
    exitReason: netR > 0 ? "take_profit" : "stop", grossR: netR, costR: 0, netR, mfeR: Math.max(0, netR), maeR: Math.max(0, -netR),
    ...over,
  };
}

describe("LearningService: 腕の無効化・回復の監査ログ", () => {
  it("実取引で無効化したら learning.arm_disabled、無効化中の仮想トレードで回復したら learning.arm_recovered を残す", () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store });
    for (let i = 0; i < 80 && !svc.isArmDisabled("s1", "range", "crypto"); i++) svc.onTradeClosed(trade(i % 5 === 0 ? 1 : -1));
    expect(svc.isArmDisabled("s1", "range", "crypto")).toBe(true);
    expect(svc.armPlanWeight("s1", "range", "crypto")).toBe(0);
    const dis = store.listAudit({ type: "learning.arm_disabled" });
    expect(dis).toHaveLength(1);
    expect(dis[0].data).toMatchObject({ arm: KEY, source: "trade", disableCount: 1 });
    expect((dis[0].data as { upperR: number }).upperR).toBeLessThan(0);
    // 停止中 (halted) の仮想トレードは回復にも使わない
    for (let i = 0; i < 300; i++) svc.onShadowClosed(shadow(1.5, { reason: "halted" }));
    expect(svc.isArmDisabled("s1", "range", "crypto")).toBe(true);
    for (let i = 0; i < 2000 && svc.isArmDisabled("s1", "range", "crypto"); i++) svc.onShadowClosed(shadow(1.5));
    expect(svc.isArmDisabled("s1", "range", "crypto")).toBe(false);
    const rec = store.listAudit({ type: "learning.arm_recovered" });
    expect(rec).toHaveLength(1);
    expect(rec[0].data).toMatchObject({ arm: KEY, source: "shadow", reason: "arm_disabled", realN: 0 });
    expect(svc.armPlanWeight("s1", "range", "crypto")).toBeGreaterThan(0);
    // 状態変化のない更新では監査ログを増やさない
    svc.onShadowClosed(shadow(1.5));
    expect(store.listAudit({ type: "learning.arm_recovered" })).toHaveLength(1);
  });
});

describe("情報の効き具合: direction_bias の仮想トレードの答え合わせ", () => {
  it("重み 1 なら決済済みトレードの更新 (reliability.updateInfluence) と同じ値になる", () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    const tr = new SourceReliabilityTracker(a);
    for (let i = 0; i < 25; i++) {
      const s = i % 3 === 0 ? -0.4 : 0.6;
      const r = i % 2 === 0 ? 1.2 : -0.8;
      const dir = i % 4 === 0 ? "short" : "long";
      tr.update(trade(r, { direction: dir, intel: { asset: "BTC", sentiment: s, confidence: 0.6, eventRisk: 0, sourceIds: [], sourceContrib: {} } }));
      observeInfluenceWeighted(b, "paper", tr.opts, "crypto", s * (dir === "long" ? 1 : -1), r, 1, i);
    }
    const sa = tr.influenceState("crypto")!;
    const sb = new SourceReliabilityTracker(b).influenceState("crypto")!;
    expect(sb.n).toBeCloseTo(sa.n, 10);
    expect(sb.corr).toBeCloseTo(sa.corr, 10);
    expect(sb.value).toBeCloseTo(sa.value, 10);
  });

  it("バイアスに逆らったシグナルが勝ち続けると効き具合が下がる。重みは 0.25、情報バイアスが無い・他の理由・別 mode は使わない", () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store });
    expect(svc.intelInfluence("crypto")).toBe(1);
    // 情報バイアスなし・別の理由・別 mode・停止中は更新しない
    svc.onShadowClosed(shadow(1.5, { reason: "direction_bias" }));
    svc.onShadowClosed(shadow(1.5, { reason: "lower_score" }), { intelSentiment: 0.6 });
    svc.onShadowClosed(shadow(1.5, { reason: "direction_bias", mode: "live" }), { intelSentiment: 0.6 });
    expect(store.kvGet("intelInfluence:paper:crypto")).toBeUndefined();
    // 強気 (sentiment +0.6) のため止めた売りシグナル: 勝ち (+R) と負けが混ざるが、強気が強いほど売りが勝つ
    svc.onShadowClosed(shadow(1.5, { reason: "direction_bias" }), { intelSentiment: 0.6 });
    expect(store.kvGet<{ n: number; shadowN: number }>("intelInfluence:paper:crypto")).toMatchObject({ n: 0.25, shadowN: 1 });
    for (let i = 0; i < 200; i++) {
      const s = 0.4 + (i % 5) * 0.1;
      svc.onShadowClosed(shadow(s > 0.6 ? 1.5 : -1, { reason: "direction_bias" }), { intelSentiment: s });
    }
    expect(svc.intelInfluence("crypto")).toBeLessThan(0.8);
    expect(svc.intelInfluences().crypto).toBe(svc.intelInfluence("crypto"));
    expect(svc.intelInfluences().fx).toBe(1);
    // 0 で無効にできる
    const off = new LearningService({ store: new MemoryStore(), influenceShadowWeight: 0 });
    off.onShadowClosed(shadow(1.5, { reason: "direction_bias" }), { intelSentiment: 0.6 });
    expect(off.intelInfluence("crypto")).toBe(1);
  });
});

describe("LearningService: 観測専用の仮想トレード (strategy_filter:*)", () => {
  it("保存はするが腕の shadowN は増えない", () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store });
    svc.onShadowClosed(shadow(1.5, { reason: "strategy_filter:cost", direction: "long" }));
    expect(store.listShadowTrades()).toHaveLength(1);
    expect(svc.allocator.snapshot().every((a) => (a.shadowN ?? 0) === 0)).toBe(true);
    svc.onShadowClosed(shadow(1.5, { reason: "lower_score", direction: "long" }));
    expect(svc.allocator.snapshot().some((a) => (a.shadowN ?? 0) > 0)).toBe(true);
  });
});
