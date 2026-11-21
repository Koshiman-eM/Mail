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
const ETHJPY = inst("ETH/JPY", "crypto", "ETH", "JPY");
const regime = (label: RegimeLabel, over: Partial<RegimeFeatures> = {}): RegimeFeatures => ({
  label, trend: 0, trendStrength: 20, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2, ...over,
});
const strategies: PlanStrategy[] = [
  { id: "scalp_obi", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range", "trend_up", "trend_down"] },
  { id: "momo_short", horizon: "short", assetClasses: ["crypto", "meme"], regimes: ["trend_up", "trend_down", "high_vol"] },
  { id: "swing_mid", horizon: "mid", assetClasses: ["crypto"], regimes: ["trend_up"] },
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
    const meme = await plan({ instruments: [PEPE], regimes: { "PEPE/SOL": regime("high_vol") } });
    expect(meme.perSymbol["PEPE/SOL"].enabledStrategies).toEqual(["momo_short"]);
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
  it("腕が無効なため外した戦略は armDisabled に載る (AI でも再開できない)", async () => {
    const p = await plan({ armWeights: { "scalp_obi|trend_up|crypto": 0, "momo_short|trend_up|crypto": 0.9 } });
    expect(p.perSymbol["BTC/USDT"].armDisabled).toEqual(["scalp_obi"]);
    const none = await plan();
    expect(none.perSymbol["BTC/USDT"].armDisabled).toBeUndefined();
    const merged = mergeAiPlan(p, { rationale: "", adjustments: [{ symbol: "BTC/USDT", enabledStrategies: ["scalp_obi", "momo_short"], directionBias: "both", riskMultiplier: 1, notes: "" }], extraBlackouts: [] }, [BTC], NOW);
    expect(merged.perSymbol["BTC/USDT"].enabledStrategies).toEqual(["momo_short"]);
    expect(merged.perSymbol["BTC/USDT"].armDisabled).toEqual(["scalp_obi"]);
  });
  it("片側バイアスは情報の効き具合 (intelInfluence) で補正したバイアスで決める", async () => {
    const dir = async (influence?: number) =>
      (await plan({ brief: brief([bias("BTC", 0.6, 0.7)]), ...(influence !== undefined ? { intelInfluence: { crypto: influence } } : {}) })).perSymbol["BTC/USDT"].directionBias;
    expect(await dir()).toBe("long");
    expect(await dir(1)).toBe("long");
    // 情報が逆効果だと学習した (0.5): sentiment 0.3・信頼度 0.35 になり片側化しない
    expect(await dir(0.5)).toBe("both");
    expect(await dir(0)).toBe("both");
    // 別の資産クラスの効き具合は影響しない
    expect((await plan({ brief: brief([bias("BTC", 0.6, 0.7)]), intelInfluence: { meme: 0 } })).perSymbol["BTC/USDT"].directionBias).toBe("long");
    // 効いている (1.5) なら弱いバイアスでも片側化しうる
    expect((await plan({ brief: brief([bias("BTC", 0.3, 0.4)]) })).perSymbol["BTC/USDT"].directionBias).toBe("both");
    expect((await plan({ brief: brief([bias("BTC", 0.3, 0.4)]), intelInfluence: { crypto: 1.5 } })).perSymbol["BTC/USDT"].directionBias).toBe("long");
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
  it("向きは基準通貨 (個別) のバイアスで決める。クオート通貨 (JPY) のバイアスは向きに使わない", async () => {
    const dir = async (biases: IntelBias[]) =>
      (await plan({ instruments: [ETHJPY], regimes: { "ETH/JPY": regime("trend_up") }, brief: brief(biases) })).perSymbol["ETH/JPY"].directionBias;
    expect(await dir([bias("ETH", -0.6, 0.8), bias("JPY", 0.9, 0.9)])).toBe("short");
    expect(await dir([bias("JPY", 0.9, 0.9)])).toBe("both");
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
  it("経済指標から資産クラスのブラックアウトは作らない (FX・株式向けは廃止)。validUntil", async () => {
    const ts = NOW + 45 * 60_000;
    const p = await plan({
      brief: brief([], { events: [
        { ts, title: "NFP", currency: "USD", impact: "high", source: "x" },
        { ts, title: "minor", currency: "USD", impact: "low", source: "x" },
        { ts: NOW + 48 * 3_600_000, title: "far", currency: "EUR", impact: "high", source: "x" },
      ] }),
    });
    expect(p.blackouts).toEqual([]);
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
    const built = await plan({
      instruments: [BTC, ETHJPY],
      regimes: { "BTC/USDT": regime("trend_up"), "ETH/JPY": regime("low_liquidity") },
    });
    // 既存のブラックアウト (前の AI の追加分など) は削除できない
    const base = { ...built, blackouts: [{ start: NOW, end: NOW + 600_000, assetClasses: ["meme" as const], reason: "AI: 既存" }] };
    const merged = mergeAiPlan(base, {
      rationale: "調整",
      adjustments: [
        { symbol: "BTC/USDT", enabledStrategies: ["scalp_obi", "hacker"], directionBias: "long", riskMultiplier: 9, notes: "x" },
        { symbol: "ETH/JPY", enabledStrategies: ["momo_short"], directionBias: "both", riskMultiplier: 1.5, notes: "" },
        { symbol: "UNKNOWN", enabledStrategies: [], directionBias: "both", riskMultiplier: 1, notes: "" },
      ],
      extraBlackouts: [{ start: NOW, end: NOW + 3_600_000, assetClasses: ["crypto"], reason: "追加" }, { start: NOW + 5, end: NOW, assetClasses: ["meme"], reason: "bad" }],
    }, [BTC, ETHJPY], NOW);
    expect(merged.perSymbol["BTC/USDT"].enabledStrategies).toEqual(["scalp_obi"]);
    expect(merged.perSymbol["BTC/USDT"].riskMultiplier).toBe(1.5);
    expect(merged.perSymbol["ETH/JPY"].enabledStrategies).toEqual([]);
    expect(merged.perSymbol["ETH/JPY"].riskMultiplier).toBe(0);
    expect(merged.perSymbol.UNKNOWN).toBeUndefined();
    expect(merged.blackouts).toHaveLength(base.blackouts.length + 1);
    expect(merged.blackouts[0]).toEqual(base.blackouts[0]);
    expect(merged.rationale).toBe("調整");
  });
});
