import { describe, expect, it } from "vitest";
import { buildStrategyPlan, mergeAiPlan, type PlanStrategy } from "../src/intel/planner";
import type { Instrument, IntelBias, MarketBrief, RegimeFeatures, RegimeLabel } from "../src/core/types";

const NOW = 1_800_000_000_000;
const inst = (symbol: string, assetClass: Instrument["assetClass"], base: string, quote: string, allowShort = true): Instrument => ({
  symbol, venue: "paper", assetClass, baseCurrency: base, quoteCurrency: quote, tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort,
});
const BTC = inst("BTC/USDT", "crypto", "BTC", "USDT");
const PEPE = inst("PEPE/SOL", "meme", "PEPE", "SOL", false);
const USDJPY = inst("USD/JPY", "fx", "USD", "JPY");
const regime = (label: RegimeLabel, over: Partial<RegimeFeatures> = {}): RegimeFeatures => ({
  label, trend: 0, trendStrength: 20, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2, ...over,
});
const strategies: PlanStrategy[] = [
  { id: "scalp_obi", horizon: "scalp", assetClasses: ["crypto", "meme", "fx"], regimes: ["range", "trend_up", "trend_down"] },
  { id: "momo_short", horizon: "short", assetClasses: ["crypto", "meme", "fx", "stock"], regimes: ["trend_up", "trend_down", "high_vol"] },
  { id: "swing_mid", horizon: "mid", assetClasses: ["crypto", "stock"], regimes: ["trend_up"] },
  { id: "trend_long", horizon: "long", assetClasses: ["crypto"], regimes: ["trend_up", "range"] },
];
const bias = (asset: string, sentiment: number, confidence: number, eventRisk = 0): IntelBias => ({ asset, sentiment, confidence, eventRisk, sourceIds: [], sourceContrib: {} });
const brief = (biases: IntelBias[] = [], over: Partial<MarketBrief> = {}): MarketBrief => ({
  generatedAt: NOW, riskOn: 0, summary: "", biases: Object.fromEntries(biases.map((b) => [b.asset, b])), watchlist: [], events: [], stub: true, ...over,
});
const plan = (over: Partial<Parameters<typeof buildStrategyPlan>[0]> = {}) =>
  buildStrategyPlan({ brief: brief(), instruments: [BTC], regimes: { "BTC/USDT": regime("trend_up") }, strategies, lessons: [], now: NOW, ...over });

describe("planner baseline", () => {
  it("レジームと資産クラスに合う戦略だけ有効化", async () => {
    const p = await plan();
    expect(p.perSymbol["BTC/USDT"].enabledStrategies.sort()).toEqual(["momo_short", "scalp_obi", "swing_mid", "trend_long"]);
    const r = await plan({ regimes: { "BTC/USDT": regime("range") } });
    expect(r.perSymbol["BTC/USDT"].enabledStrategies.sort()).toEqual(["scalp_obi", "trend_long"]);
    const fx = await plan({ instruments: [USDJPY], regimes: { "USD/JPY": regime("high_vol") } });
    expect(fx.perSymbol["USD/JPY"].enabledStrategies).toEqual(["momo_short"]);
  });
  it("low_liquidity は全停止 (riskMultiplier 0)", async () => {
    const p = await plan({ regimes: { "BTC/USDT": regime("low_liquidity") } });
    expect(p.perSymbol["BTC/USDT"].enabledStrategies).toEqual([]);
    expect(p.perSymbol["BTC/USDT"].riskMultiplier).toBe(0);
  });
  it("armWeights が 0 に近い戦略は無効化", async () => {
    const p = await plan({ armWeights: { "scalp_obi|trend_up|crypto": 0.02, "momo_short|trend_up|crypto": 0.9 } });
    const s = p.perSymbol["BTC/USDT"].enabledStrategies;
    expect(s).not.toContain("scalp_obi");
    expect(s).toContain("momo_short");
  });
  it("片側バイアスは信頼度と強さが十分な時だけ", async () => {
    const dir = async (s: number, c: number, i = BTC) =>
      (await plan({ instruments: [i], regimes: { [i.symbol]: regime("trend_up") }, brief: brief([bias(i.baseCurrency, s, c)]) })).perSymbol[i.symbol].directionBias;
    expect(await dir(0.6, 0.7)).toBe("long");
    expect(await dir(-0.6, 0.7)).toBe("short");
    expect(await dir(0.6, 0.3)).toBe("both");
    expect(await dir(0.2, 0.9)).toBe("both");
    // ショート不可銘柄の弱気は both + 倍率縮小
    const noShort = await plan({ instruments: [PEPE], regimes: { "PEPE/SOL": regime("trend_up") }, brief: brief([bias("PEPE", -0.7, 0.8)]) });
    expect(noShort.perSymbol["PEPE/SOL"].directionBias).toBe("both");
  });
  it("FX は base - quote のバイアス", async () => {
    const p = await plan({
      instruments: [USDJPY], regimes: { "USD/JPY": regime("trend_up") },
      brief: brief([bias("USD", -0.5, 0.8), bias("JPY", 0.4, 0.8)]),
    });
    expect(p.perSymbol["USD/JPY"].directionBias).toBe("short");
  });
  it("riskMultiplier は 0〜1.5 で riskOn/eventRisk/ボラ/ミームを反映", async () => {
    const m = async (b: MarketBrief, r = regime("trend_up"), i = BTC) =>
      (await plan({ instruments: [i], regimes: { [i.symbol]: r }, brief: b })).perSymbol[i.symbol].riskMultiplier;
    const base = await m(brief());
    expect(base).toBeGreaterThan(0.9);
    expect(base).toBeLessThanOrEqual(1.5);
    expect(await m(brief([], { riskOn: 1 }))).toBeGreaterThan(base);
    expect(await m(brief([], { riskOn: -1 }))).toBeLessThan(base);
    expect(await m(brief([bias("CRYPTO", 0, 0, 1)]))).toBeLessThan(base * 0.5);
    expect(await m(brief(), regime("trend_up", { volatilityPercentile: 0.95 }))).toBeLessThan(base);
    expect(await m(brief(), regime("trend_up"), PEPE)).toBeLessThan(base);
    expect(await m(brief([], { riskOn: 1 }))).toBeLessThanOrEqual(1.5);
  });
  it("mid/long のみ有効な時は倍率が控えめ", async () => {
    const onlyLong: PlanStrategy[] = [strategies[3]];
    const long = (await plan({ strategies: onlyLong })).perSymbol["BTC/USDT"].riskMultiplier;
    const scalp = (await plan({ strategies: [strategies[0]] })).perSymbol["BTC/USDT"].riskMultiplier;
    expect(long).toBeLessThan(scalp);
  });
  it("経済指標からブラックアウト、validUntil", async () => {
    const ts = NOW + 45 * 60_000;
    const p = await plan({
      brief: brief([], { events: [
        { ts, title: "NFP", currency: "USD", impact: "high", source: "x" },
        { ts, title: "minor", currency: "USD", impact: "low", source: "x" },
        { ts: NOW + 48 * 3_600_000, title: "far", currency: "EUR", impact: "high", source: "x" },
      ] }),
    });
    expect(p.blackouts).toHaveLength(1);
    expect(p.blackouts[0]).toMatchObject({ start: ts - 30 * 60_000, end: ts + 15 * 60_000, assetClasses: ["fx", "stock"] });
    expect(p.validUntil).toBeGreaterThan(NOW);
    expect(p.rationale).toMatch(/ベースライン/);
  });
  it("レジーム不明でも落ちない", async () => {
    const p = await plan({ regimes: {} });
    expect(p.perSymbol["BTC/USDT"].enabledStrategies.length).toBeGreaterThan(0);
  });
});

describe("mergeAiPlan の制約", () => {
  it("許可外戦略・倍率超過・停止銘柄の再開・ブラックアウト削除を拒否", async () => {
    const base = await plan({
      instruments: [BTC, USDJPY],
      regimes: { "BTC/USDT": regime("trend_up"), "USD/JPY": regime("low_liquidity") },
      brief: brief([], { events: [{ ts: NOW + 600_000, title: "NFP", currency: "USD", impact: "high", source: "x" }] }),
    });
    const merged = mergeAiPlan(base, {
      rationale: "調整",
      adjustments: [
        { symbol: "BTC/USDT", enabledStrategies: ["scalp_obi", "hacker"], directionBias: "long", riskMultiplier: 9, notes: "x" },
        { symbol: "USD/JPY", enabledStrategies: ["momo_short"], directionBias: "both", riskMultiplier: 1.5, notes: "" },
        { symbol: "UNKNOWN", enabledStrategies: [], directionBias: "both", riskMultiplier: 1, notes: "" },
      ],
      extraBlackouts: [{ start: NOW, end: NOW + 3_600_000, assetClasses: ["crypto"], reason: "追加" }, { start: NOW + 5, end: NOW, assetClasses: ["fx"], reason: "bad" }],
    }, [BTC, USDJPY], NOW);
    expect(merged.perSymbol["BTC/USDT"].enabledStrategies).toEqual(["scalp_obi"]);
    expect(merged.perSymbol["BTC/USDT"].riskMultiplier).toBe(1.5);
    expect(merged.perSymbol["USD/JPY"].enabledStrategies).toEqual([]);
    expect(merged.perSymbol["USD/JPY"].riskMultiplier).toBe(0);
    expect(merged.perSymbol.UNKNOWN).toBeUndefined();
    expect(merged.blackouts).toHaveLength(base.blackouts.length + 1);
    expect(merged.blackouts[0]).toEqual(base.blackouts[0]);
    expect(merged.rationale).toBe("調整");
  });
});
