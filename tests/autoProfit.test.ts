import { describe, expect, it } from "vitest";
import { buildAutoInput, calculateProfit, detectProfitAlerts, type AutoProduct, type AutoSettings } from "@/lib/profit";

const settings: AutoSettings = {
  fxBufferPercent: "2",
  localShippingJpy: "1530",
  agentFeePercent: "5",
  agentFixedJpy: "0",
  intlRatePerKgJpy: "800",
  intlMinChargeJpy: "0",
  volumetricDivisor: 5000,
  weightStepKg: "0.5",
  fuelSurchargePercent: "0",
  defaultDutyPercent: "5",
  consumptionTaxPercent: "10",
  customsClearanceFeeJpy: "3000",
  japanCustomsRounding: true,
  platformFeePercent: "10",
  platformFixedFeePerUnitJpy: "0",
  domesticShippingPerUnitJpy: "200",
  otherCostsJpy: "0",
};

const product: AutoProduct = {
  currency: "USD",
  moq: 100,
  priceTiers: [
    { minQty: 100, unitPrice: "2.50" },
    { minQty: 500, unitPrice: "2.00" },
  ],
  targetQuantity: 300,
  dutyPercent: null,
  weightKg: "0.2",
  lengthCm: "20",
  widthCm: "10",
  heightCm: "10",
  domesticPriceJpy: "2000",
};

describe("自動利益計算の入力組み立て", () => {
  it("既定値と商品データから計算でき、手計算の例と一致する", () => {
    const r = buildAutoInput(product, settings, "150");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = calculateProfit(r.input);
    // tests/profitEngine.test.ts の手計算例と同条件 (現地送料 10 USD × 153 = 1,530 円を円建てで指定)
    expect(res.landedCostJpy).toBe("253818");
    expect(res.profitJpy).toBe("226182");
  });

  it("想定発注数量が未設定なら MOQ、MOQ 未満の指定は MOQ に引き上げ", () => {
    const a = buildAutoInput({ ...product, targetQuantity: null }, settings, "150");
    const b = buildAutoInput({ ...product, targetQuantity: 10 }, settings, "150");
    expect(a.ok && a.quantity).toBe(100);
    expect(b.ok && b.quantity).toBe(100);
  });

  it("商品の関税率は既定値より優先", () => {
    const r = buildAutoInput({ ...product, dutyPercent: "0" }, settings, "150");
    expect(r.ok && r.input.importCosts.customsDutyPercent).toBe("0");
  });

  it("不足項目があれば計算しない", () => {
    const r = buildAutoInput({ ...product, weightKg: null, heightCm: null, domesticPriceJpy: "" }, settings, "");
    expect(r).toEqual({ ok: false, missing: ["国内販売価格", "重量", "寸法 (縦・横・高さ)", "為替レート (USD)"] });
  });
});

describe("利益の変化の通知判定", () => {
  it("赤字転落は CRITICAL、継続中は再通知しない", () => {
    expect(detectProfitAlerts({ roiPercent: "10", profitJpy: "5000" }, { roiPercent: "-3", profitJpy: "-1200" }, "20", "A")[0].severity).toBe("CRITICAL");
    expect(detectProfitAlerts({ roiPercent: "-3", profitJpy: "-1200" }, { roiPercent: "-5", profitJpy: "-2000" }, "20", "A")).toEqual([]);
  });
  it("ROI が閾値を下回った時だけ WARNING", () => {
    expect(detectProfitAlerts({ roiPercent: "25", profitJpy: "9000" }, { roiPercent: "18", profitJpy: "7000" }, "20", "A")[0].severity).toBe("WARNING");
    expect(detectProfitAlerts({ roiPercent: "18", profitJpy: "7000" }, { roiPercent: "15", profitJpy: "6000" }, "20", "A")).toEqual([]);
    expect(detectProfitAlerts(null, { roiPercent: "30", profitJpy: "9000" }, "20", "A")).toEqual([]);
  });
  it("黒字回復は INFO", () => {
    expect(detectProfitAlerts({ roiPercent: "-1", profitJpy: "-100" }, { roiPercent: "25", profitJpy: "9000" }, "20", "A")[0].severity).toBe("INFO");
  });
});

describe("自動計算の重複保存防止", () => {
  it("キー順が違っても同じ入力と判定する (jsonb はキー順を保持しない)", async () => {
    const { stableStringify } = await import("@/lib/profit/autoService");
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "x" }, z: undefined })).toBe(stableStringify({ a: { c: "x", d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(stableStringify({ a: "1" })).not.toBe(stableStringify({ a: "2" }));
  });
});
