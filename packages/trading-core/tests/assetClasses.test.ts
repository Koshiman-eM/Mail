/** 資産クラスの語彙・プロファイル・アプリの選択 (fx・stock を選んだアプリの試験を含む) */
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSET_CLASS_PROFILES, ASSET_CLASSES, enabledAssetClasses, enabledProfile, profileOrDefault, resetEnabledAssetClassesForTests, setEnabledAssetClasses,
} from "../src/core/assetClasses";
import { riskSettingKeys } from "../src/core/config";
import { defaultCosts } from "../src/backtest/engine";
import { regimeOptionsFor } from "../src/regime/detect";
import { simulatedShortEligible } from "../src/core/short";
import { biasForInstrument } from "../src/intel/planner";
import { intelBiasFor } from "../src/engine/context";
import type { Instrument, IntelBias } from "../src/core/types";

afterEach(() => {
  resetEnabledAssetClassesForTests();
  setEnabledAssetClasses(["crypto", "meme"]);
});

const usdjpy: Instrument = {
  symbol: "USD/JPY", venue: "oanda", assetClass: "fx", baseCurrency: "USD", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
};
const bias = (sentiment: number, confidence: number, src: string): IntelBias => ({
  asset: "", sentiment, confidence, eventRisk: 0, sourceIds: [src], sourceContrib: { [src]: sentiment },
});

describe("資産クラスのプロファイル", () => {
  it("語彙は crypto / meme / fx / stock で、全クラスにプロファイルがある", () => {
    expect(ASSET_CLASSES).toEqual(["crypto", "meme", "fx", "stock"]);
    for (const c of ASSET_CLASSES) expect(ASSET_CLASS_PROFILES[c].label).toBeTruthy();
  });
  it("crypto・meme の値は従来の表と同じ", () => {
    expect(defaultCosts("crypto")).toEqual({ spreadBps: 2, slippageBps: 1 });
    expect(defaultCosts("meme")).toEqual({ spreadBps: 60, slippageBps: 20 });
    expect(regimeOptionsFor("meme").maxSpreadBps).toBe(150);
    // 使わないクラス (fx) は最初に選んだクラス (crypto) の値に落とす
    expect(defaultCosts("fx")).toEqual({ spreadBps: 2, slippageBps: 1 });
    expect(enabledProfile("fx")).toBeUndefined();
    expect(riskSettingKeys()).toEqual(["riskPerTrade", "maxDailyLoss", "maxDrawdown", "maxPositionPct", "maxExposureCrypto", "maxExposureMeme", "maxOpenPositions", "maxOrdersPerMinute"]);
  });
  it("1 プロセスで別の組には変えられない", () => {
    expect(() => setEnabledAssetClasses(["fx"])).toThrow(/既に/);
    expect(() => setEnabledAssetClasses(["crypto", "meme"])).not.toThrow();
  });
  it("fx・stock を選んだアプリ: プロファイルの値・ペアのバイアス・空売りの再現", () => {
    resetEnabledAssetClassesForTests();
    setEnabledAssetClasses(["fx", "stock"]);
    expect(enabledAssetClasses()).toEqual(["fx", "stock"]);
    expect(defaultCosts("fx")).toEqual({ spreadBps: 1, slippageBps: 0.5 });
    expect(regimeOptionsFor("fx").maxSpreadBps).toBe(8);
    expect(profileOrDefault("crypto")).toBe(ASSET_CLASS_PROFILES.fx);
    expect(riskSettingKeys()).toContain("maxExposureFx");
    expect(riskSettingKeys()).not.toContain("maxExposureCrypto");
    // FX は base − quote
    const b = biasForInstrument(usdjpy, { USD: bias(0.6, 0.8, "a"), JPY: bias(0.2, 0.5, "b") });
    expect(b.sentiment).toBeCloseTo(0.4, 9);
    expect(b.confidence).toBe(0.5);
    const ib = intelBiasFor(usdjpy, { USD: bias(0.6, 0.8, "a"), JPY: bias(0.2, 0.5, "b") }, 1)!;
    expect(ib.asset).toBe("USD/JPY");
    expect(ib.sourceContrib).toEqual({ a: 0.6, b: -0.2 });
    // 株式は空売りを paper で再現でき、FX は再現しない (allowShort の銘柄にする)
    expect(simulatedShortEligible({ ...usdjpy, allowShort: false })).toBe(false);
    expect(simulatedShortEligible({ ...usdjpy, assetClass: "stock", venue: "alpaca", allowShort: false })).toBe(true);
  });
});
