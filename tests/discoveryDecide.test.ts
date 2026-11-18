import { describe, expect, it } from "vitest";
import { decideDiscovery, estimateDiscovery, planItemStatus, type Thresholds, type WatchAssumptions } from "@/lib/discovery/decide";
import { SETTINGS } from "./helpers/fakeDiscovery";


const assumptions: WatchAssumptions = { estWeightKg: "0.1", estLengthCm: null, estWidthCm: null, estHeightCm: null, targetQuantity: 100 };
const thresholds: Thresholds = { minRoiPercent: "30", minProfitJpy: null, maxMoq: null, maxUnitPriceJpy: null };

describe("試算 (既存の利益計算エンジン)", () => {
  it("数量は max(想定数量, MOQ) で段階単価を選び、円換算単価を返す", () => {
    const e = estimateDiscovery(
      { currency: "USD", moq: 50, priceTiers: [{ minQty: 50, unitPrice: "2.00" }, { minQty: 200, unitPrice: "1.50" }] },
      "1500",
      { ...assumptions, targetQuantity: 300 },
      SETTINGS,
      "150",
    );
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.quantity).toBe(300);
    expect(e.unitPriceForeign).toBe("1.5");
    // 1.50 × 150 × 1.03 = 231.75 → 232
    expect(e.unitPriceJpy).toBe("232");
    expect(e.dimsAssumed).toBe(true);
    expect(Number(e.roiPercent)).toBeGreaterThan(0);
  });

  it("MOQ が想定数量より大きければ MOQ で試算する", () => {
    const e = estimateDiscovery({ currency: "CNY", moq: 500, priceTiers: [{ minQty: 500, unitPrice: "10" }] }, "1500", { ...assumptions, targetQuantity: 10 }, SETTINGS, "21");
    expect(e.ok && e.quantity).toBe(500);
  });

  it("寸法があれば容積重量も考慮する", () => {
    const item = { currency: "USD", moq: 100, priceTiers: [{ minQty: 1, unitPrice: "1" }] };
    const light = estimateDiscovery(item, "1500", assumptions, SETTINGS, "150");
    const bulky = estimateDiscovery(item, "1500", { ...assumptions, estLengthCm: "30", estWidthCm: "20", estHeightCm: "10" }, SETTINGS, "150");
    expect(light.ok && bulky.ok).toBe(true);
    if (light.ok && bulky.ok) {
      expect(bulky.dimsAssumed).toBe(false);
      expect(Number(bulky.profitJpy)).toBeLessThan(Number(light.profitJpy));
    }
  });

  it("為替レートが無い・価格が無い場合は試算しない", () => {
    expect(estimateDiscovery({ currency: "USD", moq: 1, priceTiers: [{ minQty: 1, unitPrice: "1" }] }, "1000", assumptions, SETTINGS, null)).toMatchObject({ ok: false, note: expect.stringContaining("為替") });
    expect(estimateDiscovery({ currency: "USD", moq: 1, priceTiers: [] }, "1000", assumptions, SETTINGS, "150")).toMatchObject({ ok: false });
  });
});

describe("判定 decideDiscovery", () => {
  const okEst = { ok: true as const, quantity: 100, profitJpy: "50000", roiPercent: "45.5", unitProfitJpy: "500", unitPriceForeign: "1", unitPriceJpy: "155", fxRateApplied: "154.5", dimsAssumed: false };
  const base = { hasPrice: true, moq: 100, duplicateProductId: null, domestic: { ok: true as const }, estimate: okEst };

  it("条件を満たせば QUALIFIED", () => {
    expect(decideDiscovery(base, thresholds)).toMatchObject({ status: "QUALIFIED", note: expect.stringContaining("ROI 45.5%") });
  });
  it("ROI・利益・MOQ・単価の条件未達はすべて理由に並べる", () => {
    const r = decideDiscovery(base, { minRoiPercent: "50", minProfitJpy: "60000", maxMoq: 50, maxUnitPriceJpy: "100" });
    expect(r.status).toBe("BELOW_THRESHOLD");
    expect(r.note).toContain("ROI 45.5% < 50%");
    expect(r.note).toContain("利益 ¥50,000 < ¥60,000");
    expect(r.note).toContain("MOQ 100 > 50");
    expect(r.note).toContain("仕入単価 ¥155 > ¥100");
  });
  it("境界値は条件を満たす (以上・以下)", () => {
    expect(decideDiscovery(base, { minRoiPercent: "45.5", minProfitJpy: "50000", maxMoq: 100, maxUnitPriceJpy: "155" }).status).toBe("QUALIFIED");
  });
  it("優先順: 価格なし → 登録済み → 国内価格なし → 試算不可", () => {
    expect(decideDiscovery({ ...base, hasPrice: false, duplicateProductId: "p1" }, thresholds).status).toBe("ERROR");
    expect(decideDiscovery({ ...base, duplicateProductId: "p1", domestic: { ok: false, reason: "x" } }, thresholds).status).toBe("DUPLICATE");
    expect(decideDiscovery({ ...base, domestic: { ok: false, reason: "販売例が不足" }, estimate: null }, thresholds)).toEqual({ status: "NO_DOMESTIC_PRICE", note: "販売例が不足" });
    expect(decideDiscovery({ ...base, estimate: { ok: false, note: "為替なし" } }, thresholds)).toEqual({ status: "ERROR", note: "為替なし" });
  });
  it("寸法未設定の試算は注記する", () => {
    expect(decideDiscovery({ ...base, estimate: { ...okEst, dimsAssumed: true } }, thresholds).note).toContain("実重量のみ");
  });
});

describe("再探索時のステータス planItemStatus", () => {
  const q = { status: "QUALIFIED" as const, note: "条件を満たしています" };
  const opts = { autoAdd: true, autoAddedSoFar: 0, maxAutoAddPerRun: 2 };
  it("除外・追加済みは上書きしない (DISMISSED を復活させない)", () => {
    for (const s of ["DISMISSED", "ADDED", "AUTO_ADDED"] as const) {
      expect(planItemStatus(s, q, opts)).toMatchObject({ status: s, keepExisting: true, autoAdd: false });
    }
  });
  it("条件達成は上限まで自動追加し、超えたら QUALIFIED のまま理由を残す", () => {
    expect(planItemStatus(null, q, opts)).toMatchObject({ status: "AUTO_ADDED", autoAdd: true });
    expect(planItemStatus("BELOW_THRESHOLD", q, opts)).toMatchObject({ status: "AUTO_ADDED", autoAdd: true });
    expect(planItemStatus(null, q, { ...opts, autoAddedSoFar: 2 })).toMatchObject({ status: "QUALIFIED", autoAdd: false, note: expect.stringContaining("上限 2 件") });
    expect(planItemStatus(null, q, { ...opts, autoAdd: false })).toMatchObject({ status: "QUALIFIED", note: expect.stringContaining("オフ") });
  });
  it("それ以外は判定どおりに更新する", () => {
    expect(planItemStatus("QUALIFIED", { status: "BELOW_THRESHOLD", note: "x" }, opts)).toMatchObject({ status: "BELOW_THRESHOLD", keepExisting: false });
  });
});
