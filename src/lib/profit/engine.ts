import { D, ZERO, ceilTo, floorTo, pct, yen, type Dec, type DecInput } from "../decimal";
import type {
  DimensionsCm,
  PackageParams,
  PriceTier,
  ProfitInput,
  ProfitResult,
  WeightResult,
  InternationalShippingParams,
} from "./types";

export class MoqNotMetError extends Error {
  constructor(public readonly quantity: number, public readonly moq: number) {
    super(`発注数量 ${quantity} が MOQ ${moq} を下回っています`);
    this.name = "MoqNotMetError";
  }
}

export class InvalidProfitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProfitInputError";
  }
}

const dec = (v: DecInput | undefined, fallback: DecInput = 0): Dec => new D(v ?? fallback);

/**
 * 数量に応じた段階単価を選択する。
 * minQty <= quantity を満たす中で minQty が最大の段階を適用。
 */
export function selectPriceTier(tiers: PriceTier[], quantity: number): PriceTier {
  if (tiers.length === 0) throw new InvalidProfitInputError("価格段階 (priceTiers) が空です");
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let applied: PriceTier | undefined;
  for (const t of sorted) {
    if (t.minQty <= quantity) applied = t;
  }
  if (!applied) {
    throw new MoqNotMetError(quantity, sorted[0].minQty);
  }
  return applied;
}

/** 為替バッファを上乗せした円換算レート */
export function effectiveFxRate(currency: string, rate: DecInput, bufferPercent: DecInput): Dec {
  if (currency.toUpperCase() === "JPY") return new D(1);
  const r = new D(rate);
  if (r.lte(0)) throw new InvalidProfitInputError("為替レートは正の値である必要があります");
  return r.mul(new D(1).add(pct(bufferPercent)));
}

/** 容積重量 (kg) = 縦 × 横 × 高さ (cm) / 除数 */
export function volumetricWeightKg(dims: DimensionsCm, divisor: 5000 | 6000): Dec {
  return new D(dims.length).mul(dims.width).mul(dims.height).div(divisor);
}

/** 実重量と容積重量の大きい方を課金重量とする */
export function chargeableWeight(
  pkg: PackageParams,
  quantity: number,
  intl: Pick<InternationalShippingParams, "volumetricDivisor" | "weightStepKg">,
): WeightResult {
  const actual = pkg.shipmentWeightKg !== undefined
    ? new D(pkg.shipmentWeightKg)
    : new D(pkg.unitWeightKg).mul(quantity);
  const volumetric = pkg.shipmentDimensionsCm
    ? volumetricWeightKg(pkg.shipmentDimensionsCm, intl.volumetricDivisor)
    : volumetricWeightKg(pkg.unitDimensionsCm, intl.volumetricDivisor).mul(quantity);
  const basis = volumetric.gt(actual) ? "volumetric" : "actual";
  const raw = D.max(actual, volumetric);
  const chargeable = ceilTo(raw, dec(intl.weightStepKg, "0.5"));
  return {
    actualKg: actual.toFixed(3),
    volumetricKg: volumetric.toFixed(3),
    chargeableKg: chargeable.toFixed(3),
    basis,
  };
}

export function internationalShippingJpy(chargeableKg: DecInput, intl: InternationalShippingParams): Dec {
  const base = new D(chargeableKg).mul(intl.ratePerKgJpy);
  const withMin = D.max(base, dec(intl.minChargeJpy));
  return withMin.mul(new D(1).add(pct(dec(intl.fuelSurchargePercent))));
}

/**
 * 越境せどり利益計算。
 * 全ての金額は decimal.js で計算し、費目ごとに円単位へ丸めてから合算する
 * (表示上の内訳合計と総額が必ず一致するように)。
 */
export function calculateProfit(input: ProfitInput): ProfitResult {
  const { quantity } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidProfitInputError("数量は正の整数である必要があります");
  }
  if (quantity < input.moq) throw new MoqNotMetError(quantity, input.moq);

  const tier = selectPriceTier(input.priceTiers, quantity);
  const fxRate = effectiveFxRate(input.currency, input.fx.rate, input.fx.bufferPercent);
  const toJpy = (foreign: DecInput) => new D(foreign).mul(fxRate);

  // --- 仕入 ---
  const goods = yen(toJpy(new D(tier.unitPrice).mul(quantity)));
  const localShipping = yen(toJpy(dec(input.localShippingForeign)).add(dec(input.localShippingJpy)));
  const agentFee = yen(
    goods.mul(pct(dec(input.agentFee?.percent))).add(dec(input.agentFee?.fixedJpy)),
  );

  // --- 国際送料 ---
  const weight = chargeableWeight(input.package, quantity, input.international);
  const intlShipping = yen(internationalShippingJpy(weight.chargeableKg, input.international));

  // --- 輸入諸税 (CIF 課税) ---
  const ic = input.importCosts;
  const japanRounding = ic.japanCustomsRounding ?? true;
  const cif = goods.add(localShipping).add(intlShipping);
  const dutyBase = japanRounding ? floorTo(cif, 1000) : cif;
  const dutyRaw = dutyBase.mul(pct(ic.customsDutyPercent));
  const duty = japanRounding ? floorTo(dutyRaw, 100) : yen(dutyRaw);
  const taxBaseRaw = cif.add(duty);
  const taxBase = japanRounding ? floorTo(taxBaseRaw, 1000) : taxBaseRaw;
  const taxRaw = taxBase.mul(pct(dec(ic.importConsumptionTaxPercent, 10)));
  const consumptionTax = japanRounding ? floorTo(taxRaw, 100) : yen(taxRaw);
  const clearance = yen(dec(ic.customsClearanceFeeJpy));

  const other = yen(dec(input.otherCostsJpy));

  const landed = goods
    .add(localShipping)
    .add(agentFee)
    .add(intlShipping)
    .add(duty)
    .add(consumptionTax)
    .add(clearance)
    .add(other);

  // --- 国内販売 ---
  const ds = input.domestic;
  const revenue = yen(new D(ds.sellingPriceJpy).mul(quantity));
  const feeRate = pct(ds.platformFeePercent);
  const fixedFeePerUnit = dec(ds.platformFixedFeePerUnitJpy);
  const shipPerUnit = dec(ds.shippingPerUnitJpy);
  const platformFees = yen(revenue.mul(feeRate).add(fixedFeePerUnit.mul(quantity)));
  const domesticShipping = yen(shipPerUnit.mul(quantity));

  const totalCost = landed.add(platformFees).add(domesticShipping);
  const profit = revenue.sub(totalCost);

  const roi = totalCost.isZero() ? ZERO : profit.div(totalCost).mul(100);
  const margin = revenue.isZero() ? ZERO : profit.div(revenue).mul(100);

  // 損益分岐単価 P: q·P·(1 - fee) - q·(fixed + ship) - landed = 0
  const denom = new D(quantity).mul(new D(1).sub(feeRate));
  const breakEven = denom.lte(0)
    ? null
    : landed.add(fixedFeePerUnit.add(shipPerUnit).mul(quantity)).div(denom).ceil();

  return {
    quantity,
    appliedTier: tier,
    unitPriceForeign: new D(tier.unitPrice).toString(),
    fxRateApplied: fxRate.toFixed(6),
    weight,
    breakdown: {
      goodsJpy: goods.toFixed(0),
      localShippingJpy: localShipping.toFixed(0),
      agentFeeJpy: agentFee.toFixed(0),
      internationalShippingJpy: intlShipping.toFixed(0),
      customsValueJpy: cif.toFixed(0),
      customsDutyJpy: duty.toFixed(0),
      importConsumptionTaxJpy: consumptionTax.toFixed(0),
      customsClearanceFeeJpy: clearance.toFixed(0),
      platformFeesJpy: platformFees.toFixed(0),
      domesticShippingJpy: domesticShipping.toFixed(0),
      otherCostsJpy: other.toFixed(0),
    },
    landedCostJpy: landed.toFixed(0),
    landedUnitCostJpy: landed.div(quantity).toFixed(2),
    totalCostJpy: totalCost.toFixed(0),
    revenueJpy: revenue.toFixed(0),
    profitJpy: profit.toFixed(0),
    unitProfitJpy: profit.div(quantity).toFixed(2),
    roiPercent: roi.toFixed(2),
    marginPercent: margin.toFixed(2),
    breakEvenUnitPriceJpy: breakEven ? breakEven.toFixed(0) : "N/A",
  };
}
