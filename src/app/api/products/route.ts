import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { priceTierSchema } from "@/lib/profit";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

const decStr = z.string().regex(/^\d+(\.\d+)?$/).optional();

const createSchema = z.object({
  platform: z.enum(["ALIBABA", "ALI1688", "ALIEXPRESS", "OTHER"]),
  url: z.string().url(),
  externalId: z.string().min(1),
  title: z.string().min(1),
  titleJa: z.string().optional(),
  currency: z.string().length(3),
  moq: z.number().int().positive(),
  priceTiers: z.array(priceTierSchema).min(1),
  supplier: z.object({ externalId: z.string().min(1), name: z.string().min(1), shopUrl: z.string().url().optional() }),
  domesticRefId: z.string().optional(),
  domesticPriceJpy: decStr,
  lengthCm: decStr,
  widthCm: decStr,
  heightCm: decStr,
  weightKg: decStr,
  hsCode: z.string().optional(),
});

export const GET = handler(async () => {
  const products = await prisma.product.findMany({
    include: { supplier: true, simulations: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json(products);
});

export const POST = handler(async (req: Request) => {
  const { supplier, priceTiers, ...p } = createSchema.parse(await req.json());
  const product = await prisma.$transaction(async (tx) => {
    const s = await tx.supplier.upsert({
      where: { platform_externalId: { platform: p.platform, externalId: supplier.externalId } },
      create: { platform: p.platform, ...supplier },
      update: { name: supplier.name, shopUrl: supplier.shopUrl },
    });
    return tx.product.create({
      data: { ...p, supplierId: s.id, priceTiers: priceTiers as unknown as Prisma.InputJsonValue },
    });
  });
  return NextResponse.json(product, { status: 201 });
});
