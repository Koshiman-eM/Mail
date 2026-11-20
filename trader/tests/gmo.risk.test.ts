import { describe, expect, it } from "vitest";
import { DEFAULT_RISK } from "../src/core/config";
import type { Instrument, RiskLimits, Signal } from "../src/core/types";
import { RiskManager, type EntryParams } from "../src/risk/manager";

/** RiskManager: GMO の実効レバレッジの上限 (評価額 × GMO_MAX_EFFECTIVE_LEVERAGE) */
const NOW = Date.parse("2025-03-01T12:00:00Z");
// 他の上限 (1 銘柄・資産クラス) が効かないように緩めて、実効レバレッジの判定だけを見る
const limits: RiskLimits = {
  ...DEFAULT_RISK, riskPerTrade: 0.05, maxPositionPct: 1, maxExposureByClass: { ...DEFAULT_RISK.maxExposureByClass, crypto: 1 }, minEdgeToCostRatio: 1, maxOpenPositions: 5,
};
const gmo = (symbol: string): Instrument => ({
  symbol, venue: "gmo", assetClass: "crypto", baseCurrency: symbol.split("/")[0], quoteCurrency: "JPY",
  tickSize: 1, lotSize: 0.01, minQty: 0.01, takerFeeRate: 0, makerFeeRate: 0, allowShort: true, meta: { gmoSymbol: symbol.replace("/", "_"), holdingFeeDaily: 0.0004 },
});
const BTC = gmo("BTC/JPY");
const ETH = gmo("ETH/JPY");
const PAPER_BTC: Instrument = { ...BTC, venue: "ccxt:bitbank" };
const quote = { ts: NOW, bid: 9_999, ask: 10_001 };
const sig = (o: Partial<Signal> = {}): Signal => ({
  strategyId: "s", horizon: "short", symbol: "BTC/JPY", direction: "long", confidence: 1, expectedEdgeBps: 500,
  entry: { type: "market" }, stopLoss: 9_900, maxHoldMs: 1000, reason: "", features: {}, ...o,
});
const params = (o: Partial<EntryParams> = {}): EntryParams => ({
  signal: sig(), instrument: BTC, quote, equity: 1_000_000, available: 10_000_000, positions: [], riskMultiplier: 1, now: NOW,
  instruments: new Map([[BTC.symbol, BTC], [ETH.symbol, ETH], [PAPER_BTC.symbol, PAPER_BTC]]), ...o,
});

describe("RiskManager: GMO の実効レバレッジの上限", () => {
  // 既定 (MAX_EXPOSURE_CRYPTO 0.6 など) では資産クラス別の上限の方が厳しいことが多い。ここでは資産クラス別の上限を 1 にして、
  // 実効レバレッジの上限 (0.5 倍など) が効く場面を確かめる
  it("GMO の建玉と合わせて 評価額 × 倍率 を超えない数量に制限し、余地が無ければ拒否 (日本語の理由)", () => {
    const rm = new RiskManager(limits, undefined, { mode: "live", gmoMaxEffectiveLeverage: 0.5 });
    // 既存の ETH 売り建て 300,000 円 (絶対値で数える) → 残り 200,000 円 / 10,001 = 19.998 → 19.99
    const d = rm.evaluateEntry(params({ positions: [{ symbol: "ETH/JPY", qty: -1, avgPrice: 300_000, price: 300_000 }] }));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(Number(d.qty)).toBeCloseTo(19.99, 6);
      expect(d.notes.join(" ")).toContain("GMO の実効レバレッジ上限");
    }
    const full = rm.evaluateEntry(params({ positions: [{ symbol: "ETH/JPY", qty: -2, avgPrice: 250_000, price: 250_000 }] }));
    expect(full).toMatchObject({ ok: false, reason: expect.stringContaining("実効レバレッジの上限") });
  });

  it("既定は 1 倍。GMO_MAX_EFFECTIVE_LEVERAGE で倍率を変えられる", () => {
    const pos = [{ symbol: "ETH/JPY", qty: -1, avgPrice: 600_000, price: 600_000 }];
    const def = new RiskManager(limits, undefined, { mode: "live" }).evaluateEntry(params({ positions: pos }));
    expect(def.ok && Number(def.qty)).toBeCloseTo(39.99, 6); // (1,000,000 - 600,000) / 10,001
    expect(new RiskManager(limits, undefined, { mode: "live", gmoMaxEffectiveLeverage: 0.6 }).evaluateEntry(params({ positions: pos })).ok).toBe(false);
  });

  it("GMO 以外の建玉は数えない。GMO 以外の銘柄は従来どおり (この判定を通らない)", () => {
    const rm = new RiskManager(limits, undefined, { mode: "live", gmoMaxEffectiveLeverage: 0.5 });
    const usdjpy: Instrument = { ...PAPER_BTC, symbol: "USD/JPY", venue: "oanda", assetClass: "fx", baseCurrency: "USD" };
    const inst = new Map([[BTC.symbol, BTC], [ETH.symbol, ETH], [usdjpy.symbol, usdjpy]]);
    // OANDA の建玉 900,000 円は数えない → 500,000 / 10,001 = 49.99
    const d = rm.evaluateEntry(params({ positions: [{ symbol: "USD/JPY", qty: 6000, avgPrice: 150, price: 150 }], instruments: inst }));
    expect(d.ok && Number(d.qty)).toBeCloseTo(49.99, 6);
    // ccxt の銘柄: GMO の建玉が上限を超えていても実効レバレッジの判定は無い (従来どおり)
    const nonGmo = rm.evaluateEntry(params({ instrument: PAPER_BTC, positions: [{ symbol: "ETH/JPY", qty: -2, avgPrice: 250_000, price: 250_000 }] }));
    expect(nonGmo.ok).toBe(true);
    if (nonGmo.ok) expect(nonGmo.notes.join(" ")).not.toContain("GMO");
  });

  it("live で GMO 以外の発注先があれば GMO の新規は拒否 (GMO 口座の評価額を基準にできない)。paper・GMO 以外の銘柄は従来どおり", () => {
    const live = new RiskManager(limits, undefined, { mode: "live", gmoOtherOrderVenues: ["ccxt:bitbank"] });
    expect(live.evaluateEntry(params())).toMatchObject({ ok: false, reason: expect.stringContaining("GMO 以外の発注先 (ccxt:bitbank)") });
    expect(live.evaluateEntry(params({ instrument: PAPER_BTC })).ok).toBe(true);
    expect(new RiskManager(limits, undefined, { mode: "paper", gmoOtherOrderVenues: ["ccxt:bitbank"] }).evaluateEntry(params()).ok).toBe(true);
    expect(new RiskManager(limits, undefined, { mode: "live" }).evaluateEntry(params()).ok).toBe(true);
  });

  it("取引先の分からない建玉・計算できない建玉があれば拒否 (確認できないまま通さない)", () => {
    const rm = new RiskManager(limits, undefined, { mode: "live" });
    expect(rm.evaluateEntry(params({ positions: [{ symbol: "UNKNOWN", qty: 1, avgPrice: 1 }] }))).toMatchObject({ ok: false, reason: expect.stringContaining("取引先の分からない建玉") });
    expect(rm.evaluateEntry(params({ positions: [{ symbol: "ETH/JPY", qty: NaN, avgPrice: 1 }] })).ok).toBe(false);
  });
});
