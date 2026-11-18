import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const supplierId = new URL(req.url).searchParams.get("supplierId");
  if (!supplierId) return NextResponse.json({ error: "supplierId は必須です" }, { status: 400 });
  const goal = await prisma.negotiationGoal.findFirst({ where: { supplierId, active: true }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json(goal);
});

const goalSchema = z.object({
  supplierId: z.string().min(1),
  productId: z.string().nullable().optional(),
  targetUnitPrice: z.string().regex(/^\d+(\.\d+)?$/).nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  targetMoq: z.number().int().positive().nullable().optional(),
  wantsOem: z.boolean().default(false),
  notes: z.string().max(2000).nullable().optional(),
});

/** 交渉ゴールを設定 (既存のアクティブなゴールは無効化) */
export const PUT = handler(async (req: Request) => {
  const g = goalSchema.parse(await req.json());
  const goal = await prisma.$transaction(async (tx) => {
    await tx.negotiationGoal.updateMany({ where: { supplierId: g.supplierId, active: true }, data: { active: false } });
    return tx.negotiationGoal.create({ data: { ...g, active: true } });
  });
  return NextResponse.json(goal);
});
