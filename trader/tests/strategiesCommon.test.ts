import { describe, expect, it } from "vitest";
import type { IntelBias, Signal } from "../src/core/types";
import { ALL_STRATEGIES, applyIntelTilt, getStrategy, resolveParams, strategiesFor } from "../src/strategies";

const sig = (direction: Signal["direction"], confidence = 0.6): Signal => ({
  strategyId: "t",
  horizon: "scalp",
  symbol: "BTC/USDT",
  direction,
  confidence,
  expectedEdgeBps: 30,
  entry: { type: "market" },
  stopLoss: 99,
  takeProfit: 102,
  maxHoldMs: 60_000,
  reason: "test",
  features: {},
});

const bias = (sentiment: number, confidence = 1, extra: Partial<IntelBias> = {}): IntelBias => ({
  asset: "BTC",
  sentiment,
  confidence,
  eventRisk: 0,
  sourceIds: [],
  sourceContrib: {},
  ...extra,
});

describe("applyIntelTilt", () => {
  const NOW = 1_000_000;

  it("インテルが無ければそのまま", () => {
    expect(applyIntelTilt(sig("long"), undefined, NOW)).toEqual(sig("long"));
  });

  it("ブラックアウト中はエントリー不可、期限切れなら通す", () => {
    expect(applyIntelTilt(sig("long"), bias(0.5, 1, { blackoutUntil: NOW + 1 }), NOW)).toBeNull();
    expect(applyIntelTilt(sig("long"), bias(0.5, 1, { blackoutUntil: NOW }), NOW)).not.toBeNull();
  });

  it("エグジット (flat) はブラックアウト中でも通す", () => {
    expect(applyIntelTilt(sig("flat"), bias(-1, 1, { blackoutUntil: NOW + 1 }), NOW)?.direction).toBe("flat");
  });

  it("同方向なら少し上げ、逆方向なら下げる (edge も同率)", () => {
    const up = applyIntelTilt(sig("long"), bias(0.5), NOW)!;
    const down = applyIntelTilt(sig("long"), bias(-0.5), NOW)!;
    expect(up.confidence).toBeGreaterThan(0.6);
    expect(up.confidence).toBeLessThan(0.6 * 1.21);
    expect(down.confidence).toBeLessThan(0.6);
    expect(0.6 - down.confidence).toBeGreaterThan(up.confidence - 0.6); // 逆方向の方が強く効く
    expect(up.expectedEdgeBps / 30).toBeCloseTo(up.confidence / 0.6);
    // ショートは符号が逆
    expect(applyIntelTilt(sig("short"), bias(-0.5), NOW)!.confidence).toBeGreaterThan(0.6);
  });

  it("インテル側の confidence が低いほど影響が小さく、0〜1 にクランプ", () => {
    const weak = applyIntelTilt(sig("long"), bias(-1, 0.1), NOW)!;
    const strong = applyIntelTilt(sig("long"), bias(-1, 1), NOW)!;
    expect(weak.confidence).toBeGreaterThan(strong.confidence);
    expect(applyIntelTilt(sig("long", 0.95), bias(1), NOW)!.confidence).toBeLessThanOrEqual(1);
    expect(strong.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe("registry", () => {
  it("ID が一意で getStrategy で引ける", () => {
    const ids = ALL_STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "scalp_obi",
      "scalp_vwap_revert",
      "scalp_momentum_burst",
      "scalp_micro",
      "short_ema_trend",
      "short_rsi_revert",
      "short_breakout",
      "mid_trend_follow",
      "long_momentum",
      "meme_momentum",
    ]);
    for (const id of ids) expect(getStrategy(id)?.id).toBe(id);
    expect(getStrategy("nope")).toBeUndefined();
  });

  it("strategiesFor は資産クラス・時間軸で絞り込む", () => {
    const meme = strategiesFor("meme").map((s) => s.id);
    expect(meme).toContain("meme_momentum");
    expect(meme).not.toContain("scalp_obi");
    expect(strategiesFor("crypto", "scalp").map((s) => s.id)).toEqual(["scalp_obi", "scalp_vwap_revert", "scalp_momentum_burst", "scalp_micro"]);
    expect(strategiesFor("fx", "short").length).toBe(3);
    expect(strategiesFor("crypto").map((s) => s.id)).not.toContain("meme_momentum");
  });

  it("resolveParams は既定値に合成し範囲へクランプする", () => {
    const s = getStrategy("short_ema_trend")!;
    const p = resolveParams(s, { stopAtr: 100, tpAtr: 2.5, entryThreshold: Number.NaN });
    expect(p.stopAtr).toBe(s.paramBounds.stopAtr[1]);
    expect(p.tpAtr).toBe(2.5);
    expect(p.entryThreshold).toBe(s.defaultParams.entryThreshold);
  });
});
