import type { PriceTier, ProfitInput } from "./types";

/** 自動計算の既定パラメータ (DB の ProfitSettings を文字列化したもの) */
export interface AutoSettings {
  fxBufferPercent: string;
  localShippingJpy: string;
  agentFeePercent: string;
  agentFixedJpy: string;
  intlRatePerKgJpy: string;
  intlMinChargeJpy: string;
  volumetricDivisor: number;
  weightStepKg: string;
  fuelSurchargePercent: string;
  defaultDutyPercent: string;
  consumptionTaxPercent: string;
  customsClearanceFeeJpy: string;
  japanCustomsRounding: boolean;
  platformFeePercent: string;
  platformFixedFeePerUnitJpy: string;
  domesticShippingPerUnitJpy: string;
  otherCostsJpy: string;
}

export interface AutoProduct {
  currency: string;
  moq: number;
  priceTiers: PriceTier[];
  targetQuantity: number | null;
  dutyPercent: string | null;
  weightKg: string | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  domesticPriceJpy: string | null;
}

export type AutoInputResult = { ok: true; input: ProfitInput; quantity: number } | { ok: false; missing: string[] };

const present = (v: string | null | undefined) => v !== null && v !== undefined && v !== "" && Number(v) > 0;

/**
 * 商品データ + 既定値 + 為替レートから利益計算の入力を組み立てる。
 * 数量は商品の想定発注数量、未設定なら MOQ。関税率は商品の値、未設定なら既定値。
 * 重量・寸法・国内販売価格・単価が欠けている場合は計算せず、不足項目を返す。
 */
export function buildAutoInput(product: AutoProduct, settings: AutoSettings, fxRate: string): AutoInputResult {
  const missing: string[] = [];
  if (!product.priceTiers.length) missing.push("段階単価");
  if (!present(product.domesticPriceJpy)) missing.push("国内販売価格");
  if (!present(product.weightKg)) missing.push("重量");
  if (!present(product.lengthCm) || !present(product.widthCm) || !present(product.heightCm)) missing.push("寸法 (縦・横・高さ)");
  if (!present(fxRate)) missing.push(`為替レート (${product.currency})`);
  if (missing.length) return { ok: false, missing };

  const minTierQty = Math.min(...product.priceTiers.map((t) => t.minQty));
  const quantity = Math.max(product.targetQuantity ?? 0, product.moq, minTierQty);

  return {
    ok: true,
    quantity,
    input: {
      quantity,
      moq: product.moq,
      priceTiers: product.priceTiers,
      currency: product.currency,
      fx: { rate: fxRate, bufferPercent: settings.fxBufferPercent },
      localShippingJpy: settings.localShippingJpy,
      agentFee: { percent: settings.agentFeePercent, fixedJpy: settings.agentFixedJpy },
      package: {
        unitWeightKg: product.weightKg!,
        unitDimensionsCm: { length: product.lengthCm!, width: product.widthCm!, height: product.heightCm! },
      },
      international: {
        ratePerKgJpy: settings.intlRatePerKgJpy,
        minChargeJpy: settings.intlMinChargeJpy,
        volumetricDivisor: settings.volumetricDivisor === 6000 ? 6000 : 5000,
        weightStepKg: settings.weightStepKg,
        fuelSurchargePercent: settings.fuelSurchargePercent,
      },
      importCosts: {
        customsDutyPercent: product.dutyPercent ?? settings.defaultDutyPercent,
        importConsumptionTaxPercent: settings.consumptionTaxPercent,
        customsClearanceFeeJpy: settings.customsClearanceFeeJpy,
        japanCustomsRounding: settings.japanCustomsRounding,
      },
      domestic: {
        sellingPriceJpy: product.domesticPriceJpy!,
        platformFeePercent: settings.platformFeePercent,
        platformFixedFeePerUnitJpy: settings.platformFixedFeePerUnitJpy,
        shippingPerUnitJpy: settings.domesticShippingPerUnitJpy,
      },
      otherCostsJpy: settings.otherCostsJpy,
    },
  };
}

export interface SimSummary {
  roiPercent: string;
  profitJpy: string;
}

export interface AutoAlert {
  severity: "WARNING" | "CRITICAL" | "INFO";
  title: string;
  body: string;
}

/**
 * 前回の自動計算結果と比べ、通知すべき変化を判定する (状態が変わった時だけ通知し、毎回は鳴らさない)。
 * - 赤字に転落: CRITICAL
 * - ROI が閾値を下回った: WARNING
 * - 赤字から黒字に回復: INFO
 */
export function detectProfitAlerts(prev: SimSummary | null, next: SimSummary, roiThreshold: string, productTitle: string): AutoAlert[] {
  const alerts: AutoAlert[] = [];
  const nextProfit = Number(next.profitJpy);
  const nextRoi = Number(next.roiPercent);
  const th = Number(roiThreshold);
  const prevProfit = prev ? Number(prev.profitJpy) : null;
  const prevRoi = prev ? Number(prev.roiPercent) : null;

  if (nextProfit < 0 && (prevProfit === null || prevProfit >= 0)) {
    alerts.push({ severity: "CRITICAL", title: `${productTitle}: 赤字の見込みになりました`, body: `見込み利益 ¥${Math.round(nextProfit).toLocaleString("ja-JP")} / ROI ${next.roiPercent}%` });
  } else if (nextProfit >= 0 && nextRoi < th && (prevRoi === null || prevRoi >= th)) {
    alerts.push({ severity: "WARNING", title: `${productTitle}: ROI が ${roiThreshold}% を下回りました`, body: `ROI ${prev ? `${prev.roiPercent}% → ` : ""}${next.roiPercent}%` });
  } else if (prevProfit !== null && prevProfit < 0 && nextProfit >= 0) {
    alerts.push({ severity: "INFO", title: `${productTitle}: 黒字の見込みに戻りました`, body: `ROI ${next.roiPercent}%` });
  }
  return alerts;
}
