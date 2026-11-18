import type { Prisma, ProfitSettings } from "@prisma/client";
import { prisma } from "../db/prisma";
import { getJpyRate } from "../fx";
import { notify } from "../notifications/service";
import { calculateProfit } from "./engine";
import { buildAutoInput, detectProfitAlerts, type AutoSettings } from "./auto";
import type { PriceTier } from "./types";

/** キーを並べ替えて文字列化 (undefined のキーは JSON 同様に除外) */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export type AutoTrigger = "product.create" | "product.update" | "price.change" | "fx.refresh" | "settings.change" | "manual";

export async function getProfitSettings(): Promise<ProfitSettings> {
  return prisma.profitSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

export function toAutoSettings(s: ProfitSettings): AutoSettings {
  const str = (d: { toString(): string }) => d.toString();
  return {
    fxBufferPercent: str(s.fxBufferPercent),
    localShippingJpy: str(s.localShippingJpy),
    agentFeePercent: str(s.agentFeePercent),
    agentFixedJpy: str(s.agentFixedJpy),
    intlRatePerKgJpy: str(s.intlRatePerKgJpy),
    intlMinChargeJpy: str(s.intlMinChargeJpy),
    volumetricDivisor: s.volumetricDivisor,
    weightStepKg: str(s.weightStepKg),
    fuelSurchargePercent: str(s.fuelSurchargePercent),
    defaultDutyPercent: str(s.defaultDutyPercent),
    consumptionTaxPercent: str(s.consumptionTaxPercent),
    customsClearanceFeeJpy: str(s.customsClearanceFeeJpy),
    japanCustomsRounding: s.japanCustomsRounding,
    platformFeePercent: str(s.platformFeePercent),
    platformFixedFeePerUnitJpy: str(s.platformFixedFeePerUnitJpy),
    domesticShippingPerUnitJpy: str(s.domesticShippingPerUnitJpy),
    otherCostsJpy: str(s.otherCostsJpy),
  };
}

/** 最新レート → 失敗時はキャッシュ → それも無ければ設定の予備レート */
export async function resolveFxRate(currency: string, settings: ProfitSettings): Promise<{ rate: string; source: string } | null> {
  try {
    const r = await getJpyRate(currency);
    return { rate: r.rate.toString(), source: r.stale ? `${r.source} (キャッシュ)` : r.source };
  } catch {
    const fallback = (settings.fxFallbackRates as Record<string, string> | null)?.[currency.toUpperCase()];
    return fallback ? { rate: String(fallback), source: "予備レート (設定値)" } : null;
  }
}

export interface AutoResult {
  status: "OK" | "SKIPPED" | "ERROR" | "UNCHANGED";
  note: string | null;
}

/**
 * 1商品の利益を既定値で自動計算し、ProfitSimulation (auto=true) として保存する。
 * 入力も結果も前回の自動計算と同じなら保存しない (定期再計算で履歴が膨らまないように)。
 */
export async function autoSimulate(productId: string, trigger: AutoTrigger, settingsArg?: ProfitSettings, fxCache?: Map<string, { rate: string; source: string } | null>): Promise<AutoResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { status: "ERROR", note: "商品が見つかりません" };
  const settings = settingsArg ?? (await getProfitSettings());

  const save = (status: AutoResult["status"], note: string | null) =>
    prisma.product.update({ where: { id: productId }, data: { autoCalcStatus: status === "UNCHANGED" ? "OK" : status, autoCalcNote: note, autoCalcAt: new Date() } });

  try {
    let fx = fxCache?.get(product.currency);
    if (fx === undefined) {
      fx = await resolveFxRate(product.currency, settings);
      fxCache?.set(product.currency, fx);
    }
    const built = buildAutoInput(
      {
        currency: product.currency,
        moq: product.moq,
        priceTiers: product.priceTiers as unknown as PriceTier[],
        targetQuantity: product.targetQuantity,
        dutyPercent: product.dutyPercent?.toString() ?? null,
        weightKg: product.weightKg?.toString() ?? null,
        lengthCm: product.lengthCm?.toString() ?? null,
        widthCm: product.widthCm?.toString() ?? null,
        heightCm: product.heightCm?.toString() ?? null,
        domesticPriceJpy: product.domesticPriceJpy?.toString() ?? null,
      },
      toAutoSettings(settings),
      fx?.rate ?? "",
    );
    if (!built.ok) {
      const note = `不足: ${built.missing.join("・")}`;
      await save("SKIPPED", note);
      return { status: "SKIPPED", note };
    }

    const r = calculateProfit(built.input);
    const prev = await prisma.profitSimulation.findFirst({ where: { productId, auto: true }, orderBy: { createdAt: "desc" } });
    // jsonb はキー順を保持しないため、キー順に依存しない比較を行う
    const sameInput = prev && stableStringify(prev.params) === stableStringify(built.input);
    const fxNote = fx?.source ? `為替: ${fx.source}` : null;
    if (sameInput && prev.profitJpy.toString() === r.profitJpy) {
      await save("UNCHANGED", fxNote);
      return { status: "UNCHANGED", note: fxNote };
    }

    await prisma.profitSimulation.create({
      data: {
        productId,
        auto: true,
        trigger,
        quantity: r.quantity,
        params: built.input as unknown as Prisma.InputJsonValue,
        breakdown: { ...r.breakdown, weight: r.weight, appliedTier: r.appliedTier, fxSource: fx?.source ?? null } as unknown as Prisma.InputJsonValue,
        totalCostJpy: r.totalCostJpy,
        revenueJpy: r.revenueJpy,
        profitJpy: r.profitJpy,
        unitProfitJpy: r.unitProfitJpy,
        roiPercent: r.roiPercent,
        marginPercent: r.marginPercent,
        fxRateApplied: r.fxRateApplied,
      },
    });
    await save("OK", fxNote);

    const alerts = detectProfitAlerts(
      prev ? { roiPercent: prev.roiPercent.toString(), profitJpy: prev.profitJpy.toString() } : null,
      { roiPercent: r.roiPercent, profitJpy: r.profitJpy },
      settings.roiAlertPercent.toString(),
      product.titleJa ?? product.title,
    );
    for (const a of alerts) {
      await notify({ type: "PRICE_CHANGE", severity: a.severity, title: a.title, body: a.body, link: `/products?id=${productId}`, meta: { trigger } });
    }
    return { status: "OK", note: fxNote };
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    await save("ERROR", note).catch(() => {});
    return { status: "ERROR", note };
  }
}

/** 全商品を再計算 (設定変更・定期実行・手動) */
export async function recalcAll(trigger: AutoTrigger) {
  const settings = await getProfitSettings();
  const fxCache = new Map<string, { rate: string; source: string } | null>();
  const products = await prisma.product.findMany({ select: { id: true } });
  const counts = { OK: 0, UNCHANGED: 0, SKIPPED: 0, ERROR: 0 };
  for (const p of products) {
    const r = await autoSimulate(p.id, trigger, settings, fxCache);
    counts[r.status]++;
  }
  return { total: products.length, ...counts };
}
