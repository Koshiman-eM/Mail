import type { DiscoveryStatus } from "@prisma/client";
import { D } from "../decimal";
import { buildAutoInput, type AutoSettings } from "../profit/auto";
import { calculateProfit } from "../profit/engine";
import type { PriceTier } from "../profit/types";

/** 探索条件の試算前提 (1 個あたり) */
export interface WatchAssumptions {
  estWeightKg: string;
  estLengthCm: string | null;
  estWidthCm: string | null;
  estHeightCm: string | null;
  targetQuantity: number;
}

export interface Thresholds {
  minRoiPercent: string;
  minProfitJpy: string | null;
  maxMoq: number | null;
  maxUnitPriceJpy: string | null;
}

export type DiscoveryEstimate =
  | {
      ok: true;
      quantity: number;
      profitJpy: string;
      roiPercent: string;
      unitProfitJpy: string;
      /** 適用段階の単価 (外貨) と、為替バッファ込みの円換算単価 */
      unitPriceForeign: string;
      unitPriceJpy: string;
      fxRateApplied: string;
      /** 寸法が未設定で実重量のみで試算したか */
      dimsAssumed: boolean;
    }
  | { ok: false; note: string };

/** 寸法未設定時に使う最小寸法 (容積重量をほぼ 0 にし、実重量で課金させる) */
const NEGLIGIBLE_CM = "1";

const positive = (v: string | null | undefined) => {
  if (v === null || v === undefined || v === "") return false;
  try {
    return new D(v).gt(0);
  } catch {
    return false;
  }
};

/**
 * 既存の利益計算エンジンで試算する (自動利益計算と同じ既定値・同じ入力組み立て)。
 * 数量は max(想定数量, MOQ, 最小段階数量) で、数量に応じた段階単価を選ぶ。
 */
export function estimateDiscovery(
  item: { currency: string; priceTiers: PriceTier[]; moq: number | null },
  domesticPriceJpy: string,
  assumptions: WatchAssumptions,
  settings: AutoSettings,
  fxRate: string | null,
): DiscoveryEstimate {
  if (!item.priceTiers.length) return { ok: false, note: "価格を読み取れませんでした" };
  if (!fxRate) return { ok: false, note: `為替レート (${item.currency}) を取得できませんでした` };
  const dimsGiven = positive(assumptions.estLengthCm) && positive(assumptions.estWidthCm) && positive(assumptions.estHeightCm);
  const built = buildAutoInput(
    {
      currency: item.currency,
      moq: item.moq && item.moq > 0 ? item.moq : 1,
      priceTiers: item.priceTiers,
      targetQuantity: assumptions.targetQuantity,
      dutyPercent: null,
      weightKg: assumptions.estWeightKg,
      lengthCm: dimsGiven ? assumptions.estLengthCm : NEGLIGIBLE_CM,
      widthCm: dimsGiven ? assumptions.estWidthCm : NEGLIGIBLE_CM,
      heightCm: dimsGiven ? assumptions.estHeightCm : NEGLIGIBLE_CM,
      domesticPriceJpy,
    },
    settings,
    fxRate,
  );
  if (!built.ok) return { ok: false, note: `試算できませんでした (不足: ${built.missing.join("・")})` };
  try {
    const r = calculateProfit(built.input);
    return {
      ok: true,
      quantity: r.quantity,
      profitJpy: r.profitJpy,
      roiPercent: r.roiPercent,
      unitProfitJpy: r.unitProfitJpy,
      unitPriceForeign: r.unitPriceForeign,
      unitPriceJpy: new D(r.unitPriceForeign).mul(r.fxRateApplied).toDecimalPlaces(0).toFixed(0),
      fxRateApplied: r.fxRateApplied,
      dimsAssumed: !dimsGiven,
    };
  } catch (e) {
    return { ok: false, note: `試算できませんでした: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type DecidedStatus = Extract<DiscoveryStatus, "QUALIFIED" | "BELOW_THRESHOLD" | "NO_DOMESTIC_PRICE" | "DUPLICATE" | "ERROR">;

export interface DecideInput {
  hasPrice: boolean;
  moq: number | null;
  /** 同じ商品が仕入れ候補に登録済みならその ID */
  duplicateProductId: string | null;
  domestic: { ok: true } | { ok: false; reason: string };
  estimate: DiscoveryEstimate | null;
}

const yenLabel = (v: string) => `¥${Number(new D(v).toDecimalPlaces(0)).toLocaleString("ja-JP")}`;

/**
 * 探索結果 1 件の判定 (純粋関数)。理由は画面に出す日本語。
 * 順序: 価格なし → 登録済み → 国内価格なし → 試算不可 → 条件 (ROI・利益・MOQ・円換算単価) の判定
 */
export function decideDiscovery(input: DecideInput, t: Thresholds): { status: DecidedStatus; note: string } {
  if (!input.hasPrice) return { status: "ERROR", note: "検索結果から価格を読み取れませんでした" };
  if (input.duplicateProductId) return { status: "DUPLICATE", note: "同じ商品が仕入れ候補に登録済みです" };
  if (!input.domestic.ok) return { status: "NO_DOMESTIC_PRICE", note: input.domestic.reason };
  const est = input.estimate;
  if (!est) return { status: "ERROR", note: "試算できませんでした" };
  if (!est.ok) return { status: "ERROR", note: est.note };

  const fails: string[] = [];
  if (new D(est.roiPercent).lt(t.minRoiPercent)) fails.push(`ROI ${est.roiPercent}% < ${new D(t.minRoiPercent).toString()}%`);
  if (t.minProfitJpy !== null && new D(est.profitJpy).lt(t.minProfitJpy)) fails.push(`利益 ${yenLabel(est.profitJpy)} < ${yenLabel(t.minProfitJpy)}`);
  if (t.maxMoq !== null && input.moq !== null && input.moq > t.maxMoq) fails.push(`MOQ ${input.moq} > ${t.maxMoq}`);
  if (t.maxUnitPriceJpy !== null && new D(est.unitPriceJpy).gt(t.maxUnitPriceJpy)) fails.push(`仕入単価 ${yenLabel(est.unitPriceJpy)} > ${yenLabel(t.maxUnitPriceJpy)}`);
  const dims = est.dimsAssumed ? " ※寸法未設定のため実重量のみで試算" : "";
  if (fails.length) return { status: "BELOW_THRESHOLD", note: `条件未達: ${fails.join("・")}${dims}` };
  return { status: "QUALIFIED", note: `条件を満たしています (ROI ${est.roiPercent}% / 利益 ${yenLabel(est.profitJpy)} / ${est.quantity} 個)${dims}` };
}

/** 利用者の判断 (除外・追加) が済んだ結果は再探索で上書きしない */
export const STICKY_STATUSES: DiscoveryStatus[] = ["DISMISSED", "ADDED", "AUTO_ADDED"];

/**
 * 既存の結果と今回の判定から、保存するステータスと自動追加するかを決める (純粋関数)。
 * - 除外・追加済みはそのまま (DISMISSED は復活させない)
 * - 条件を満たし、自動追加が有効で今回の上限内なら自動追加
 */
export function planItemStatus(
  existing: DiscoveryStatus | null,
  decided: { status: DecidedStatus; note: string },
  opts: { autoAdd: boolean; autoAddedSoFar: number; maxAutoAddPerRun: number },
): { status: DiscoveryStatus; note: string | null; autoAdd: boolean; keepExisting: boolean } {
  if (existing && STICKY_STATUSES.includes(existing)) return { status: existing, note: null, autoAdd: false, keepExisting: true };
  if (decided.status === "QUALIFIED") {
    if (!opts.autoAdd) return { status: "QUALIFIED", note: `${decided.note} (自動追加はオフ)`, autoAdd: false, keepExisting: false };
    if (opts.autoAddedSoFar >= opts.maxAutoAddPerRun) {
      return { status: "QUALIFIED", note: `${decided.note} (1 回の自動追加上限 ${opts.maxAutoAddPerRun} 件に達したため未追加)`, autoAdd: false, keepExisting: false };
    }
    return { status: "AUTO_ADDED", note: decided.note, autoAdd: true, keepExisting: false };
  }
  return { status: decided.status, note: decided.note, autoAdd: false, keepExisting: false };
}
