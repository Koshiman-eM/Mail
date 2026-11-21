import { describe, expect, it } from "vitest";
import { DEFAULT_RISK } from "../src/appConfig";
import { RiskManager, type EntryParams } from "../src/risk/manager";
import type { Instrument, RiskLimits, Signal } from "../src/core/types";
import { quoteCostBps, roundTripCostBps } from "../src/core/costs";

const NOW = Date.parse("2025-03-01T12:00:00Z");
const limits: RiskLimits = {
  ...DEFAULT_RISK, riskPerTrade: 0.05, maxPositionPct: 1, minEdgeToCostRatio: 2, maxOpenPositions: 5, maxExposureByClass: { crypto: 1, meme: 1 },
};
const inst: Instrument = {
  symbol: "BTC/USDT", venue: "margin", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001,
  minQty: 0.001, takerFeeRate: 0.0005, makerFeeRate: 0.0002, allowShort: true,
};
const other: Instrument = { ...inst, symbol: "ETH/USDT", venue: "other" };
const quote = { ts: NOW, bid: 99.99, ask: 100.01 };
const sig = (o: Partial<Signal> = {}): Signal => ({
  strategyId: "s", horizon: "short", symbol: "BTC/USDT", direction: "long", confidence: 1, expectedEdgeBps: 200,
  entry: { type: "market" }, stopLoss: 90, maxHoldMs: 1000, reason: "", features: {}, ...o,
});
const params = (o: Partial<EntryParams> = {}): EntryParams => ({
  signal: sig(), instrument: inst, quote, equity: 10_000, available: 1_000_000, positions: [], riskMultiplier: 1, now: NOW,
  instruments: { [inst.symbol]: inst, [other.symbol]: other }, ...o,
});

describe("RiskManager: venueLeverageCaps (取引先ごとの実効レバレッジの上限)", () => {
  it("既定 (指定なし) は判定しない", () => {
    const d = new RiskManager(limits).evaluateEntry(params());
    expect(d.ok && Number(d.qty)).toBeCloseTo(49.95, 6); // 10000 × 0.05 / (100.01 − 90)
  });
  it("建玉の合計が 評価額 × 上限 を超えないように縮め、達したら拒否する", () => {
    const rm = new RiskManager(limits, undefined, { mode: "paper", venueLeverageCaps: { margin: 0.2 } });
    const d = rm.evaluateEntry(params());
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(Number(d.qty)).toBeCloseTo(19.998, 3); // 2000 / 100.01
      expect(d.notes.join(" ")).toMatch(/margin の実効レバレッジ上限/);
    }
    const full = rm.evaluateEntry(params({ positions: [{ symbol: "BTC/USDT", qty: 20, avgPrice: 100 }] }));
    expect(full).toMatchObject({ ok: false, reason: expect.stringMatching(/実効レバレッジの上限/) });
  });
  it("paper ではほかの取引先の建玉を数えず、live では拒否する", () => {
    const pos = [{ symbol: "ETH/USDT", qty: 1, avgPrice: 100 }];
    expect(new RiskManager(limits, undefined, { mode: "paper", venueLeverageCaps: { margin: 0.2 } }).evaluateEntry(params({ positions: pos })).ok).toBe(true);
    expect(new RiskManager(limits, undefined, { mode: "live", venueLeverageCaps: { margin: 0.2 } }).evaluateEntry(params({ positions: pos })))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/ほかの取引先の建玉/) });
  });
  it("正でない上限は例外", () => {
    expect(() => new RiskManager(limits, undefined, { venueLeverageCaps: { margin: 0 } })).toThrow(/正の倍率/);
  });
});

describe("costs: 往復コストの唯一の定義", () => {
  it("手数料 × 2 + スプレッド + 約定ずれ × 2", () => {
    expect(roundTripCostBps(0.001, 2, 1)).toBeCloseTo(24, 9);
    expect(quoteCostBps(inst, quote)).toBeCloseTo(10 + 2, 2);
    expect(quoteCostBps({ takerFeeRate: 0.001 }, { bid: 101, ask: 100 })).toBeCloseTo(20, 9); // 負のスプレッドは 0
  });
});
