import { describe, expect, it } from "vitest";
import { canShort, isSimulatedShort, simulatedShortEligible, withSimulatedShort } from "../src/core/short";
import { jupiterInstrument } from "../src/market/feeds/jupiter";

const opts = { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 };

describe("Jupiter では空売りを再現しない (現物のスワップだけ)", () => {
  it("SOL (crypto) でも venue jupiter は対象外。dex の接頭辞の規則も残す", () => {
    const sol = jupiterInstrument({ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, assetClass: "crypto", source: "fixed" }, opts);
    expect(sol.assetClass).toBe("crypto");
    expect(sol.allowShort).toBe(false);
    expect(simulatedShortEligible(sol)).toBe(false);
    expect(withSimulatedShort(sol, { mode: "paper", enabled: true })).toBe(sol);
    // 付いていても paper で効かない
    expect(canShort({ ...sol, simulatedShort: true }, "paper")).toBe(false);
    expect(isSimulatedShort({ ...sol, simulatedShort: true }, "paper", "short")).toBe(false);
    expect(simulatedShortEligible({ allowShort: false, assetClass: "crypto", venue: "dex:solana" })).toBe(false);
    // ccxt の現物は従来どおり paper で再現する
    expect(simulatedShortEligible({ allowShort: false, assetClass: "crypto", venue: "ccxt:bitbank" })).toBe(true);
  });
});
