import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/chat/service";
import { priceTierSchema } from "@/lib/profit";
import { autoSimulate } from "@/lib/profit/autoService";
import { actorOf, handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      supplier: true,
      snapshots: { orderBy: { capturedAt: "desc" }, take: 50 },
      simulations: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!product) throw new NotFoundError(`Product(${id})`);
  return NextResponse.json(product);
});

const dec = z.string().regex(/^\d+(\.\d+)?$/, "数値で入力してください").nullable().optional();
const patchSchema = z.object({
  title: z.string().min(1).optional(),
  titleJa: z.string().nullable().optional(),
  moq: z.number().int().positive().optional(),
  priceTiers: z.array(priceTierSchema).min(1).optional(),
  domesticPriceJpy: dec,
  lengthCm: dec,
  widthCm: dec,
  heightCm: dec,
  weightKg: dec,
  hsCode: z.string().nullable().optional(),
  targetQuantity: z.number().int().positive().nullable().optional(),
  dutyPercent: dec,
});

/** 商品情報・自動計算の上書き値を更新し、利益を再計算する */
export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  const { priceTiers, ...rest } = patchSchema.parse(await req.json());
  const data: Prisma.ProductUpdateInput = { ...rest, ...(priceTiers && { priceTiers: priceTiers as unknown as Prisma.InputJsonValue }) };
  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id }, data });
    await tx.auditLog.create({ data: { actor: actorOf(user), action: "product.update", entityType: "Product", entityId: id, after: data as Prisma.InputJsonValue } });
    return p;
  });
  const auto = await autoSimulate(id, "product.update");
  return NextResponse.json({ ...updated, auto });
});
