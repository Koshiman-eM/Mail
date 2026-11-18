import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getProfitSettings, recalcAll } from "@/lib/profit/autoService";
import { actorOf, handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async () => NextResponse.json(await getProfitSettings()));

const d = z.string().regex(/^\d+(\.\d+)?$/, "0以上の数値で入力してください");
const schema = z
  .object({
    fxBufferPercent: d,
    fxFallbackRates: z.record(z.string().regex(/^[A-Z]{3}$/), d),
    localShippingJpy: d,
    agentFeePercent: d,
    agentFixedJpy: d,
    intlRatePerKgJpy: d,
    intlMinChargeJpy: d,
    volumetricDivisor: z.union([z.literal(5000), z.literal(6000)]),
    weightStepKg: d,
    fuelSurchargePercent: d,
    defaultDutyPercent: d,
    consumptionTaxPercent: d,
    customsClearanceFeeJpy: d,
    japanCustomsRounding: z.boolean(),
    platformFeePercent: d,
    platformFixedFeePerUnitJpy: d,
    domesticShippingPerUnitJpy: d,
    otherCostsJpy: d,
    roiAlertPercent: d,
  })
  .partial();

/** 既定値を更新し、全商品を再計算する (管理者のみ) */
export const PUT = handler(async (req: Request, _ctx, user) => {
  const body = schema.parse(await req.json());
  const before = await getProfitSettings();
  const data = body as Prisma.ProfitSettingsUpdateInput;
  const after = await prisma.$transaction(async (tx) => {
    const s = await tx.profitSettings.update({ where: { id: "default" }, data });
    await tx.auditLog.create({
      data: {
        actor: actorOf(user),
        action: "profit.settings.update",
        entityType: "ProfitSettings",
        entityId: "default",
        before: JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue,
        after: body as Prisma.InputJsonValue,
      },
    });
    return s;
  });
  const recalculated = await recalcAll("settings.change");
  return NextResponse.json({ settings: after, recalculated });
}, { role: "ADMIN" });
