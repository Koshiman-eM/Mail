import type { DecInput } from "../decimal";

export interface PriceTier {
  /** この単価が適用される最小数量 */
  minQty: number;
  /** 外貨建ての単価 (文字列推奨: "12.35") */
  unitPrice: string;
}

export interface FxParams {
  /** 1 外貨あたりの円レート (例: USD→JPY 150.12) */
  rate: DecInput;
  /** レートに上乗せするバッファ率 (%) 例: 3 */
  bufferPercent: DecInput;
}

export interface DimensionsCm {
  length: DecInput;
  width: DecInput;
  height: DecInput;
}

export interface InternationalShippingParams {
  /** 1kg あたりの国際送料 (円) */
  ratePerKgJpy: DecInput;
  /** 最低料金 (円) */
  minChargeJpy?: DecInput;
  /** 容積重量の除数 (5000 or 6000) */
  volumetricDivisor: 5000 | 6000;
  /** 課金重量の切り上げ刻み (kg) 既定 0.5 */
  weightStepKg?: DecInput;
  /** 燃油サーチャージ (%) */
  fuelSurchargePercent?: DecInput;
}

export interface PackageParams {
  /** 1個あたり実重量 (kg) */
  unitWeightKg: DecInput;
  /** 1個あたり梱包寸法 (cm) */
  unitDimensionsCm: DimensionsCm;
  /**
   * 出荷カートン単位で計算する場合の総寸法 (cm)。
   * 指定があればこちらで容積重量を算出し、unitDimensionsCm は無視する。
   */
  shipmentDimensionsCm?: DimensionsCm;
  /** 出荷総重量 (kg) を明示する場合 */
  shipmentWeightKg?: DecInput;
}

export interface ImportCostParams {
  /** 品目別関税率 (%) */
  customsDutyPercent: DecInput;
  /** 輸入消費税率 (%) 既定 10 */
  importConsumptionTaxPercent?: DecInput;
  /** 通関手数料 (円) */
  customsClearanceFeeJpy?: DecInput;
  /**
   * 日本の税関端数処理を適用するか (既定 true)
   * 課税標準: 1,000円未満切捨て / 税額: 100円未満切捨て
   */
  japanCustomsRounding?: boolean;
}

export interface AgentFeeParams {
  /** 代行手数料率 (商品代金に対する %) */
  percent?: DecInput;
  /** 代行固定手数料 (円/注文) */
  fixedJpy?: DecInput;
}

export interface DomesticSalesParams {
  /** 国内販売価格 (円/個, 税込) */
  sellingPriceJpy: DecInput;
  /** 販売手数料率 (%) 例: Amazon 10 */
  platformFeePercent: DecInput;
  /** 販売1個あたりの固定手数料 (円) */
  platformFixedFeePerUnitJpy?: DecInput;
  /** 国内配送料 (円/個) */
  shippingPerUnitJpy?: DecInput;
}

export interface ProfitInput {
  quantity: number;
  moq: number;
  priceTiers: PriceTier[];
  /** ISO 4217 (USD, CNY, ...) */
  currency: string;
  fx: FxParams;
  /** 現地国内送料 (外貨建て, 注文あたり) */
  localShippingForeign?: DecInput;
  /** 現地国内送料 (円建て, 注文あたり)。外貨建てと併用した場合は合算 */
  localShippingJpy?: DecInput;
  agentFee?: AgentFeeParams;
  package: PackageParams;
  international: InternationalShippingParams;
  importCosts: ImportCostParams;
  domestic: DomesticSalesParams;
  /** その他経費 (検品・ラベル等, 円/注文) */
  otherCostsJpy?: DecInput;
}

export interface WeightResult {
  actualKg: string;
  volumetricKg: string;
  chargeableKg: string;
  basis: "actual" | "volumetric";
}

export interface CostBreakdown {
  goodsJpy: string;
  localShippingJpy: string;
  agentFeeJpy: string;
  internationalShippingJpy: string;
  customsValueJpy: string;
  customsDutyJpy: string;
  importConsumptionTaxJpy: string;
  customsClearanceFeeJpy: string;
  platformFeesJpy: string;
  domesticShippingJpy: string;
  otherCostsJpy: string;
}

export interface ProfitResult {
  quantity: number;
  appliedTier: PriceTier;
  unitPriceForeign: string;
  fxRateApplied: string;
  weight: WeightResult;
  breakdown: CostBreakdown;
  /** 仕入原価合計 (販売手数料・国内送料を除く) */
  landedCostJpy: string;
  landedUnitCostJpy: string;
  totalCostJpy: string;
  revenueJpy: string;
  profitJpy: string;
  unitProfitJpy: string;
  /** 利益 / 総コスト */
  roiPercent: string;
  /** 利益 / 売上 */
  marginPercent: string;
  /** 損益分岐となる販売単価 (円) */
  breakEvenUnitPriceJpy: string;
}
