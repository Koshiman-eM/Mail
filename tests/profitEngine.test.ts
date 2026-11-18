import { describe, expect, it } from "vitest";
import {
  MoqNotMetError,
  calculateProfit,
  chargeableWeight,
  effectiveFxRate,
  selectPriceTier,
  volumetricWeightKg,
  profitInputSchema,
  type ProfitInput,
} from "@/lib/profit";

const tiers = [
  { minQty: 1, unitPrice: "3.00" },
  { minQty: 100, unitPrice: "2.50" },
  { minQty: 500, unitPrice: "2.00" },
];

const base: ProfitInput = {
  quantity: 300,
  moq: 100,
  priceTiers: tiers,
  currency: "USD",
  fx: { rate: "150", bufferPercent: "2" },
  localShippingForeign: "10",
  agentFee: { percent: "5" },
  package: { unitWeightKg: "0.2", unitDimensionsCm: { length: 20, width: 10, height: 10 } },
  international: { ratePerKgJpy: "800", volumetricDivisor: 5000 },
  importCosts: { customsDutyPercent: "5", customsClearanceFeeJpy: "3000" },
  domestic: { sellingPriceJpy: "2000", platformFeePercent: "10", shippingPerUnitJpy: "200" },
};

describe("段階単価 / MOQ", () => {
  it("数量に応じた段階を選択する", () => {
    expect(selectPriceTier(tiers, 1).unitPrice).toBe("3.00");
    expect(selectPriceTier(tiers, 99).unitPrice).toBe("3.00");
    expect(selectPriceTier(tiers, 100).unitPrice).toBe("2.50");
    expect(selectPriceTier(tiers, 499).unitPrice).toBe("2.50");
    expect(selectPriceTier(tiers, 10_000).unitPrice).toBe("2.00");
  });

  it("並び順が崩れていても正しく選択する", () => {
    expect(selectPriceTier([...tiers].reverse(), 150).unitPrice).toBe("2.50");
  });

  it("MOQ 未満はエラー", () => {
    expect(() => calculateProfit({ ...base, quantity: 50 })).toThrow(MoqNotMetError);
    expect(() => selectPriceTier([{ minQty: 10, unitPrice: "1" }], 5)).toThrow(MoqNotMetError);
  });
});

describe("為替バッファ", () => {
  it("レートにバッファ率を上乗せする (浮動小数点誤差なし)", () => {
    expect(effectiveFxRate("USD", "150.1", "0.1").toString()).toBe("150.2501");
    expect(effectiveFxRate("CNY", "20.7", "3").toString()).toBe("21.321");
  });
  it("JPY は常に 1", () => {
    expect(effectiveFxRate("JPY", "999", "3").toString()).toBe("1");
  });
});

describe("容積重量", () => {
  it("縦×横×高さ / 除数", () => {
    expect(volumetricWeightKg({ length: 50, width: 40, height: 30 }, 5000).toString()).toBe("12");
    expect(volumetricWeightKg({ length: 50, width: 40, height: 30 }, 6000).toString()).toBe("10");
  });

  it("実重量と容積重量の大きい方を 0.5kg 刻みで切り上げる", () => {
    const heavy = chargeableWeight(
      { unitWeightKg: "1.3", unitDimensionsCm: { length: 10, width: 10, height: 10 } },
      1,
      { volumetricDivisor: 5000 },
    );
    expect(heavy).toMatchObject({ basis: "actual", chargeableKg: "1.500" });

    const bulky = chargeableWeight(
      { unitWeightKg: "1", unitDimensionsCm: { length: 50, width: 40, height: 30 } },
      1,
      { volumetricDivisor: 6000 },
    );
    expect(bulky).toMatchObject({ basis: "volumetric", volumetricKg: "10.000", chargeableKg: "10.000" });
  });

  it("出荷カートン寸法が指定されればそれを優先する", () => {
    const w = chargeableWeight(
      {
        unitWeightKg: "0.2",
        unitDimensionsCm: { length: 20, width: 10, height: 10 },
        shipmentDimensionsCm: { length: 60, width: 40, height: 40 },
      },
      300,
      { volumetricDivisor: 6000, weightStepKg: "1" },
    );
    // 実重量 60kg > 容積 16kg
    expect(w).toMatchObject({ basis: "actual", actualKg: "60.000", volumetricKg: "16.000", chargeableKg: "60.000" });
  });
});

describe("利益計算", () => {
  it("諸経費を合算した利益・ROI を算出する", () => {
    const r = calculateProfit(base);
    expect(r.appliedTier.unitPrice).toBe("2.50");
    expect(r.fxRateApplied).toBe("153.000000");
    expect(r.weight).toMatchObject({ basis: "volumetric", chargeableKg: "120.000" });
    expect(r.breakdown).toEqual({
      goodsJpy: "114750", // 300 × 2.50 × 153
      localShippingJpy: "1530",
      agentFeeJpy: "5738", // 5737.5 → 四捨五入
      internationalShippingJpy: "96000", // 120kg × 800
      customsValueJpy: "212280",
      customsDutyJpy: "10600", // 212,000 × 5%
      importConsumptionTaxJpy: "22200", // (212,280 + 10,600 → 222,000) × 10%
      customsClearanceFeeJpy: "3000",
      platformFeesJpy: "60000",
      domesticShippingJpy: "60000",
      otherCostsJpy: "0",
    });
    expect(r.landedCostJpy).toBe("253818");
    expect(r.totalCostJpy).toBe("373818");
    expect(r.revenueJpy).toBe("600000");
    expect(r.profitJpy).toBe("226182");
    expect(r.unitProfitJpy).toBe("753.94");
    expect(r.roiPercent).toBe("60.51");
    expect(r.marginPercent).toBe("37.70");
    expect(r.breakEvenUnitPriceJpy).toBe("1163"); // (253818 + 60000) / (300 × 0.9)
  });

  it("内訳の合計と総コストが一致する", () => {
    const r = calculateProfit({ ...base, quantity: 777, fx: { rate: "149.873", bufferPercent: "2.5" } });
    const { customsValueJpy: _cif, ...items } = r.breakdown;
    const sum = Object.values(items).reduce((a, b) => a + BigInt(b), 0n);
    expect(sum.toString()).toBe(r.totalCostJpy);
    expect(BigInt(r.revenueJpy) - BigInt(r.totalCostJpy)).toBe(BigInt(r.profitJpy));
  });

  it("損益分岐単価で販売すると利益が 0 以上かつ 1円下げると赤字", () => {
    const r = calculateProfit(base);
    const be = r.breakEvenUnitPriceJpy;
    const at = calculateProfit({ ...base, domestic: { ...base.domestic, sellingPriceJpy: be } });
    const below = calculateProfit({ ...base, domestic: { ...base.domestic, sellingPriceJpy: String(Number(be) - 1) } });
    expect(Number(at.profitJpy)).toBeGreaterThanOrEqual(0);
    expect(Number(below.profitJpy)).toBeLessThan(0);
  });

  it("税関端数処理を無効化すると円単位の四捨五入になる", () => {
    const r = calculateProfit({ ...base, importCosts: { ...base.importCosts, japanCustomsRounding: false } });
    expect(r.breakdown.customsDutyJpy).toBe("10614"); // 212280 × 5%
    expect(r.breakdown.importConsumptionTaxJpy).toBe("22289"); // (212280 + 10614) × 10% = 22289.4
  });

  it("最低料金・燃油サーチャージを適用する", () => {
    const r = calculateProfit({
      ...base,
      quantity: 100,
      package: { unitWeightKg: "0.01", unitDimensionsCm: { length: 1, width: 1, height: 1 } },
      international: { ratePerKgJpy: "800", volumetricDivisor: 5000, minChargeJpy: "5000", fuelSurchargePercent: "20" },
    });
    expect(r.breakdown.internationalShippingJpy).toBe("6000");
  });

  it("入力スキーマで不正値を弾く", () => {
    expect(profitInputSchema.safeParse(base).success).toBe(true);
    expect(profitInputSchema.safeParse({ ...base, quantity: -1 }).success).toBe(false);
    expect(profitInputSchema.safeParse({ ...base, fx: { rate: "abc", bufferPercent: "2" } }).success).toBe(false);
  });
});
