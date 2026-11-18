import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { calculateProfit, profitInputSchema } from "@/lib/profit";
import { NotFoundError } from "@/lib/chat/service";
import { handler } from "../../../_lib/http";

/** 計算パラメータと結果を ProfitSimulation として保存 */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new NotFoundError(`Product(${id})`);
  const input = profitInputSchema.parse(await req.json());
  const r = calculateProfit(input);
  const sim = await prisma.profitSimulation.create({
    data: {
      productId: id,
      quantity: r.quantity,
      params: input as unknown as Prisma.InputJsonValue,
      breakdown: { ...r.breakdown, weight: r.weight, appliedTier: r.appliedTier } as unknown as Prisma.InputJsonValue,
      totalCostJpy: r.totalCostJpy,
      revenueJpy: r.revenueJpy,
      profitJpy: r.profitJpy,
      unitProfitJpy: r.unitProfitJpy,
      roiPercent: r.roiPercent,
      marginPercent: r.marginPercent,
      fxRateApplied: r.fxRateApplied,
    },
  });
  return NextResponse.json({ simulation: sim, result: r }, { status: 201 });
});
