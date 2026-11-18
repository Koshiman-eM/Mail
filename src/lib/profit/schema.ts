import { z } from "zod";

/** 金額は文字列または数値で受け付け、Decimal へそのまま渡す (number→string 変換で誤差を持ち込まない) */
const money = z.union([z.string().regex(/^-?\d+(\.\d+)?$/, "数値形式ではありません"), z.number().finite()]);
const nonNeg = money.refine((v) => Number(v) >= 0, "0以上を指定してください");
const dims = z.object({ length: nonNeg, width: nonNeg, height: nonNeg });

export const priceTierSchema = z.object({
  minQty: z.number().int().positive(),
  unitPrice: z.string().regex(/^\d+(\.\d+)?$/),
});

export const profitInputSchema = z.object({
  quantity: z.number().int().positive(),
  moq: z.number().int().positive(),
  priceTiers: z.array(priceTierSchema).min(1),
  currency: z.string().length(3),
  fx: z.object({ rate: nonNeg, bufferPercent: nonNeg }),
  localShippingForeign: nonNeg.optional(),
  localShippingJpy: nonNeg.optional(),
  agentFee: z.object({ percent: nonNeg.optional(), fixedJpy: nonNeg.optional() }).optional(),
  package: z.object({
    unitWeightKg: nonNeg,
    unitDimensionsCm: dims,
    shipmentDimensionsCm: dims.optional(),
    shipmentWeightKg: nonNeg.optional(),
  }),
  international: z.object({
    ratePerKgJpy: nonNeg,
    minChargeJpy: nonNeg.optional(),
    volumetricDivisor: z.union([z.literal(5000), z.literal(6000)]),
    weightStepKg: nonNeg.optional(),
    fuelSurchargePercent: nonNeg.optional(),
  }),
  importCosts: z.object({
    customsDutyPercent: nonNeg,
    importConsumptionTaxPercent: nonNeg.optional(),
    customsClearanceFeeJpy: nonNeg.optional(),
    japanCustomsRounding: z.boolean().optional(),
  }),
  domestic: z.object({
    sellingPriceJpy: nonNeg,
    platformFeePercent: nonNeg,
    platformFixedFeePerUnitJpy: nonNeg.optional(),
    shippingPerUnitJpy: nonNeg.optional(),
  }),
  otherCostsJpy: nonNeg.optional(),
});
