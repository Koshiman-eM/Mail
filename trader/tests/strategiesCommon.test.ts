import { describe, expect, it } from "vitest";
import type { AssetClass, Horizon, IntelBias, Signal } from "../src/core/types";
import { applyIntelTilt } from "../src/strategies/common";
import { ALL_STRATEGIES, getStrategy, resolveParams } from "../src/strategies/registry";

/** 資産クラス (と時間軸) に対応する戦略 (登録順) */
const strategiesFor = (assetClass: AssetClass, horizon?: Horizon) =>
  ALL_STRATEGIES.filter((s) => s.assetClasses.includes(assetClass) && (horizon === undefined || s.horizon === horizon));

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
      "scalp_rebound",
      "scalp_pullback",
      "short_ema_trend",
      "short_rsi_revert",
      "short_breakout",
      "pullback_5m",
      "pullback_15m",
    ]);
    // 廃止した戦略は登録しない
    for (const id of ["mid_trend_follow", "long_momentum", "meme_momentum"]) expect(getStrategy(id)).toBeUndefined();
    for (const id of ids) expect(getStrategy(id)?.id).toBe(id);
    expect(getStrategy("nope")).toBeUndefined();
  });

  it("資産クラス・時間軸の割り当て (登録順)", () => {
    // meme (WATCHLIST で明示した銘柄) に掛かるのは scalp_momentum_burst だけ (専用の戦略は廃止)
    expect(strategiesFor("meme").map((s) => s.id)).toEqual(["scalp_momentum_burst"]);
    expect(strategiesFor("crypto", "scalp").map((s) => s.id)).toEqual(["scalp_obi", "scalp_vwap_revert", "scalp_momentum_burst", "scalp_micro", "scalp_rebound", "scalp_pullback"]);
    // FX・株式の資産クラスは廃止 (古い記録の名前で引いても空)
    expect(strategiesFor("fx" as never, "short")).toEqual([]);
    expect(ALL_STRATEGIES.every((s) => s.assetClasses.every((c) => c === "crypto" || c === "meme"))).toBe(true);
    // 押し目買い・戻り売りの 5 分足・15 分足は crypto の短期だけ
    expect(strategiesFor("crypto", "short").map((s) => s.id)).toEqual(["short_ema_trend", "short_rsi_revert", "short_breakout", "pullback_5m", "pullback_15m"]);
    expect(ALL_STRATEGIES.filter((s) => s.horizon === "mid" || s.horizon === "long")).toEqual([]);
  });

  it("resolveParams は既定値に合成し範囲へクランプする", () => {
    const s = getStrategy("short_ema_trend")!;
    const p = resolveParams(s, { stopAtr: 100, tpAtr: 2.5, entryThreshold: Number.NaN });
    expect(p.stopAtr).toBe(s.paramBounds.stopAtr[1]);
    expect(p.tpAtr).toBe(2.5);
    expect(p.entryThreshold).toBe(s.defaultParams.entryThreshold);
  });
});
